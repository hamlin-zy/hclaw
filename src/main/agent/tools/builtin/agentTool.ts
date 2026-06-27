/**
 * agent 内置工具 — 派生子 Agent 执行子任务
 *
 * 主 Agent 通过调用此工具派生子 Agent，支持：
 * - 任务描述（prompt）
 * - 可选的工具白名单限制
 * - 可选的 capabilities 参数（指定子 Agent 可用的 skill/agent 能力）
 * - 流式进度回调
 *
 * 并发控制：槽位满时直接拒绝并告知上限，由父 Agent（LLM）自行决定重试策略。
 * 并行：由 LLM 原生 parallel function call 实现，不在工具内做并行编排。
 */

import {z} from 'zod'
import {randomUUID} from 'crypto'
import type {Tool, ToolContext, ToolResult} from '../types'
import {subAgentScheduler} from '../../subagent/scheduler'
import type {SubAgentEvent, SubAgentResult, SubAgentTask} from '../../subagent/types'
import {logger} from '../../logger'
import type {AgentStreamEvent} from '../../stream'
import {agentRegistry} from '../../agentRegistry'
import {skillRegistry} from '../../skills'
import {runtimeConfigManager} from '../../runtimeConfigManager'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'
import {permissionEngine} from '../permission'
import type {ModelConfig} from '../../model/types'

// ─── 子 Agent 进度格式化 ──────────────────────────────────

/**
 * 将子 Agent 事件转换为人类可读的进度文本
 *
 * 接受可选的 streamEvent 参数以补充实时细节（合并了原 enrichProgressWithContent 逻辑）。
 */
function formatSubAgentProgress(event: SubAgentEvent | AgentStreamEvent, streamEvent?: AgentStreamEvent): string {
    // 如果有流式事件详情，优先展示其实时内容
    if (streamEvent) {
        switch (streamEvent.type) {
            case 'text': {
                return '子 Agent 输出中...'
            }
            case 'thinking':
                return '子 Agent 思考中...'
            case 'tool_start': {
                const name = streamEvent.toolCall?.name
                const args = streamEvent.toolCall?.arguments
                if (name && args) {
                    const keys = typeof args === 'object' ? Object.keys(args as object).slice(0, 3).join(', ') : ''
                    return `🔧 ${name}${keys ? `(${keys})` : ''}`
                }
                return `🔧 ${name || '工具'} 调用中...`
            }
            case 'tool_progress':
                return `子 Agent: ${streamEvent.progress || '执行中...'}`
            case 'tool_result': {
                const out = streamEvent.result?.output
                if (out && typeof out === 'string') {
                    const trimmed = out.trim()
                    return trimmed.length > 60 ? trimmed.slice(0, 60) + '...' : trimmed
                }
                return `✓ ${streamEvent.toolName || '工具'} 完成`
            }
            case 'error':
                return `❌ ${streamEvent.error || '未知错误'}`
            case 'done':
                return '子 Agent 完成'
            case 'ask_user':
                return '子 Agent 等待用户确认...'
            default:
                break // 回退到 event.type 基础处理
        }
    }

    // 处理 SubAgentEvent 包装类型
    if (event.type === 'subagent_progress' && 'event' in event) {
        return formatSubAgentProgress(event.event)
    }
    if (event.type === 'subagent_start') {
        return '子 Agent 启动中...'
    }
    if (event.type === 'subagent_done') {
        return '子 Agent 完成'
    }

    // 处理裸 AgentStreamEvent 类型
    const ae = event as AgentStreamEvent
    switch (ae.type) {
        case 'thinking':
            return '子 Agent 思考中...'
        case 'text': {
            return '子 Agent 输出中...'
        }
        case 'tool_start':
            return `🔧 ${ae.toolCall?.name || '工具'} 调用中...`
        case 'tool_progress':
            return `子 Agent: ${ae.progress || '执行中...'}`
        case 'tool_result':
            return `✓ ${ae.toolName || '工具'} 完成`
        case 'error':
            return `❌ ${ae.error || '未知错误'}`
        case 'ask_user':
            return '子 Agent 等待用户确认...'
        case 'done':
            return '子 Agent 完成'
        default:
            return `子 Agent 执行中: ${ae.type}`
    }
}

