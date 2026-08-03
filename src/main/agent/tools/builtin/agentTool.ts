/**
 * agent 内置工具 — 派生子 Agent 执行子任务
 *
 * 主 Agent 通过调用此工具派生子 Agent，支持：
 * - 任务描述（prompt）
 * - 可选的 agent 参数（指定子 Agent 名称，匹配后以该 Agent 身份启动）
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
import type {Tool, ToolContext, ToolResult} from '../types'
import {agentLoop} from '../../loop'
import type {AgentStreamEvent} from '../../stream'
import {logger} from '../../logger'
import {agentRegistry} from '../../agentRegistry'
import type {AgentTemplate, LlmStats, Message} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'
import {runtimeConfigManager} from '../../runtimeConfigManager'
import {systemSettingsRepo} from '../../../repositories/sqlite/systemSettingsRepository'
import {permissionEngine} from '../permission'
import {createConversationRepository} from '../../../repositories'

// ─── 并发控制 ──────────────────────────────────────────────

const activeChildSessions = new Set<string>()

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
    agent: z.string().optional()
        .describe('要作为子 Agent 运行的 Agent 名称（从 agentRegistry 中查找）'),
    tools: z.array(z.string()).optional()
        .describe('允许使用的工具白名单（指定 agent 时覆盖 Agent 定义的白名单）'),
})

type AgentToolInput = z.infer<typeof inputSchema>

// ─── 子会话 assistant 消息写入（防重复） ────────────────────

/**
 * 计算子会话完成时应写入的 assistant 消息。
 *
 * 防重复：流式期间渲染进程已把最终输出写入子会话（UUID 流式消息，含 llmStats）。
 * 若子会话已有 assistant 消息，不再追加 msg-<ts> 重复消息，只把子 Agent 自身的
 * LLM 统计补写进最后一条 assistant 消息；无已有 assistant 消息时才兜底写入完整结果。
 *
 * @returns 需要写库的消息；返回 null 表示无需写入
 */
export function resolveChildAssistantMessage(
    existingMessages: Message[],
    finalOutput: string,
    childLlmStats: LlmStats[],
    now: number,
): Message | null {
    const lastAssistant = [...existingMessages].reverse().find(m => m.role === 'assistant')

    // 已有流式 assistant 消息：仅补写 llmStats（未写过的场景）
    if (lastAssistant) {
        if (childLlmStats.length > 0 && !lastAssistant.llmStats?.length) {
            return {...lastAssistant, llmStats: childLlmStats}
        }
        return null
    }

    // 无已有 assistant 消息：兜底写入完整结果
    const assistantMsgId = `msg-${now}-${Math.random().toString(36).slice(2, 8)}`
    return {
        id: assistantMsgId,
        role: 'assistant',
        content: finalOutput,
        timestamp: now,
        ...(childLlmStats.length > 0 ? {llmStats: childLlmStats} : {}),
    }
}

// ─── 工具定义 ──────────────────────────────────────────────

