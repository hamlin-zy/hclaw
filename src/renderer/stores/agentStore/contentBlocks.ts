// ── ContentBlocks 构建 ──────────────────────────────────

import type {ContentBlock, ToolCall} from '@shared/types'
import {useAgentStore} from '.'
import {useConversationStore} from '../conversationStore'
import {createDefaultConvData} from './defaultState'
import {flushToolResultBatch, getToolResultBatchMap} from './batching/toolResultBatch'

// ═══════════════════════════════════════════════════════════
// 流式重建稳定性
//
// 此前 text 块 id 用 crypto.randomUUID() 生成，每次重建 contentBlocks 时
// 所有 text 块 id 都会变化，导致 React 无法按 key 复用 DOM，消息气泡在
// 流式期间每次 IPC 都整块重挂载（思考块全文重新渲染 + 布局抖动），
// 是高 chunk 频率下 UI 卡死/崩溃的重要放大器。
//
// 修复：text 块 id 改为「流式消息 id + 文本起始偏移」派生，同一消息的
// 同一文本区间在任何重建中 id 恒定；仅新增区间产生新 id。非流式消息
// （无 streamingMessageId）回退为 offset 派生，同样稳定。
// ═══════════════════════════════════════════════════════════

/**
 * 派生稳定的 text 块 id（done/abort 组装路径与流式重建路径统一使用，
 * 避免 completion/abort 路径仍用 randomUUID 导致 id 永久分叉）。
 * @param prefix 消息标识（优先 streamingMessageId）
 * @param offset 文本块在全文中的起始偏移
 */
export function textBlockId(prefix: string | null, offset: number): string {
    return `text-${prefix || 'msg'}-${offset}`
}

/** 流式块原始形态（来自 convAgentStates.streamBlocks） */
interface StreamBlockEntry {
    type: string
    id: string
    textOffset: number
    thinkContent?: string
    thinkSignature?: string
    toolCall?: ToolCall | null
}

/**
 * 纯函数：从 streamBlocks + streamBuffer 组装 ContentBlock[]。
 * 供 done/abort/流式重建三路径共用，保证排序一致性和 id 稳定性。
 */
export function assembleContentBlocks(params: {
    streamingMsgId: string | null
    streamBlocks: StreamBlockEntry[]
    fullText: string
    toolCallMap: Map<string, ToolCall>
    thinkStatus: 'thinking' | 'complete'
    thinkTimestamp: number
}): ContentBlock[] {
    const {streamingMsgId, streamBlocks, fullText, toolCallMap, thinkStatus, thinkTimestamp} = params
    if (!streamingMsgId || streamBlocks.length === 0) return []

    const sorted = [...streamBlocks].sort((a, b) => a.textOffset - b.textOffset)
    const assembled: ContentBlock[] = []
    let lastOffset = 0

    for (const sb of sorted) {
        if (sb.textOffset > lastOffset) {
            const textSlice = fullText.slice(lastOffset, sb.textOffset)
            if (textSlice) {
                assembled.push({id: textBlockId(streamingMsgId, lastOffset), type: 'text', text: textSlice})
            }
        }
        if (sb.type === 'think') {
            assembled.push({
                id: sb.id, type: 'think',
                thinkBlock: {
                    id: sb.id, content: sb.thinkContent || '', status: thinkStatus, timestamp: thinkTimestamp,
                    ...(sb.thinkSignature ? {signature: sb.thinkSignature} : {}),
                },
            })
        } else if (sb.type === 'tool_use' && sb.toolCall) {
            const latestTc = toolCallMap.get(sb.toolCall.id) || sb.toolCall
            assembled.push({id: sb.id, type: 'tool_use', toolCall: latestTc})
        }
        if (sb.textOffset > lastOffset) lastOffset = sb.textOffset
    }

    if (lastOffset < fullText.length) {
        const remaining = fullText.slice(lastOffset)
        if (remaining) assembled.push({id: textBlockId(streamingMsgId, lastOffset), type: 'text', text: remaining})
    }
    return assembled
}

/**
 * 从 streamBlocks + streamBuffer 重建 contentBlocks
 *
 *  关键修复：
 *   1. 按 textOffset 排序 streamBlocks，保证处理顺序正确
 *   2. lastOffset 只增不减（Math.max），防止乱序 streamBlock 导致 textOffset 回退
 *   3. 工具结果更新后重新调用以刷新 tool 状态
 *   4. text 块 id 稳定派生（见上方注释），流式期间避免 React 重挂载
 */
