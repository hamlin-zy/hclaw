// @vitest-environment jsdom
/**
 * reconcileStreamingContent 渲染端补全回归测试
 *
 * 缺陷：会话后台（非活跃）运行期间产生 thinking/text/tool 后切回，
 * 助手消息气泡只渲染 thinking，无正文和工具调用；要等 LLM 结束
 * （handleDone 组装完整 contentBlocks）才恢复。
 *
 * 根因：
 *   ① 块级落库惰性（段边界 + 30s 兜底）→ 切回时 DB 快照只有已 flush 的
 *      think 块（thinking→text 段边界先落库），text/tool 块仍在内存 dirty 队列；
 *   ② 非活跃期间 contentBlocks 冻结不重建（所有重建入口都有活跃会话守卫）。
 *   loadMessagesInitial 以 DB 半成品为数据源 → contentBlocks=[think×N]
 *   → InterleavedContent 新路径只渲染思考。
 *
 * 修复：reconcileStreamingContent 用 agentStore 的 streamBlocks/streamBuffer
 * 重建完整 contentBlocks 覆盖 DB 半成品；DB 无该消息时先用内存流式数据组装完整消息。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {reconcileStreamingContent} from '../../../../src/renderer/stores/agentStore/contentBlocks'

// ── mock agentStore ──
const mockConvData = vi.hoisted(() => ({
    convAgentStates: {} as Record<string, any>,
}))
vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {getState: () => mockConvData},
}))

// ── mock conversationStore ──
const writtenBlocks: Array<{convId: string; id: string; contentBlocks: any[]}> = []
const addedMessages: Array<{convId: string; message: any}> = []
const mockMessagesMap: Record<string, any[]> = {}

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            messagesMap: mockMessagesMap,
            activeConversationId: 'conv-1',
            updateMessageForConv: (convId: string, id: string, updates: any) => {
                if (updates.contentBlocks) writtenBlocks.push({convId, id, contentBlocks: updates.contentBlocks})
            },
            addMessageToConv: (convId: string, message: any) => {
                addedMessages.push({convId, message})
            },
        }),
    },
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/toolResultBatch', () => ({
    getToolResultBatchMap: () => ({}),
    flushToolResultBatch: vi.fn(),
}))

/** 运行中的流式状态：think@0 → tool_use@3，正文 6 字符（'正文A'=3 码元，tool_use 后切分） */
const RUNNING_STREAM = {
    agentState: {status: 'running' as const, mode: 'auto' as const, phase: 'streaming' as const},
    streamBuffer: '正文A正文B',
    thinkingContent: '思考内容',
    streamBlocks: [
        {type: 'think' as const, id: 'think-msg-0', textOffset: 0, thinkContent: '思考内容'},
        {type: 'tool_use' as const, id: 'tool-tc1', textOffset: 3, toolCall: {id: 'tc1', name: 'bash', arguments: {cmd: 'ls'}, status: 'running'}},
    ],
    streamingMessageId: 'msg-111',
}

describe('reconcileStreamingContent 渲染端补全', () => {
    beforeEach(() => {
        writtenBlocks.length = 0
        addedMessages.length = 0
        mockConvData.convAgentStates = {}
        for (const k of Object.keys(mockMessagesMap)) delete mockMessagesMap[k]
    })

    it('DB 半成品（仅 think 块已落库）→ 重建出含正文与工具调用的完整 contentBlocks', () => {
        // 后台运行期间段边界 flush：think 块已落库，text/tool 块滞留内存 dirty → DB 半成品
        mockMessagesMap['conv-1'] = [{
            id: 'msg-111',
            role: 'assistant',
            content: '',
            timestamp: 600,
            contentBlocks: [
                {id: 'think-msg-0', type: 'think', thinkBlock: {id: 'think-msg-0', content: '思考内容', status: 'thinking', timestamp: 600}},
            ],
        }]
        mockConvData.convAgentStates['conv-1'] = RUNNING_STREAM

        reconcileStreamingContent('conv-1')

        // 重建出完整交错 contentBlocks：think → text(正文A) → tool_use → text(正文B)
        // （think 块 textOffset=0 位于正文开头；tool_use 在 offset=4 切分正文两段）
        expect(writtenBlocks).toHaveLength(1)
        const blocks = writtenBlocks[0].contentBlocks
        expect(blocks.map((b: any) => b.type)).toEqual(['think', 'text', 'tool_use', 'text'])
        expect(blocks[0].thinkBlock?.content).toBe('思考内容')
        expect(blocks[1].text).toBe('正文A')
        expect(blocks[2].toolCall.id).toBe('tc1')
        expect(blocks[3].text).toBe('正文B')
        // 消息已存在（DB 有 think 块）→ 不重复创建
        expect(addedMessages).toHaveLength(0)
    })

    it('DB 无该消息（dirty 尚未落库）→ 先用内存流式数据组装完整消息再补全', () => {
        mockMessagesMap['conv-1'] = []
        mockConvData.convAgentStates['conv-1'] = RUNNING_STREAM

        reconcileStreamingContent('conv-1')

        expect(addedMessages).toHaveLength(1)
        const added = addedMessages[0]
        expect(added.convId).toBe('conv-1')
        expect(added.message.id).toBe('msg-111')
        expect(added.message.content).toBe('正文A正文B')
        expect(added.message.thinkBlock?.content).toBe('思考内容')
        expect(added.message.toolCalls).toHaveLength(1)
        expect(added.message.toolCalls[0].id).toBe('tc1')
        // 组装后仍触发 contentBlocks 重建（含正文与工具调用）
        expect(writtenBlocks).toHaveLength(1)
    })

    it('非运行中（idle）→ 不执行任何补全', () => {
        mockMessagesMap['conv-1'] = [{id: 'msg-111', role: 'assistant', content: '', timestamp: 600}]
        mockConvData.convAgentStates['conv-1'] = {
            ...RUNNING_STREAM,
            agentState: {status: 'idle' as const, mode: 'auto' as const, phase: 'idle' as const},
        }

        reconcileStreamingContent('conv-1')

        expect(writtenBlocks).toHaveLength(0)
        expect(addedMessages).toHaveLength(0)
    })

    it('无 streamingMessageId（无进行中消息）→ 不执行任何补全', () => {
        mockMessagesMap['conv-1'] = []
        mockConvData.convAgentStates['conv-1'] = {...RUNNING_STREAM, streamingMessageId: null}

        reconcileStreamingContent('conv-1')

        expect(writtenBlocks).toHaveLength(0)
        expect(addedMessages).toHaveLength(0)
    })
})
