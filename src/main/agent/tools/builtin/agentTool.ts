/**
 * agent 内置工具 — 派生子 Agent 执行子任务
 *
 * 主 Agent 通过调用此工具派生子 Agent，支持：
 * - 任务描述（prompt）
 * - agent 参数（必填，指定子 Agent 名称；从 agentRegistry 中查找，
 *   未找到时返回错误 + 可用列表，强制 LLM 修正重试，不静默回退）
 * - 可选的 tools 参数（指定工具白名单，可覆盖 Agent 定义）
 * - 独立会话（子 Agent 拥有独立的 conversation，与父会话单向关联，侧栏可见）
 *
 * 执行策略：
 * - 子会话创建于 SQLite（持久化，侧栏可见）
 * - agentLoop 在当前进程/线程中运行（不使用独立 Worker）
 * - 通过 context.sendMessage() 转发子 Agent 事件（流式进度卡片）
 * - 子会话的完整对话历史写入 SQLite（用户可在侧栏回溯查看）
 *
 * 递归深度：通过 parentConvId 链追踪，达到 maxDepth 上限时拒绝。
 * 并发：由 LLM 原生 parallel function call 限制 + 本地计数器兜底。
 */

import {z} from 'zod'
import {randomUUID} from 'crypto'
import {parentPort} from 'worker_threads'
import type {Tool, ToolResult} from '../types'
import {agentLoop} from '../../loop'
import type {AgentStreamEvent} from '../../stream'
import {logger} from '../../logger'
import {agentRegistry} from '../../agentRegistry'
import {agentTemplateToDefinition} from '../../agentTemplateConverter'
import type {AgentDefinition} from '@shared/agent'
import {runtimeConfigManager} from '../../runtimeConfigManager'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'
import {permissionEngine} from '../permission'
import {createConversationRepository} from '../../../repositories'
import {
    createChildConvAccumulator,
    finalizeChildConv,
    flushAccumulatorMessage,
    handleChildEvent,
} from './childConvMessages'

// ─── 并发控制 ──────────────────────────────────────────────

const activeChildSessions = new Set<string>()

// ─── 递归深度追踪 ────────────────────────────────────────

/**
 * 沿 parentConvId 链向上追溯，计算当前会话的递归深度
 *
 * 用于防止子 Agent 无限嵌套（如 A → B → A → B...）。
 * visited 集合防止循环引用导致死循环。
 */
function getRecursionDepth(convId: string): number {
    let depth = 0
    let current = convId
    const visited = new Set<string>()
    const repo = createConversationRepository()

    while (true) {
        if (visited.has(current)) break
        visited.add(current)

        const meta = repo.readMeta(current)
        if (!meta?.parentConvId) break
        current = meta.parentConvId
        depth++
    }

    return depth
}

// ─── 输入 Schema ──────────────────────────────────────────

const inputSchema = z.object({
    task: z.string().describe('子任务的完整描述（包含目标 + 参考材料）'),
    agent: z.string()
        .describe('必填。要作为子 Agent 运行的 Agent 名称，从当前可用 Agent 列表中精确选择（如 "Implementer Agent"、"Code Reviewer Agent"）。根据任务类型选择最匹配的角色；不确定时用 "General Agent"。'),
    tools: z.array(z.string()).optional()
        .describe('允许使用的工具白名单（指定 agent 时覆盖 Agent 定义的白名单）'),
})

type AgentToolInput = z.infer<typeof inputSchema>

// ─── 工具定义 ──────────────────────────────────────────────