// ─── 能力解析 ────────────────────────────────────────────

/** 能力查找结果 */
interface CapabilityInfo {
    name: string
    type: 'skill' | 'agent'
    markdown: string
}

/**
 * 从全局能力注册表中查找指定名称的 skill/agent
 *
 * 查找顺序：agentRegistry（模糊匹配）→ skillRegistry（精确匹配 id 或 name）
 */
function resolveCapabilities(names: string[]): CapabilityInfo[] {
    const results: CapabilityInfo[] = []

    for (const name of names) {
        // 1. 在 agentRegistry 中查找（支持模糊匹配）
        const agent = agentRegistry.find(name)
        if (agent) {
            results.push({
                name: agent.name,
                type: 'agent',
                markdown: agent.systemPrompt || agent.description || '',
            })
            continue
        }

        // 2. 在 skillRegistry 中查找（精确匹配 id 或 name）
        const skills = skillRegistry.getAll()
        const skill = skills.find(s => s.id === name || s.name === name)
        if (skill) {
            results.push({
                name: skill.name,
                type: 'skill',
                markdown: skill.description || '',
            })
            continue
        }

        logger.warn(`[AgentTool] capability "${name}" not found in agentRegistry or skillRegistry`)
    }

    return results
}

// ─── 输入 Schema ──────────────────────────────────────────

const inputSchema = z.object({
    task: z.string().describe('子任务的完整描述（包含目标 + 参考材料）'),
    tools: z.array(z.string()).optional().describe('允许使用的工具白名单（不传则使用所有可用工具）'),
    capabilities: z.array(z.string()).optional()
        .describe('要加载到子 Agent 系统提示词中的 skill/agent 名称列表'),
})

type AgentToolInput = z.infer<typeof inputSchema>

// ─── 子任务执行 ──────────────────────────────────────────

/**
 * 构建子 Agent 的模型配置（使用主 Provider）
 */
function buildModelConfig(): ModelConfig | null {
    const primary = runtimeConfigManager.getPrimaryProvider()
    if (!primary.isValid || !primary.provider) return null

    return {
        provider: primary.provider.type,
        model: primary.modelName || '',
        apiKey: '',
        baseUrl: primary.provider.baseUrl || '',
    }
}

/**
 * 执行单个子任务
 */
async function executeSingleTask(
    task: SubAgentTask,
    context: ToolContext,
    capabilities?: CapabilityInfo[],
): Promise<SubAgentResult> {
    // 注入 capabilities 到任务描述
    let finalDescription = task.description
    if (capabilities && capabilities.length > 0) {
        const capsSection = capabilities
            .map(c => `### ${c.type === 'agent' ? 'Agent' : 'Skill'}: ${c.name}\n\n${c.markdown}`)
            .join('\n\n---\n\n')
        finalDescription = `${task.description}\n\n---\n## 可用能力\n${capsSection}`
    }

    // 更新 task 的描述（注入能力后）
    const enrichedTask: SubAgentTask = {
        ...task,
        description: finalDescription,
    }

    // 模型配置
    const modelConfig = buildModelConfig()
    if (!modelConfig) {
        return {
            taskId: task.id,
            success: false,
            output: '',
            error: '无法获取模型配置',
        }
    }

    // 系统设置
    const settings = systemSettingsRepo.getJson<import('@shared/types').SystemSettings>('settings')
    const workingDir = runtimeConfigManager.getConfig().workingDir || ''

    let output = ''
    let hasError = false
    let errorMsg = ''
    let lastResult: SubAgentResult | undefined

    try {
        for await (const event of subAgentScheduler.executeTask({
            task: enrichedTask,
            modelConfig,
            workingDir,
            abortSignal: context.abortSignal,
            agentType: 'General',
            settings: settings || undefined,
        })) {
            // 提取子 Agent 流式事件（用于详细输出查看）
            let streamEvent: AgentStreamEvent | undefined
            if (event.type === 'subagent_progress' && 'event' in event) {
                streamEvent = event.event as AgentStreamEvent
            }

            // 将子 Agent 事件转换为人类可读的进度文本
            const richProgress = formatSubAgentProgress(event, streamEvent)

            // 按原始事件类型分发
            if (event.type === 'subagent_start') {
                context.sendMessage({
                    type: 'subagent_start',
                    taskId: task.id,
                    description: event.description,
                    toolCallId: context.toolCallId,
                })
                context.sendMessage({
                    type: 'subagent_progress',
                    taskId: task.id,
                    subAgentEvent: 'subagent_start',
                    progress: richProgress,
                    subAgentStreamEvent: undefined,
                    toolCallId: context.toolCallId,
                })
            } else if (event.type === 'subagent_done') {
                context.sendMessage({
                    type: 'subagent_done',
                    taskId: task.id,
                    success: event.result?.success ?? true,
                    output: event.result?.output ?? '',
                    error: event.result?.error,
                    toolCallId: context.toolCallId,
                })
                context.sendMessage({
                    type: 'subagent_progress',
                    taskId: task.id,
                    subAgentEvent: 'subagent_done',
                    progress: richProgress,
                    subAgentStreamEvent: undefined,
                    toolCallId: context.toolCallId,
                })
                lastResult = event.result
                output = event.result.output
                hasError = !event.result.success
                errorMsg = event.result.error || ''
            } else {
                // subagent_progress 正常转发
                context.sendMessage({
                    type: 'subagent_progress',
                    taskId: task.id,
                    subAgentEvent: event.type,
                    progress: richProgress,
                    subAgentStreamEvent: streamEvent,
                    toolCallId: context.toolCallId,
                })
            }
        }
    } catch (err: any) {
        hasError = true
        errorMsg = err.message
    }

    return (
        lastResult || {
            taskId: task.id,
            success: !hasError,
            output: output.trim(),
            error: hasError ? errorMsg : undefined,
        }
    )
}

