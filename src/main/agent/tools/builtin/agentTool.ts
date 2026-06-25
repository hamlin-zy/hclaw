/**
 * agent 内置工具 — 派生子 Agent 执行子任务
 *
 * 主 Agent 通过调用此工具派生子 Agent，支持：
 * - 任务描述 + 附加上下文
 * - 可选的工具白名单限制
 * - 超时控制
 * - 流式进度回调
 * - 并行执行多个子任务（tasks 数组）
 * - 支持模型方案，根据任务复杂度选择模型
 */

import {z} from 'zod'
import {randomUUID} from 'crypto'
import type {Tool, ToolContext, ToolResult} from '../types'
import {subAgentScheduler} from '../../subagent/scheduler'
import type {SubAgentEvent, SubAgentResult, SubAgentTask} from '../../subagent/types'
import type {HClawAgentType, TaskComplexity} from '@shared/types'
import {quickComplexityCheck} from '../../model/intentAnalyzer'
import {logger} from '../../logger'
import type {AgentStreamEvent} from '../../stream'
import type {AgentLoadResult, UserAgentDefinition} from '@shared/agent'
import type {AgentType} from '@shared/agent'
import type {AgentTemplate} from '@shared/types'
import {loadAgents} from '../../loader'
import {agentRegistry} from '../../agentRegistry'
import {worktreeManager} from '../../isolation/worktree'
import {type RoleProviderInfo, runtimeConfigManager} from '../../runtimeConfigManager'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'
import {permissionEngine} from '../permission'
import {findAgentByType} from '../../utils/agentMatching'
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

// ─── 常量 ──────────────────────────────────────────────────

/** Zod schema 硬上限（取系统设置的 maxConcurrency 与实际能够运行的最大并行数较大者） */
const SCHEMA_MAX_PARALLEL_TASKS = Math.max(10, subAgentScheduler.maxConcurrency)

/** Agent 加载缓存 TTL（5 分钟） */
const AGENT_CACHE_TTL_MS = 5 * 60 * 1000

// ─── 配置状态 ──────────────────────────────────────────────

// 配置现在直接从 RuntimeConfigManager 读取，不再需要模块级缓存

let _loadedAgents: AgentLoadResult | null = null
let _loadedAgentsTimestamp = 0

/** 获取加载的 Agent 定义（带 TTL 自动过期） */
async function getLoadedAgents(): Promise<AgentLoadResult> {
  const now = Date.now()
  if (!_loadedAgents || (now - _loadedAgentsTimestamp) > AGENT_CACHE_TTL_MS) {
    _loadedAgents = await loadAgents()
    _loadedAgentsTimestamp = now
  }
  return _loadedAgents
}

// ─── 输入 Schema ──────────────────────────────────────────

const baseTaskFields = {
    task: z.string().describe('子任务的详细描述'),
    context: z.string().optional().describe('附加上下文信息（可选）'),
    tools: z.array(z.string()).optional().describe('允许使用的工具白名单'),
    complexity: z.enum(['simple', 'moderate', 'complex']).optional().describe('任务复杂度（可选）'),
    agentType: z.string().optional().describe('Agent 类型（可选）'),
    isolation: z.enum(['worktree', 'none']).optional().describe('隔离模式（可选）'),
    priority: z.number().int().min(0).max(10).optional().describe('任务优先级（0-10，可选）'),
}

const singleTaskSchema = z.object({
    ...baseTaskFields,
})

const multiTaskSchema = z.object({
    tasks: z
        .array(z.object(baseTaskFields))
        .min(1)
        .max(SCHEMA_MAX_PARALLEL_TASKS)
        .describe('并行执行的子任务列表（最大并发数由系统设置中的子 Agent 配置控制）'),
    parallel: z.literal(true).describe('必须为 true 以启用并行模式'),
})

const inputSchema = z.union([singleTaskSchema, multiTaskSchema])

type SingleTaskInput = z.infer<typeof singleTaskSchema>
type MultiTaskInput = z.infer<typeof multiTaskSchema>
type AgentToolInput = z.infer<typeof inputSchema>

// ─── 模型选择辅助函数 ───────────────────────────────────────

