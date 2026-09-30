// @vitest-environment jsdom
/**
 * streamBlocks 同 textOffset tie-break 确定性测试（feat/block-order-turnindex）
 *
 * 背景：textOffset = 事件到达时正文长度。子会话（只发工具调用、正文近空）的块
 * textOffset 高度重复 → 排序退化为 tie-break。渲染端三条重建路径（流式重建 /
 * done 收尾 / abort 收尾）须与主进程参照实现（childConvMessages 落库排序）同款：
 *   (a.textOffset - b.textOffset) || (a.timestamp - b.timestamp)
 *
 * 判别力：输入顺序与 timestamp 顺序故意打乱。旧实现（仅按 textOffset 排序，
 * Array.prototype.sort 稳定）同 offset 下保留输入顺序 → 断言 1 必 fail；
 * 新实现同 offset 按 timestamp 升序 → pass。
 * 零行为变化：offset 单调递增的稳定场景下，新实现输出与改动前实现完全一致
 * （断言 3 按旧实现语义手写期望序列，对新实现断言）。
 *
 * 说明：断言走导出的 updateMessageContentBlocks（内部即 assembleContentBlocks），
 * mock 风格与 contentBlocks.stability.test.ts 一致。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {updateMessageContentBlocks} from '../../../../src/renderer/stores/agentStore/contentBlocks'

const mockConvData = vi.hoisted((): {
    convAgentStates: Record<string, any>
    agentState: {status: string}
} => ({
    convAgentStates: {},
    agentState: {status: 'idle'},
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockConvData,
    },
}))

// 记录每次 updateMessageForConv 写入的 contentBlocks
const writtenBlocks: Array<{contentBlocks: any[]}> = []
const mockMessage = {
    id: 'msg-1',
    role: 'assistant' as const,
    content: '',
    toolCalls: [],
}

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            messagesMap: {'conv-1': [mockMessage]},
            activeConversationId: 'conv-1',
            updateMessageForConv: (_convId: string, _id: string, updates: any) => {
                if (updates.contentBlocks) writtenBlocks.push({contentBlocks: updates.contentBlocks})
            },
        }),
    },
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/toolResultBatch', () => ({
    getToolResultBatchMap: () => ({}),
    flushToolResultBatch: vi.fn(),
}))

const mkConv = (over: Record<string, any> = {}) => ({
    agentState: {status: 'running', mode: 'auto', phase: 'streaming'},
    streamBuffer: '',
    thinkingContent: null,
    streamBlocks: [],
    streamingMessageId: 'msg-1',
    isThinkingAfterTools: false,
    runningToolCount: 0,
    pendingQuestion: null,
    toolPopupData: null,
    pendingPermissionConfirm: null,
    tasks: [],
    intentResult: null,
    errorMessage: null,
    executingToolsMessage: null,
    pendingMessages: [],
    ...over,
})

// 判别力场景：3 块，textOffset 为 0/0/5（前两块同 offset），timestamp 互异，
// 输入数组顺序与 timestamp 顺序故意打乱（tool-b@200 排在 think-a@100 之前）
const TIE_BREAK_BLOCKS = [
    {type: 'tool_use' as const, id: 'tool-b', textOffset: 0, timestamp: 200,
     toolCall: {id: 'tool-b', name: 'bash', arguments: {}, status: 'running' as const, textOffset: 0}},
    {type: 'think' as const, id: 'think-a', textOffset: 0, timestamp: 100, thinkContent: '思考-a'},
    {type: 'think' as const, id: 'think-c', textOffset: 5, timestamp: 300, thinkContent: '思考-c'},
]
const TIE_BREAK_FULL_TEXT = 'a'.repeat(5) + 'b'.repeat(5) + 'c'.repeat(5)

describe('streamBlocks 同 textOffset 按 timestamp 升序 tie-break', () => {
    beforeEach(() => {
        writtenBlocks.length = 0
        ;mockConvData.convAgentStates = {}
        vi.clearAllMocks()
    })

    it('同 textOffset 块输入顺序打乱时，输出仍按 timestamp 升序（判别力：旧实现 fail）', () => {
        ;mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: TIE_BREAK_FULL_TEXT,
            streamBlocks: TIE_BREAK_BLOCKS,
        })
        updateMessageContentBlocks('conv-1')

        expect(writtenBlocks).toHaveLength(1)
        const blocks = writtenBlocks[0].contentBlocks
        const seq = blocks.map(cb => cb.id)
        // 同 offset 的 think-a(ts=100) 必须排在 tool-b(ts=200) 之前（输入顺序相反）
        expect(seq).toEqual([
            'think-a',                       // ts=100，offset 0
            'tool-b',                        // ts=200，offset 0
            'text-msg-1-0',                  // text slice(0,5) = 'aaaaa'
            'think-c',                       // ts=300，offset 5
            'text-msg-1-5',                  // 尾部 slice(5) = 'bbbbbcc...cc'
        ])
        expect(blocks[2].text).toBe('a'.repeat(5))
        expect(blocks[4].text).toBe('b'.repeat(5) + 'c'.repeat(5))
    })

    it('块之间正文切片不重叠、不丢字（fullText 全量被 text 块覆盖）', () => {
        ;mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: TIE_BREAK_FULL_TEXT,
            streamBlocks: TIE_BREAK_BLOCKS,
        })
        updateMessageContentBlocks('conv-1')

        const textBlocks = writtenBlocks[0].contentBlocks.filter(cb => cb.type === 'text')
        const covered = textBlocks.map(cb => cb.text).join('')
        // 全量覆盖：text 块拼接 === fullText（切片为顺序连续区间，拼接相等即证明不重叠、不丢字）
        expect(covered).toBe(TIE_BREAK_FULL_TEXT)
    })

    it('稳定场景（offset 单调递增）输出与改动前实现一致（零行为变化）', () => {
        // offset 0/5/10 严格单调递增：旧实现（仅按 textOffset 排序）输出确定的期望序列，
        // 新实现在该场景下必须与其逐块一致（含 id 与 text 内容）
        const stableBlocks = [
            {type: 'think' as const, id: 'think-d', textOffset: 0, timestamp: 10, thinkContent: '思考-d'},
            {type: 'tool_use' as const, id: 'tool-e', textOffset: 5, timestamp: 20,
             toolCall: {id: 'tool-e', name: 'grep', arguments: {}, status: 'running' as const, textOffset: 5}},
            {type: 'think' as const, id: 'think-f', textOffset: 10, timestamp: 30, thinkContent: '思考-f'},
        ]
        const stableText = 'A'.repeat(5) + 'B'.repeat(5) + 'C'.repeat(10)
        ;mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: stableText,
            streamBlocks: stableBlocks,
        })
        updateMessageContentBlocks('conv-1')

        // 旧实现（按 textOffset 排序，offset 单调时输出即此序列）
        expect(writtenBlocks[0].contentBlocks.map(cb => cb.id)).toEqual([
            'think-d',
            'text-msg-1-0',
            'tool-e',
            'text-msg-1-5',
            'think-f',
            'text-msg-1-10',
        ])
        expect(writtenBlocks[0].contentBlocks.map(cb => (cb as any).text ?? '')).toEqual([
            '',
            'A'.repeat(5),
            '',
            'B'.repeat(5),
            '',
            'C'.repeat(10),
        ])
    })
})
