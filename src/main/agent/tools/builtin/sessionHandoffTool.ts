/**
 * session_handoff 内置工具 — 创建新会话并交接当前任务
 *
 * 当当前会话上下文过长、LLM 智力下降时使用。
 * 调用前需在对话中已生成当前任务的结构化交接总结。
 * 工具将创建新的独立会话，将交接总结作为新会话首条用户消息写入，
 * 并在新会话中自动启动 Agent 从总结处继续工作。
 *
 * 执行策略：
 * - 同步部分（本工具，立即返回）：创建会话 → 写总结消息 → 通知渲染进程新增+自动切换
 *   → 通知主进程为新会话启动独立 Worker。工具不等待新会话首轮运行完成。
 * - 异步部分（主进程 AgentManager.start）：为新会话创建独立 Worker 运行首轮，
 *   事件走标准 agent-stream 通道（begin → 流式 → done），与桌面端"新会话首条指令"同链路。
 * - 用户在新会话发消息时，AgentManager.start 会自动 abort 交接 Worker 并重建，
 *   新旧运行天然隔离，无并发冲突。
 * - 差异：meta 不设 parentConvId/isChildSession（独立顶层父会话）。
 */

import {z} from 'zod'
import {randomUUID} from 'crypto'
import {parentPort} from 'worker_threads'
import type {Tool, ToolResult} from '../types'
import type {ChatMessage} from '../../model/types'
import {logger} from '../../logger'

const inputSchema = z.object({
    title: z.string()
        .min(1, '新会话标题不能为空')
        .describe('新会话标题，应包含任务主题（如"XX功能开发-阶段2"）'),
    handoffSummary: z.string()
        .min(1, '交接总结不能为空')
        .describe(
            '交接总结全文，将作为新会话的首条用户消息。必须包含以下结构：\n'
            + '## 任务目标（一句话描述当前任务）\n'
            + '## 已完成进度（关键里程碑，引用文件/命令）\n'
            + '## 遗留问题（当前阻塞点 / 未完成事项）\n'
            + '## 下一步计划（新会话应从何处继续，明确第一步动作）\n'
            + '## 关键上下文（相关文件路径 / 已运行命令 / 重要决策 / 注意事项）'
        ),
})

type SessionHandoffInput = z.infer<typeof inputSchema>

export const sessionHandoffTool: Tool<SessionHandoffInput, string> = {
    name: 'session_handoff',
    description:
        '当当前会话上下文过长、LLM 智力下降时使用。'
        + '调用前需在对话中已生成当前任务的结构化交接总结。'
        + '工具将创建新的独立会话，将交接总结作为新会话首条用户消息写入，'
        + '并在新会话中自动启动 Agent 从总结处继续工作。',
    inputSchema,
    isDestructive: false,

    async execute(args, context): Promise<ToolResult<string>> {
        // ① 检查模型配置
        const {runtimeConfigManager} = await import('../../runtimeConfigManager')
        const primary = runtimeConfigManager.getPrimaryProvider()
        if (!primary.isValid) {
            return {success: false, output: '', error: '模型配置未初始化'}
        }

        // ② 获取父会话 workspacePath（新会话继承工作区）
        const {createConversationRepository} = await import('../../../repositories')
        const conversationRepo = createConversationRepository()
        const parentConvId = context.conversationId
        let workspacePath = ''
        if (parentConvId) {
            const parentMeta = conversationRepo.readMeta(parentConvId)
            workspacePath = parentMeta?.workspacePath || ''
        }

        // ③ 创建新会话 meta（无 parentConvId / isChildSession → 独立顶层父会话）
        const newConvId = `conv-${randomUUID()}`
        const now = Date.now()

        const meta = {
            id: newConvId,
            title: args.title,
            workspacePath,
            createdAt: now,
            updatedAt: now,
            preview: '',
            status: 'active' as const,
        }
        if (!conversationRepo.create(newConvId, meta)) {
            return {success: false, output: '', error: '创建新会话失败'}
        }

        // ④ 写入首条 user 消息（交接总结）
        const userMsgId = `msg-${now}-${Math.random().toString(36).slice(2, 8)}`
        const userMsg = {
            id: userMsgId,
            role: 'user' as const,
            content: args.handoffSummary,
            timestamp: now,
        }
        if (!conversationRepo.writeMessages(newConvId, [userMsg])) {
            return {success: false, output: '', error: '写入交接总结失败'}
        }

        // ⑤ 通知渲染进程：侧栏新增会话 + 自动切换 activeConversationId
        notifySessionCreated(newConvId, args.title, workspacePath)

        // ⑥ 通知主进程为新会话启动独立 Agent Worker（交接首轮运行）
        //    工具立即返回，不等待首轮完成；新会话的运行由 AgentManager 管理，
        //    模型配置由主进程从 runtimeConfigManager 组装（含 API key 的完整方案）。
        const startRequested = requestHandoffStart(newConvId, args.title, userMsg, workspacePath)

        logger.info('[SessionHandoffTool]', {
            action: 'handoffCreated',
            newConvId,
            parentConvId: parentConvId || '(none)',
            title: args.title,
            autoStart: startRequested,
        })

        return {
            success: true,
            output: `新会话『${args.title}』已创建，交接总结已注入，Agent 已自动启动继续工作。`
                + (startRequested ? '' : '\n（自动启动未成功，可切换到新会话手动发送消息继续）'),
        }
    },
}

/** 通用双路径发送：Worker → parentPort → 主进程；主进程直接 IPC */
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
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- sessionHandoffTool 运行在 MCP Worker 上下文，顶层 import window.ts 会把 electron 拉进 worker bundle
        const {getMainWindow} = require('../../../window')
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
            win.webContents.send(mainChannel, mainPayload)
        }
    } catch {
        // window not available
    }
}

/** 通知渲染进程新增独立会话（自动切换） */
function notifySessionCreated(convId: string, title: string, workspacePath: string): void {
    sendToRenderer(
        'session_created',
        {convId, title, workspacePath},
        'session_created',
        {id: convId, title, workspacePath},
    )
}

/**
 * 通知主进程为新会话启动独立 Agent Worker（交接首轮运行）。
 * 主进程 AgentManager.start 负责创建 Worker 并组装模型方案（schemeConfig）。
 * 返回是否成功发出请求（Worker 是否实际启动由主进程异步决定）。
 */
function requestHandoffStart(convId: string, title: string, message: ChatMessage, workingDir: string): boolean {
    const payload = {
        convId,
        title,
        messages: [message],
        workingDir,
    }
    try {
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage({type: 'session_handoff_start', ...payload})
            return true
        }
    } catch (err) {
        logger.error('[SessionHandoffTool]', {action: 'requestHandoffStartError', convId, error: String(err)})
    }
    logger.error('[SessionHandoffTool]', {action: 'requestHandoffStartNotInWorker', convId})
    return false
}