// ─── 工具定义 ──────────────────────────────────────────────

export const agentTool: Tool<AgentToolInput, string> = {
    name: 'agent',
    description:
        '派生专门子 Agent 执行子任务。子 Agent 拥有独立的推理循环和工具访问权限。' +
        '需要并行时，由主 Agent 在同一轮对话中同时调用多个 agent 工具实现。' +
        '通过 capabilities 参数可指定子 Agent 可用的 skill/agent 能力。',
    inputSchema,
    isDestructive: false,

    async execute(args, context): Promise<ToolResult<string>> {
        // 检查模型配置
        const primary = runtimeConfigManager.getPrimaryProvider()
        if (!primary.isValid) {
            return {
                success: false,
                output: '',
                error: '模型配置未初始化',
            }
        }

        // 并发容量检查
        if (!subAgentScheduler.hasCapacity) {
            return {
                success: false,
                output: '',
                error: `并发上限已满 (最多 ${subAgentScheduler.maxConcurrency} 个子 Agent)，请稍后重试`,
            }
        }

        // 解析 capabilities
        const resolvedCapabilities = args.capabilities
            ? resolveCapabilities(args.capabilities)
            : undefined

        // 构建 SubAgentTask
        const task: SubAgentTask = {
            id: `sub-${randomUUID().slice(0, 8)}`,
            description: args.task,
            allowedTools: args.tools,
        }

        logger.info('[AgentTool]', {action: 'startingSubAgent', taskId: task.id, task: args.task.slice(0, 80)})

        try {
            const result = await executeSingleTask(task, context, resolvedCapabilities)

            const status = !result.success ? 'FAILED' : 'COMPLETED'
            logger.info('[AgentTool]', {
                action: 'subAgentCompleted',
                status,
                taskId: task.id,
                task: args.task.slice(0, 80),
            })

            return {
                success: result.success,
                output: result.output || (result.success ? '子 Agent 完成（无输出）' : `子 Agent 执行失败: ${result.error}`),
                error: result.error,
            }
        } catch (err: any) {
            logger.error('[AgentTool]', {action: 'subAgentError', taskId: task.id, error: err.message})
            return {
                success: false,
                output: `子 Agent 执行失败: ${err.message}`,
                error: err.message,
            }
        }
    },
}

/** 设置当前 Agent 的模型方案配置 */
export function setAgentToolConfig(): void {
    const config = runtimeConfigManager.getConfig()

    // 设置权限引擎的工作目录
    if (config.workingDir) {
        permissionEngine.setWorkingDir(config.workingDir)
    }
}
