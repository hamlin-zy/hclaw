/**
 * Agent 执行 IPC handlers
 *
 * 处理 Agent 的启动、中止、消息注入、状态查询、用户确认响应
 */

import {ipcMain} from 'electron'
import type {LlmStats} from '@shared/types'
import {agentManager} from '../manager'
import {logger} from '../logger'
import {startAgentCore} from '../startAgentCore'

export {isDuplicatePendingUserMessage} from '../startAgentCore'

export function registerHandlers(): void {
    // 启动 Agent（配置从全局获取；上下文重建逻辑统一在 startAgentCore）
    ipcMain.handle('agent-start', async (_event, params: {
        conversationId: string
        message: string
        messageAttachments?: Array<{path: string; name: string}>
        /** 消息元数据（如命令模板等） */
        messageMetadata?: Record<string, unknown>
    }) => {
        try {
            await startAgentCore(params, 'renderer')
            return {success: true}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 中止 Agent
    ipcMain.handle('agent-abort', async (_event, conversationId: string) => {
        await agentManager.abort(conversationId)
        return {success: true}
    })

    // 注册渲染端占位消息 id（ensureStreamingMessage 创建空占位后上报）。
    // 主进程 pending 累积复用该 id，消除双 id 双写（幽灵消息根因）
    ipcMain.handle('agent-register-streaming-message', (_event, conversationId: string, messageId: string) => {
        if (typeof conversationId !== 'string' || typeof messageId !== 'string' || !messageId) return false
        agentManager.registerStreamingMessage(conversationId, messageId)
        return true
    })

    // 向运行中的 Agent 注入用户消息（不中断当前执行）
    ipcMain.handle('agent-inject-message', async (_event, params: {
        conversationId: string
        content: string
        messageId?: string
    }) => {
        const injected = agentManager.injectMessage(params.conversationId, params.content, params.messageId)
        return {success: injected}
    })

    // 渲染端"这是误判"：静默指定会话的循环检测指纹
    ipcMain.handle('agent-loop-silence', (_event, conversationId: string, fingerprint: string) => {
        if (typeof conversationId !== 'string' || typeof fingerprint !== 'string' || !fingerprint) return {success: false}
        agentManager.silenceLoopPattern(conversationId, fingerprint)
        return {success: true}
    })

    // 查询运行状态
    ipcMain.handle('agent-status', async (_event, conversationId?: string) => {
        if (conversationId) {
            return {
                running: agentManager.isRunning(conversationId),
                allRunning: agentManager.getRunningConversations(),
            }
        }
        return {
            running: false,
            allRunning: agentManager.getRunningConversations(),
        }
    })

    // 崩溃恢复流快照（P1）：渲染端 recoverSessions 拉取活跃流的权威状态
    ipcMain.handle('agent-stream-snapshot', async (_event, conversationId: string) => {
        return agentManager.getStreamSnapshot(conversationId)
    })

    // 响应用户确认
    ipcMain.handle('agent-respond-confirmation', async (_event, params: {
        conversationId: string
        requestId: string
        result: 'allow' | 'always' | 'deny'
    }) => {
        agentManager.respondConfirmation(params.conversationId, params.requestId, params.result)
        return {success: true}
    })

    // 响应用户提问的回答
    ipcMain.handle('agent-respond-ask-user', async (_event, params: {
        conversationId: string
        requestId: string
        answer: string
    }) => {
        agentManager.respondAskUser(params.conversationId, params.requestId, params.answer)
        return {success: true}
    })

    // ── 消息 LLM 统计更新 ──
    ipcMain.handle('message:updateLlmStats', async (_event, params: {
        conversationId: string
        messageId: string
        llmStats: LlmStats[]
    }) => {
        try {
            const {createConversationRepository} = await import('../../repositories')
            const repo = createConversationRepository()
            return repo.updateMessageLlmStats(params.conversationId, params.messageId, params.llmStats)
        } catch (err) {
            logger.error('[IPC] message:updateLlmStats failed', {error: err})
            return false
        }
    })
}