/**
 * 根据角色 Provider 信息和任务复杂度解析模型配置（纯函数，便于测试）
 */
function resolveModelConfig(
    primary: RoleProviderInfo,
    lightweight: RoleProviderInfo,
    reasoning: RoleProviderInfo,
    taskDescription: string,
    complexity?: TaskComplexity,
): ModelConfig | null {
    if (!primary.isValid || !primary.provider) {
        return primary.modelId ? {
            provider: primary.provider?.type || 'openai',
            model: primary.modelName || '',
            apiKey: '',
            baseUrl: primary.provider?.baseUrl || '',
        } : null
    }

    const taskComplexity = complexity || quickComplexityCheck(taskDescription).complexity

    const targetProvider: RoleProviderInfo =
        taskComplexity === 'simple' && lightweight.isValid ? lightweight
            : taskComplexity === 'complex' && reasoning.isValid ? reasoning
                : primary

    if (!targetProvider.isValid || !targetProvider.provider) {
        return primary.modelId ? {
            provider: primary.provider?.type || 'openai',
            model: primary.modelName || '',
            apiKey: '',
            baseUrl: primary.provider?.baseUrl || '',
        } : null
    }

    return {
        provider: targetProvider.provider.type,
        model: targetProvider.modelName || '',
        apiKey: '',
        baseUrl: targetProvider.provider.baseUrl || '',
    }
}

/**
 * 根据任务复杂度选择模型配置（从 RuntimeConfigManager 读取角色配置）
 */
function selectModelForSubAgent(
    taskDescription: string,
    complexity?: TaskComplexity,
): ModelConfig | null {
    const primary = runtimeConfigManager.getPrimaryProvider()
    const lightweight = runtimeConfigManager.getLightweightProvider()
    const reasoning = runtimeConfigManager.getReasoningProvider()
    return resolveModelConfig(primary, lightweight, reasoning, taskDescription, complexity)
}

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 将 AgentTemplate（registry 格式）转换为 UserAgentDefinition（agent 工具所需格式）
 * 用于 registry 降级查找时的类型桥接
 */
function templateToUserAgentDef(template: AgentTemplate): UserAgentDefinition {
    return {
        agentType: template.name as AgentType,
        whenToUse: template.whenToUse || '',
        description: template.description || template.name,
        systemPromptTemplate: template.systemPrompt,
        tags: template.tags,
        model: template.model,
        permissionMode: template.permissionMode,
        maxTurns: template.maxTurns,
        isolation: template.isolation,
        requiredMcpServers: template.requiredMcpServers,
        source: 'user',
        renderedSystemPrompt: template.systemPrompt,
    }
}

/**
 * 执行单个子任务
 */