export const agentTool: Tool<AgentToolInput, string> = {
    name: 'agent',
    description:
        '派生专门子 Agent 执行子任务。子 Agent 拥有独立的推理循环和工具访问权限。\n' +
        '【必填参数】agent：从当前"可用能力"的 Agent 列表中选择一个（如 "Implementer Agent"、"Code Reviewer Agent"、"Explore Agent"、"Plan Agent"、"Verification Agent"、"General Agent"）。' +
        '根据任务类型选择最匹配的角色：实现/修复→Implementer、审查→Code Reviewer、代码搜索/调研→Explore、架构规划→Plan、验证→Verification、模糊或跨领域→General。' +
        '不要使用任何列表之外的名称（如 Claude Code 的 "Subagent (general-purpose)"），否则会报错并要求重试。\n' +
        '需要并行时，由主 Agent 在同一轮对话中同时调用多个 agent 工具实现。\n' +
        'tools 参数可覆盖 Agent 定义的工具白名单（可选）。\n' +
        '【编排规范】\n' +
        '1. 先规划再派遣：派遣前先分析整体任务，形成简洁的高层计划，识别关键路径上的' +
        '阻塞任务与可并行的旁路任务；不要把正在阻塞自己的任务派出去然后空等。\n' +
        '2. 并行优先：计划中的多个独立步骤，尽可能一次派遣多个子 Agent 并行执行。\n' +
        '3. 能写则写：编码任务优先派遣可落地的代码修改子任务（Implementer），' +
        '而非只读分析（Explore）——除非改动范围不明确需要先调研。\n' +
        '4. 避免无意义派遣：仅"要求更深入/更全面"不构成派遣理由；简单任务自己做。\n' +
        '5. 派遣后只协调：子 Agent 工作时不要重复执行它们的任务，等待结果后汇总。',
    inputSchema,
    isDestructive: false,

    async execute(args, context): Promise<ToolResult<string>> {
        // ① 检查模型配置
        const primary = runtimeConfigManager.getPrimaryProvider()
        if (!primary.isValid) {
            return {
                success: false,
                output: '',
                error: '模型配置未初始化',
            }
        }

        // ② 解析 agent（必填）→ 转换为 AgentDefinition
        //    未找到时返回错误 + 可用 Agent 列表，强制 LLM 修正后重试（不再静默回退 General）
        const template = agentRegistry.find(args.agent)
        if (!template) {
            const available = agentRegistry.getEnabled()
                .map(a => a.name)
                .filter(n => n && n !== 'General')
            return {
                success: false,
                output: '',
                error: `Agent "${args.agent}" 不存在。请从以下可用 Agent 中选择一个并重试：${available.join(', ') || 'General Agent'}`,
            }
        }
        const agentName = template.name
        const agentDefinition = agentTemplateToDefinition(template)

        // ③ tools 覆盖：同时指定 agent 和 tools 时，tools 覆盖 Agent 定义的白名单
        const effectiveAgentDefinition = args.tools
            ? {...agentDefinition, tools: args.tools}
            : agentDefinition

        // ④ 递归深度检查
        const settings = systemSettingsRepo.getJson<import('@shared/types').SystemSettings>('settings')
        const maxDepth = settings?.subagent?.maxDepth ?? 3
        const parentConvId = context.conversationId
        if (parentConvId) {
            const currentDepth = getRecursionDepth(parentConvId)
            if (currentDepth >= maxDepth) {
                return {
                    success: false,
                    output: '',
                    error: `已达到最大子 Agent 嵌套深度 (${maxDepth})，无法继续派生`,
                }
            }
        }

        // ⑤ 并发检查（本地计数器 + 设置中的 maxConcurrency）
        const maxConcurrency = settings?.subagent?.maxConcurrency ?? 3
        if (activeChildSessions.size >= maxConcurrency) {
            return {
                success: false,
                output: '',
                error: `并发上限已满 (最多 ${maxConcurrency} 个子 Agent)，请稍后重试`,
            }
        }

        // ⑥ 创建子会话
        const childConvId = `conv-${randomUUID()}`
        const conversationRepo = createConversationRepository()

        let workspacePath = ''
        if (parentConvId) {
            const parentMeta = conversationRepo.readMeta(parentConvId)
            workspacePath = parentMeta?.workspacePath || ''
        }

        const now = Date.now()
        conversationRepo.create(childConvId, {
            id: childConvId,
            title: `${agentName}: ${args.task.slice(0, 20)}...`,
            workspacePath,
            createdAt: now,
            updatedAt: now,
            preview: '',
            status: 'active',
            parentConvId: parentConvId || undefined,
            sourceTask: args.task,
            sourceCapability: {type: 'agent', name: agentName},
            isChildSession: true,
        })

        logger.info('[AgentTool]', {
            action: 'creatingChildConv',
            childConvId,
            parentConvId: parentConvId || '(none)',
            agentType: agentName,
            depth: parentConvId ? getRecursionDepth(parentConvId) + 1 : 1,
            task: args.task.slice(0, 80),
        })

        // 写入初始用户消息（子会话的独立历史）
        const userMsgId = `msg-${now}-${Math.random().toString(36).slice(2, 8)}`
        conversationRepo.writeMessages(childConvId, [{
            id: userMsgId,
            role: 'user',
            content: args.task,
            timestamp: now,
        }])

        // 通知渲染进程侧栏刷新（子会话已创建于 SQLite）
        notifyMainProcessChildConvCreated(childConvId, agentName, args.task, parentConvId)

        // ★ 立即推送 subagent_start（携带 toolCallId）：子会话创建成功瞬间即可让父卡片
        //   补写 taskId（taskId === childConvId），无需等第一个 subagent_progress 事件
        //   （子 Agent 首次 LLM 输出才触发，冷启动可能滞后数秒）。
        //   渲染进程 handleSubagentStart 按 toolCallId 精确定位父 agent 工具，幂等补写。
        context.sendMessage({
            type: 'subagent_start',
            taskId: childConvId,
            description: args.task,
            toolCallId: context.toolCallId,
        })

        // ⑦ 强制权限模式为 auto（子会话不弹确认框）
        const effectiveAgentDef: AgentDefinition = {
            source: 'user' as const,
            agentType: agentName,
            whenToUse: effectiveAgentDefinition.whenToUse || '',
            description: effectiveAgentDefinition.description || '',
            systemPromptTemplate: effectiveAgentDefinition.systemPromptTemplate || '',
            renderedSystemPrompt: '',
            tools: effectiveAgentDefinition.tools || args.tools,
            permissionMode: 'auto',
        }

        // ⑧ 构建 agentLoop 参数（当前进程/线程中运行）
        const modelConfig = {
            provider: primary.provider!.type,
            model: primary.modelName || '',
            apiKey: '',
            baseUrl: primary.provider!.baseUrl || '',
        }
        const workingDir = runtimeConfigManager.getConfig().workingDir || ''
        const maxTurnsLimit = settings?.agent?.maxTurns ?? 500

        // ⑨ 在当前进程/线程中运行子 Agent（不创建独立 Worker）
        let output = ''
        let hasError = false
        let errorMsg = ''
        // ★ 子会话完整执行过程累积器：整个子 Agent 运行累积为「单条」assistant 消息
        //   （思考/工具调用/正文按时间序写入 contentBlocks，与主会话同构：1 指令 + 1 助手气泡），
        //   在 tool_result / llm_call_done 时机增量 UPSERT 同一条消息（控制落库频率），
        //   done/error 时最终写入（endedAt）。替换旧的"仅完成时写一条最终摘要"方案，
        //   保证子会话可完整回溯执行过程。
        const childAcc = createChildConvAccumulator(childConvId)

        activeChildSessions.add(childConvId)

        // ★ 向渲染进程发送子会话 begin 事件，使侧边栏显示运行状态动画
        sendChildAgentEvent(childConvId, {type: 'begin'})

        try {
            for await (const event of agentLoop({
                sessionId: childConvId,
                messages: [
                    {role: 'user', content: args.task},
                ],
                modelConfig,
                workingDir,
                settings: settings || undefined,
                maxTurns: maxTurnsLimit,
                agentType: agentName,
                agentDefinition: effectiveAgentDef,
                conversationTitle: `子 Agent: ${args.task.slice(0, 50)}`,
                abortSignal: context.abortSignal,
                // ★ 关键：转发嵌套子 Agent（二级及以上）的 subagent_* 事件到父上下文。
                //   本 agentLoop 的 toolContext.sendMessage 依赖 onEvent 转发事件；
                //   若不传，嵌套 agentTool 的 context.sendMessage 变为空操作
                //   （execute.ts: if (!onEvent) return），二级子 Agent 的
                //   subagent_start/progress/done 全部丢失 → 父卡片无滚动、无子会话。
                //   toolCallId 必须替换为当前 agentTool 的 context.toolCallId
                //   （主会话中一级 agent 工具的调用 ID），渲染进程才能按 toolCallId
                //   定位到正确的一级 Agent 卡片。
                onEvent: (event: any) => {
                    if (event.type === 'subagent_start' || event.type === 'subagent_progress' || event.type === 'subagent_done') {
                        context.sendMessage({
                            ...event,
                            toolCallId: context.toolCallId,
                        })
                    }
                },
            })) {
                // ── 跳过内部事件 ──
                if (event.type === 'intent_analyzed' || event.type === 'mode_change') continue

                // ── 累积文本输出（返回给主 Agent 的最终摘要） ──
                if (event.type === 'text') {
                    output += event.content
                }

                // ── 累积器处理（构建完整执行过程消息） ──
                const shouldFlush = handleChildEvent(childAcc, event)
                if (shouldFlush) {
                    // 轮次完成（工具结果 / LLM 调用完成）→ 增量 UPSERT 同一条累积消息
                    flushAccumulatorMessage(childAcc, conversationRepo, childConvId, false)
                }

                // ── 事件分类转发给父上下文 ──
                if (event.type === 'thinking' || event.type === 'tool_start' || event.type === 'tool_progress' || event.type === 'tool_result') {
                    context.sendMessage({
                        type: 'subagent_progress',
                        taskId: childConvId,
                        toolCallId: context.toolCallId,
                        progress: formatProgress(event),
                        subAgentStreamEvent: event,
                    })
                } else if (event.type === 'done') {
                    // ★ 透传原始 done 事件（保留 reason: completed/aborted），
                    //   子会话 UI 才能正确显示中止态而非误报完成；父卡片 success 按 reason 判定
                    const doneReason = (event as {reason?: string}).reason || 'completed'
                    const isAborted = doneReason === 'aborted'
                    context.sendMessage({
                        type: 'subagent_done',
                        taskId: childConvId,
                        success: !isAborted,
                        output: isAborted ? '' : output,
                        error: isAborted ? '已中止' : undefined,
                        toolCallId: context.toolCallId,
                    })
                    sendChildAgentEvent(childConvId, event)
                    break
                } else if (event.type === 'error') {
                    hasError = true
                    errorMsg = event.error || '未知错误'
                    context.sendMessage({type: 'subagent_done', taskId: childConvId, success: false, error: errorMsg, toolCallId: context.toolCallId})
                    sendChildAgentEvent(childConvId, {type: 'done', reason: 'error'})
                    break
                }
                // 说明：嵌套子 Agent（二级及以上）的 subagent_start/progress/done
                // 由下方 agentLoop 的 onEvent 侧通道转发到父上下文，不会进入此 for-await
                // 循环（agentLoop 生成器不产出 subagent_* 事件），故此处无需再处理。

                // ★ 转发所有流事件到子会话渲染进程（text/thinking/tool_*/agent_start 等）
                //   用户切换到子会话时可以看到实时流式输出。
                //   内容事件附加累积器固定消息 id：渲染进程首个内容事件即创建同 id 消息，
                //   与主进程增量落库的 SQLite 消息 id 一致 → 运行中切换/刷新无重复气泡。
                if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_use') {
                    sendChildAgentEvent(childConvId, {
                        ...event,
                        messageId: childAcc.assistantMsgId,
                    } as AgentStreamEvent & {messageId?: string})
                } else {
                    sendChildAgentEvent(childConvId, event)
                }
            }
        } catch (err: any) {
            hasError = true
            errorMsg = err.message || String(err)
            // 异常同步到累积器（错误信息随单条消息持久化，供子会话回溯）
            childAcc.hasError = true
            childAcc.errorMsg = errorMsg
            logger.error('[AgentTool]', {action: 'childConvException', childConvId, error: errorMsg})
            // ★ 异常也通知渲染进程结束运行状态
            sendChildAgentEvent(childConvId, {type: 'done', reason: 'error'})
        } finally {
            activeChildSessions.delete(childConvId)
        }

        // ⑩ 写入子会话的辅助消息历史（最终落库）
        // ★ 完整执行过程（思考/工具调用/正文）已累积为单条 assistant 消息，
        //   运行中增量 UPSERT（tool_result / llm_call_done 时机），此处最终写入（endedAt）。
        //   空轮次（极早退出）由累积器内部兜底为占位消息。
        const finalOutput = (hasError ? '' : output.trim()) || '(无输出)'
        finalizeChildConv(childAcc, conversationRepo, childConvId)

        // 通知 UI 刷新（子会话在侧栏中出现）
        // ★ 注意：agentLoop 内已通过 notifyMainProcessChildConvCreated 首屏通知，
        //   此处再次通知确保 assistant 消息写入后侧栏预览更新
        // 主进程路径已由 notifyMainProcessChildConvCreated 覆盖，Worker 线程路径也由
        // createMessageHandler 中 child_conv_created 分发覆盖，此处仅作兜底
        notifyMainProcessChildConvCreated(childConvId, agentName, args.task, parentConvId)

        if (hasError) {
            return {
                success: false,
                output: `执行失败: ${errorMsg}`,
                error: errorMsg,
            }
        }

        // ⑪ 返回结果
        logger.info('[AgentTool]', {
            action: 'childConvCompleted',
            childConvId,
            success: true,
            outputLen: finalOutput.length,
        })

        return {
            success: true,
            output: finalOutput,
            _meta: {childConvId},
        }
    },
}

