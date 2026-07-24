/**
 * agent 内置工具 — 派生子 Agent 执行子任务
 *
 * 主 Agent 通过调用此工具派生子 Agent，支持：
 * - 任务描述（prompt）
 * - 可选的 agent 参数（指定子 Agent 名称，匹配后以该 Agent 身份启动）
 * - 可选的 tools 参数（指定工具白名单，可覆盖 Agent 定义）
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
import type {AgentTemplate} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'
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

// ─── Agent 模板转换 ───────────────────────────────────────

/**
 * 将 AgentTemplate 转换为 AgentDefinition
 *
 * source 使用 'user' 以确保 agent 工具不被 built-in 规则禁止。
 * AgentTemplate 没有 source 字段；built-in source 会额外禁止 agent 工具（防递归），
 * 本地 Agent 和插件 Agent 都不应该禁止 agent 工具，'user' 对所有场景安全。
 */
function agentTemplateToDefinition(template: AgentTemplate): AgentDefinition {
    return {
        source: 'user',
        agentType: template.name,
        whenToUse: template.whenToUse || template.description || '',
        description: template.description || '',
        systemPromptTemplate: template.systemPrompt,
        renderedSystemPrompt: '',
        tools: template.allowedTools,
        disallowedTools: template.disallowedTools,
        tags: template.tags,
        model: template.model,
        permissionMode: template.permissionMode,
        maxTurns: template.maxTurns,
        isolation: template.isolation,
        requiredMcpServers: template.requiredMcpServers,
    }
}

// ─── 输入 Schema ──────────────────────────────────────────

const inputSchema = z.object({
    task: z.string().describe('子任务的完整描述（包含目标 + 参考材料）'),
    agent: z.string().optional()
        .describe('要作为子 Agent 运行的 Agent 名称（从 agentRegistry 中查找）'),
    tools: z.array(z.string()).optional()
        .describe('允许使用的工具白名单（指定 agent 时覆盖 Agent 定义的白名单）'),
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
 *
 * 将任务通过 Scheduler 派发给子 Agent。
 * agentDefinition 非空时，子 Agent 以该 Agent 的身份启动（专属提示词/工具/权限等）；
 * 为空时以 General 身份启动。
 */
async function executeSingleTask(
    task: SubAgentTask,
    context: ToolContext,
    agentDefinition?: AgentDefinition,
): Promise<SubAgentResult> {
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
            task: task,
            modelConfig,
            workingDir,
            abortSignal: context.abortSignal,
            agentType: agentDefinition?.agentType || 'General',
            agentDefinition,
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
        '通过 agent 参数指定子 Agent 名称（从 agentRegistry 中查找），' +
        'tools 参数可覆盖 Agent 定义的工具白名单。',
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

        // 1. 解析 agent → 转换为 AgentDefinition
        let agentDefinition: AgentDefinition | undefined
        if (args.agent) {
            const template = agentRegistry.find(args.agent)
            if (template) {
                agentDefinition = agentTemplateToDefinition(template)
            } else {
                logger.warn(`[AgentTool] agent "${args.agent}" not found, falling back to General`)
            }
        }

        // 2. tools 覆盖：同时指定 agent 和 tools 时，tools 覆盖 Agent 定义的白名单
        if (agentDefinition && args.tools) {
            agentDefinition = { ...agentDefinition, tools: args.tools }
        }

        // 3. 构建 SubAgentTask
        const task: SubAgentTask = {
            id: `sub-${randomUUID().slice(0, 8)}`,
            description: args.task,
            allowedTools: agentDefinition?.tools ?? args.tools,
        }

        logger.info('[AgentTool]', {
            action: 'startingSubAgent',
            taskId: task.id,
            agentType: agentDefinition?.agentType || 'General',
            tools: task.allowedTools?.length ? task.allowedTools : '(all)',
            task: args.task.slice(0, 80),
        })

        try {
            const result = await executeSingleTask(task, context, agentDefinition)

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
