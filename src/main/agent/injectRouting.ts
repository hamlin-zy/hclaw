/**
 * 注入用户消息路由（Worker 侧）
 *
 * 从 worker.ts 的 INJECT_USER_MESSAGE 分支提取，便于单测覆盖路由语义：
 * - 本 Worker 会话 → 存入 pendingInjectedMessages 供 Controller 每轮读取
 * - 其他会话 → 运行中的子会话（agentTool in-process loop），经 agentTool
 *   注册表入队（父会话在本 Worker 中运行的场景，见 manager.impl 路径 3 广播）
 */
import type {ChatMessage} from './model/types'

export async function routeInjectedUserMessage(
    msg: {convId?: string; message?: {content?: string; id?: string}},
    selfConvId: string,
    pendingInjectedMessages: ChatMessage[],
): Promise<void> {
    if (!msg.message) return
    const targetConvId = msg.convId || selfConvId
    if (targetConvId === selfConvId) {
        pendingInjectedMessages.push({
            role: 'user',
            content: msg.message.content || '',
            id: msg.message.id || `inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })
    } else {
        const {injectChildMessage} = await import('./tools/builtin/agentTool')
        injectChildMessage(targetConvId, msg.message.content || '', msg.message.id)
    }
}