/** 格式化子 Agent 事件为人类可读文本 */
function formatProgress(event: AgentStreamEvent): string {
    switch (event.type) {
        case 'thinking': return '子 Agent 思考中...'
        case 'tool_start': {
            const tc = event.toolCall
            return tc?.name ? `🔧 ${tc.name}` : '🔧 工具调用中...'
        }
        case 'tool_progress': return `子 Agent: ${event.progress || '执行中...'}`
        case 'tool_result': {
            const out = event.result?.output
            if (out && typeof out === 'string') {
                const trimmed = out.trim()
                return trimmed.length > 60 ? trimmed.slice(0, 60) + '...' : trimmed
            }
            return '✓ 工具完成'
        }
        default: return '子 Agent 执行中...'
    }
}

/** 通用双路径发送：Worker 线程走 parentPort → 主进程转发，主进程直接 IPC 通知渲染进程 */
function sendToRenderer(workerType: string, workerPayload: Record<string, unknown>, mainChannel: string, mainPayload: Record<string, unknown>): void {
    try {
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage({type: workerType, ...workerPayload})
            return
        }
    } catch {
        // not in Worker
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- agentTool 运行在 MCP Worker 上下文，顶层 import window.ts 会把 electron 拉进 worker bundle
        const {getMainWindow} = require('../../../window')
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
            win.webContents.send(mainChannel, mainPayload)
        }
    } catch {
        // window not available
    }
}

/** 通知主进程 / 渲染进程刷新侧栏会话列表 */
function notifyMainProcessChildConvCreated(childConvId: string, agentName: string, task: string, parentConvId?: string): void {
    const title = `${agentName}: ${task.slice(0, 20)}...`
    sendToRenderer(
        'child_conv_created',
        {childConvId, title, parentConvId: parentConvId || ''},
        'child_conv_created',
        {id: childConvId, title, parentConvId: parentConvId || undefined},
    )
}

/** 向渲染进程发送子会话的 agent 生命周期事件（begin / done / error）
 *  使得侧边栏能展示子会话的运行状态动画（与父会话一致） */
function sendChildAgentEvent(childConvId: string, event: AgentStreamEvent): void {
    sendToRenderer(
        'child_agent_event',
        {conversationId: childConvId, event},
        'agent-stream',
        {conversationId: childConvId, event},
    )
}

/** 设置当前 Agent 的模型方案配置 */
export function setAgentToolConfig(): void {
    const config = runtimeConfigManager.getConfig()
    if (config.workingDir) {
        permissionEngine.setWorkingDir(config.workingDir)
    }
}