async function executeSingleTask(
  task: SubAgentTask,
  taskDescription: string,
  context: ToolContext,
  complexity?: TaskComplexity,
  agentType?: HClawAgentType,
  isolation?: 'worktree' | 'none',
): Promise<SubAgentResult> {
    // 加载 Agent 定义
    const {activeAgents} = await getLoadedAgents()

    // AgentType 降级逻辑：当 agentType 为空/未设置时，默认使用 'General'
    const resolvedAgentType: HClawAgentType = (agentType && agentType.trim() !== '')
        ? agentType
        : (task.agentType && task.agentType.trim() !== '')
            ? task.agentType
            : 'General'

    // 使用统一的 Agent 匹配函数（找不到匹配时静默降级为 General）
    let {agent: agentDefinition} = findAgentByType(activeAgents, {
        requestedType: resolvedAgentType,
        logWarning: true,
    })

    // ★ 磁盘 Agent 未命中时，降级到 agentRegistry（包含命令注册的 Agent）
    if (!agentDefinition) {
        const template = agentRegistry.find(resolvedAgentType)
        if (template) {
            agentDefinition = templateToUserAgentDef(template)
        }
    }

    // 如果未匹配到特定 Agent 定义，降级使用 'General'
    const effectiveAgentType: HClawAgentType = agentDefinition?.agentType as HClawAgentType || 'General'

    // 直接从 systemSettingsRepo 获取系统设置（runtimeConfigManager 在主线程中 settings 为 null）
    const settings = systemSettingsRepo.getJson<import('@shared/types').SystemSettings>('settings')

    // 处理隔离模式
    let workingDir = runtimeConfigManager.getConfig().workingDir || ''

    if (agentDefinition?.isolation === 'worktree' || isolation === 'worktree') {
        try {
            workingDir = await worktreeManager.createWorktree(workingDir, task.id)
        } catch (error) {
            return {
                taskId: task.id,
                success: false,
                output: '',
                error: `创建 worktree 失败: ${error}`,
            }
        }
    }

    // 选择合适的模型
    const modelConfig = selectModelForSubAgent(taskDescription, complexity)
    if (!modelConfig) {
        return {
            taskId: task.id,
            success: false,
            output: '',
            error: '无法获取模型配置',
        }
    }

    let output = ''
    let hasError = false
    let errorMsg = ''
    let lastResult: SubAgentResult | undefined

    try {
        for await (const event of subAgentScheduler.executeTask({
            task,
            modelConfig,
            workingDir,
            abortSignal: context.abortSignal,
            agentType: effectiveAgentType,
            agentDefinition,
            settings: settings || undefined, // 传递系统设置
        })) {
            // 提取子 Agent 流式事件（用于详细输出查看）
            let streamEvent: AgentStreamEvent | undefined
            if (event.type === 'subagent_progress' && 'event' in event) {
                streamEvent = event.event as AgentStreamEvent
            }

            // 将子 Agent 事件转换为人类可读的进度文本（合并原 enrichProgressWithContent 逻辑）
            const richProgress = formatSubAgentProgress(event, streamEvent)

            // 按原始事件类型分发，让 controller/renderer 能正确识别 subagent_start/subagent_done
            if (event.type === 'subagent_start') {
                context.sendMessage({
                    type: 'subagent_start',
                    taskId: task.id,
                    description: event.description,
                    toolCallId: context.toolCallId,
                })
                // start 也发送一条 progress，让父卡片第一时间有进度提示
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
                // done 也发送一条 progress，让父卡片看到完成状态
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

// ─── 优先级辅助 ──────────────────────────────────────────

const PRIORITY_MAP: Record<TaskComplexity, number> = {
    simple: 1,
    moderate: 5,
    complex: 10,
}

function resolvePriority(
    explicitPriority: number | undefined,
    complexity: TaskComplexity | undefined,
): number {
    return explicitPriority ?? (complexity ? PRIORITY_MAP[complexity] : 0)
}

// ─── 工具定义 ──────────────────────────────────────────────

export const agentTool: Tool<AgentToolInput, string> = {
  name: 'agent',
  description:
      '派生专门的专家代理处理子任务，由主 Agent 作为调度中心。子 Agent 拥有独立的推理循环和工具访问权限。' +
      '支持单任务或并行委派（最大并发数由系统设置控制，默认 3 个）。可根据任务复杂度自动选择最优模型。',
  inputSchema,
  isDestructive: false,

  async execute(args, context): Promise<ToolResult<string>> {
      // 从 RuntimeConfigManager 检查配置
      const primary = runtimeConfigManager.getPrimaryProvider()
      if (!primary.isValid) {
      return {
        success: false,
        output: '',
        error: '模型配置未初始化',
      }
    }

    // 检测是单任务还是多任务模式
    const isParallelMode = 'parallel' in args && args.parallel === true

    if (isParallelMode) {
      // ── 并行模式 ──────────────────────────────
      const multiArgs = args as MultiTaskInput
      const tasks = multiArgs.tasks

      // 检查并发容量（使用调度器统一的上限，避免重复读取 systemSettingsRepo）
      const maxConcurrency = subAgentScheduler.maxConcurrency
      if (tasks.length > maxConcurrency) {
        return {
          success: false,
          output: '',
          error: `最多支持 ${maxConcurrency} 个并行子任务（当前系统设置上限）`,
        }
      }

      // 创建子任务（无超时限制，子 Agent 永久等待完成）
      const subTasks: SubAgentTask[] = tasks.map((t, i) => ({
        id: `sub-${randomUUID().slice(0, 8)}-${i}`,
        description: t.task,
        allowedTools: t.tools,
        context: t.context,
        agentType: t.agentType as HClawAgentType | undefined,
          priority: resolvePriority(t.priority, t.complexity),
      }))

        logger.info('[AgentTool]', {action: 'startingParallelSubAgents', count: subTasks.length})

      try {
          // 并行执行所有子任务
          // 注意：不再在此处发送 subagent_start —— executeSingleTask 内部
          // 通过 subAgentScheduler.executeTask() 的 for-await 事件循环自动发送，
          // 避免双重发送导致前端 handleSubagentStart 重复注册 toolCall。
          const taskPromises = subTasks.map(async (task, i) => {
              try {
                  return await executeSingleTask(
                    task,
                    tasks[i].task,
                      context,
                    tasks[i].complexity,
                    tasks[i].agentType as HClawAgentType | undefined,
                    tasks[i].isolation,
                  )
              } catch (err: any) {
                  // 发送失败事件
                  context.sendMessage({
                      type: 'subagent_done',
                      taskId: task.id,
                      success: false,
                      output: '',
                      error: err.message,
                      toolCallId: context.toolCallId,
                  })
                  return {
                      taskId: task.id,
                      success: false,
                      output: '',
                      error: err.message,
                  } as SubAgentResult
              }
          })

          // 等待所有任务完成
          const settledResults = await Promise.all(taskPromises)

        // 聚合结果
          const successful = settledResults.filter((r) => r.success)
          const failed = settledResults.filter((r) => !r.success)

        let output = ''
        if (successful.length > 0) {
          output += `成功完成 ${successful.length} 个子任务:\n`
          successful.forEach((r, i) => {
            output += `\n### 任务 ${i + 1}\n${r.output}\n`
          })
        }
        if (failed.length > 0) {
          output += `\n失败 ${failed.length} 个子任务:\n`
          failed.forEach((r, i) => {
            output += `\n### 失败任务 ${i + 1}\n错误: ${r.error}\n`
          })
        }

          logger.info('[AgentTool]', {
              action: 'parallelSubAgentsCompleted',
              succeeded: successful.length,
              failed: failed.length
          })

        return {
          success: failed.length === 0,
          output,
          error: failed.length > 0 ? `${failed.length} tasks failed` : undefined,
        }
      } catch (err: any) {
                return {
          success: false,
          output: '',
          error: `并行执行失败: ${err.message}`,
        }
      }
    } else {
      // ── 单任务模式 ──────────────────────────────
      const singleArgs = args as SingleTaskInput

      if (!subAgentScheduler.hasCapacity) {
        return {
          success: false,
          output: '',
          error: `并发上限已满 (最多 ${subAgentScheduler.maxConcurrency} 个子 Agent)，请等待其他子任务完成`,
        }
      }

      const task: SubAgentTask = {
        id: `sub-${randomUUID().slice(0, 8)}`,
        description: singleArgs.task,
        allowedTools: singleArgs.tools,
        context: singleArgs.context,
          agentType: singleArgs.agentType as HClawAgentType | undefined,
          priority: resolvePriority(singleArgs.priority, singleArgs.complexity),
      }

      
        logger.info('[AgentTool]', {action: 'startingSubAgent', taskId: task.id, task: singleArgs.task.slice(0, 80)})

      try {
          const result = await executeSingleTask(
              task,
              singleArgs.task,
              context,
              singleArgs.complexity,
              singleArgs.agentType as HClawAgentType | undefined,
              singleArgs.isolation,
          )

          const status = !result.success ? 'FAILED' : 'COMPLETED'
          logger.info('[AgentTool]', {
              action: 'subAgentCompleted',
              status,
              taskId: task.id,
              task: singleArgs.task.slice(0, 80)
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
    }
  },
}

/** 设置当前 Agent 的模型方案配置（无参版本 - 从 RuntimeConfigManager 读取） */
export function setAgentToolConfig(): void {
    const config = runtimeConfigManager.getConfig()
    const _primary = runtimeConfigManager.getPrimaryProvider()

    // 设置权限引擎的工作目录
    if (config.workingDir) {
        permissionEngine.setWorkingDir(config.workingDir)
    }


}