export function updateMessageContentBlocks(convId?: string) {
    const targetConvId = convId || useConversationStore.getState().activeConversationId
    if (!targetConvId) return
    const convData = useAgentStore.getState().convAgentStates[targetConvId] || createDefaultConvData()
    const {streamBlocks, streamBuffer, streamingMessageId} = convData
    if (!streamingMessageId || streamBlocks.length === 0) return

    // 刷新待处理的工具结果批处理，确保 messagesMap 包含最新数据
    const pendingBatch = getToolResultBatchMap()[targetConvId]
    if (pendingBatch && pendingBatch.size > 0) {
        flushToolResultBatch(targetConvId)
    }

    // 从 messagesMap 构建 toolCallMap（含 result）
    const convMsgs = useConversationStore.getState().messagesMap[targetConvId] || []
    const currentMsg = convMsgs.find(m => m.id === streamingMessageId)
    const toolCallMap = new Map<string, ToolCall>()
    if (currentMsg?.toolCalls) {
        for (const tc of currentMsg.toolCalls) toolCallMap.set(tc.id, tc)
    }

    const assembled = assembleContentBlocks({
        streamingMsgId: streamingMessageId,
        streamBlocks: streamBlocks as Parameters<typeof assembleContentBlocks>[0]['streamBlocks'],
        fullText: streamBuffer,
        toolCallMap,
        thinkStatus: 'thinking',
        thinkTimestamp: Date.now(),
    })

    if (assembled.length > 0) {
        useConversationStore.getState().updateMessageForConv(targetConvId, streamingMessageId, {
            contentBlocks: assembled,
        })
    }
}

/**
 * 运行中会话切换/加载后的渲染端补全（根因修复）。
 *
 * 背景：切回后台（非活跃）运行中的会话时，消息气泡只渲染 thinking、
 * 无正文/工具调用，要等 LLM 结束才恢复。两个成因叠加：
 *   ① 块级落库惰性（段边界 + 30s 兜底，见 conversationStore.scheduleDeltaSave）
 *      → DB 快照只有已 flush 的 think 块（thinking→text 段边界先落库），
 *      text/tool 块仍滞留渲染进程 dirty 队列 → loadMessagesInitial 读半成品；
 *   ② 非活跃期间 contentBlocks 冻结不重建（所有重建入口都有活跃会话守卫）。
 *   半成品消息 contentBlocks=[think×N] → InterleavedContent 新路径只渲染思考。
 *
 * 修复：用 agentStore 的 streamBlocks/streamBuffer 重建完整 contentBlocks，
 * 覆盖 DB/内存中的半成品快照；DB 尚无该消息时（dirty 未落库）先用内存
 * 流式数据组装完整消息。LLM 结束后 handleDone 本就会组装完整 contentBlocks，
 * 本函数使运行中切换即刻获得相同效果。
 */
export function reconcileStreamingContent(convId: string): void {
    const convData = useAgentStore.getState().convAgentStates[convId]
    const msgId = convData?.streamingMessageId
    const status = convData?.agentState?.status
    // paused + pending 双态（ask_user / permission_confirm 阻塞）视同运行中：
    // 阻塞等输入时同样需要重建 contentBlocks，否则进入会话只显示 DB 陈旧半成品
    const isBlockedPending = status === 'paused'
        && !!(convData?.pendingQuestion || convData?.pendingPermissionConfirm)
    if (!msgId || (status !== 'running' && status !== 'thinking' && !isBlockedPending)) return

    const convStore = useConversationStore.getState()
    const msgs = convStore.messagesMap[convId] || []
    if (!msgs.some(m => m.id === msgId)) {
        // 内存中无该消息（dirty 尚未落库）→ 用流式数据组装完整消息（含 thinkBlock/toolCalls）
        const toolCalls: ToolCall[] = []
        for (const sb of convData.streamBlocks) {
            const toolCall = sb.type === 'tool_use' ? sb.toolCall : undefined
            if (toolCall && !toolCalls.some(t => t.id === toolCall.id)) {
                toolCalls.push(toolCall)
            }
        }
        convStore.addMessageToConv(convId, {
            id: msgId,
            role: 'assistant',
            content: convData.streamBuffer || '',
            ...(convData.thinkingContent ? {
                thinkBlock: {
                    id: `think-${msgId}`,
                    content: convData.thinkingContent,
                    status: 'thinking' as const,
                    timestamp: Date.now(),
                },
            } : {}),
            toolCalls,
        })
    }
    updateMessageContentBlocks(convId)
}