export const agentTool: Tool<AgentToolInput, string> = {
    name: 'agent',
    description:
        '派生专门子 Agent 执行子任务。子 Agent 拥有独立的推理循环和工具访问权限。' +
        '需要并行时，由主 Agent 在同一轮对话中同时调用多个 agent 工具实现。' +
        '通过 agent 参数指定子 Agent 名称（从 agentRegistry 中查找），' +
        'tools 参数可覆盖 Agent 定义的工具白名单。\n' +
        '注意：superpowers 等三方插件的模板语法 `Subagent (general-purpose)` 是 Claude Code 生态的' +
        '通用子代理写法，HClaw 中不存在同名 Agent。派发时应根据任务类型从可用能力列表中' +
        '选择专用 Agent——实现任务 → "Implementer Agent"、代码审查 → "Code Reviewer Agent"，' +
        '不要照搬模板名；未知名会回退 General Agent。',
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

        // ② 解析 agent → 转换为 AgentDefinition
        let agentDefinition: AgentDefinition | undefined
        const agentName = args.agent || 'General'
        if (args.agent) {
            const template = agentRegistry.find(args.agent)
            if (template) {
                agentDefinition = agentTemplateToDefinition(template)
            } else {
                logger.warn(`[AgentTool] agent "${args.agent}" not found, falling back to General`)
            }
        }

        // ③ tools 覆盖：同时指定 agent 和 tools 时，tools 覆盖 Agent 定义的白名单
        if (agentDefinition && args.tools) {
            agentDefinition = {...agentDefinition, tools: args.tools}
        }

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

        // ⑦ 强制权限模式为 auto（子会话不弹确认框）
        const effectiveAgentDef: AgentDefinition = {
            source: 'user' as const,
            agentType: agentName,
            whenToUse: agentDefinition?.whenToUse || '',
            description: agentDefinition?.description || '',
            systemPromptTemplate: agentDefinition?.systemPromptTemplate || '',
            renderedSystemPrompt: '',
            tools: agentDefinition?.tools || args.tools,
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
        // 收集子会话各轮 LLM 调用统计（写入子会话自身 assistant 消息，供 input-toolbar-cache-rate 展示）
        const childLlmStats: LlmStats[] = []

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
            })) {
                // ── 跳过内部事件 ──
                if (event.type === 'intent_analyzed' || event.type === 'mode_change') continue

                // ── 累积文本输出 ──
                if (event.type === 'text') {
                    output += event.content
                }

                // ── 事件分类转发给父上下文 ──
                if (event.type === 'llm_call_done') {
                    // 收集子会话自身各轮 LLM 调用统计，随 assistant 消息持久化
                    childLlmStats.push(toLlmStats(event))
                } else if (event.type === 'thinking' || event.type === 'tool_start' || event.type === 'tool_progress' || event.type === 'tool_result') {
                    context.sendMessage({
                        type: 'subagent_progress',
                        taskId: childConvId,
                        progress: formatProgress(event),
                        subAgentStreamEvent: event,
                    })
                } else if (event.type === 'done') {
                    context.sendMessage({type: 'subagent_done', taskId: childConvId, success: true, output})
                    sendChildAgentEvent(childConvId, {type: 'done', reason: 'completed'})
                    break
                } else if (event.type === 'error') {
                    hasError = true
                    errorMsg = event.error || '未知错误'
                    context.sendMessage({type: 'subagent_done', taskId: childConvId, success: false, error: errorMsg})
                    sendChildAgentEvent(childConvId, {type: 'done', reason: 'error'})
                    break
                }

                // ★ 转发所有流事件到子会话渲染进程（text/thinking/tool_*/agent_start 等）
                //   用户切换到子会话时可以看到实时流式输出
                sendChildAgentEvent(childConvId, event)
            }
        } catch (err: any) {
            hasError = true
            errorMsg = err.message || String(err)
            logger.error('[AgentTool]', {action: 'childConvException', childConvId, error: errorMsg})
            // ★ 异常也通知渲染进程结束运行状态
            sendChildAgentEvent(childConvId, {type: 'done', reason: 'error'})
        } finally {
            activeChildSessions.delete(childConvId)
        }

        // ⑩ 写入子会话的辅助消息历史
        const finalOutput = (hasError ? '' : output.trim()) || '(无输出)'
        // ★ 防重复：流式期间渲染进程已把最终输出写入子会话（streamingMessageId 消息，含 llmStats）。
        //   若子会话已有 assistant 消息（UUID 流式消息），不再追加 msg-<ts> 重复消息，
        //   只把子 Agent 自身的 LLM 统计补写进最后一条 assistant 消息。
        const childAssistant = resolveChildAssistantMessage(
            conversationRepo.readMessages(childConvId),
            finalOutput,
            childLlmStats,
            Date.now(),
        )
        if (childAssistant) {
            conversationRepo.writeMessages(childConvId, [childAssistant])
        }

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

/** 将 llm_call_done 事件映射为持久化的 LlmStats 记录 */
function toLlmStats(event: Extract<AgentStreamEvent, {type: 'llm_call_done'}>): LlmStats {
    return {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        provider: event.provider,
        model: event.model,
        duration: event.duration,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        reasoningTokens: event.reasoningTokens,
    }
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
        const {parentPort} = require('worker_threads')
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage({type: workerType, ...workerPayload})
            return
        }
    } catch {
        // not in Worker
    }
    try {
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
