// @vitest-environment jsdom
/**
 * updateMessageContentBlocks 稳定性测试
 *
 * 保护：流式期间 contentBlocks 重建时 text 块 id 必须稳定派生（不得使用
 * randomUUID），否则 React 无法按 key 复用 DOM，导致消息气泡整块重挂载——
 * 这是高 chunk 频率下 UI 卡死/崩溃的关键放大器（详见 contentBlocks.ts 注释）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {updateMessageContentBlocks} from '../../../../src/renderer/stores/agentStore/contentBlocks'

const mockConvData = vi.hoisted((): {
    convAgentStates: Record<string, any>
    agentState: {status: string}
    updateConvData?: (convId: string, patch: any) => void
    updateMessageContentBlocks?: (...args: any[]) => void
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
const writtenBlocks: Array<{contentBlocks: any[]; thinkBlock?: any}> = []
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

const mkConv = (over: Partial<typeof mockConvData.convAgentStates[string]> = {}) => ({
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

describe('updateMessageContentBlocks 稳定 id', () => {
    beforeEach(() => {
        writtenBlocks.length = 0
        vi.clearAllMocks()
    })

    it('同一文本区间在多次重建中 id 恒定（不随 randomUUID 变化）', () => {
        // 场景：think 块 textOffset=0，后续 100 字符文本流式追加
        mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: 'A'.repeat(40) + 'B'.repeat(60),
            streamBlocks: [
                {type: 'think', id: 'think-1', textOffset: 0, thinkContent: '思考中'},
            ],
        })

        // 第一次重建
        updateMessageContentBlocks('conv-1')
        // 第二次重建（模拟后续 chunk 到达，内容增长——textOffset 不变）
        mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: 'A'.repeat(40) + 'B'.repeat(80),
            streamBlocks: [
                {type: 'think', id: 'think-1', textOffset: 0, thinkContent: '思考中...'},
            ],
        })
        updateMessageContentBlocks('conv-1')

        expect(writtenBlocks).toHaveLength(2)
        const first = writtenBlocks[0].contentBlocks
        const second = writtenBlocks[1].contentBlocks

        // 两次重建都应产出：think 块 + 尾部文本块
        const think1 = first.find(cb => cb.type === 'think')
        const text1 = first.find(cb => cb.type === 'text')
        const think2 = second.find(cb => cb.type === 'think')
        const text2 = second.find(cb => cb.type === 'text')
        expect(think1).toBeTruthy()
        expect(text1).toBeTruthy()
        expect(think2).toBeTruthy()
        expect(text2).toBeTruthy()

        // ★ 核心断言：think 块 id 与 text 块 id 在两次重建中均保持稳定
        expect(think2.id).toBe(think1.id)
        expect(text2.id).toBe(text1.id)
        // 且 text 块 id 应带消息前缀（稳定派生，而非随机 uuid）
        expect(text1.id).toMatch(/^text-msg-1-\d+$/)
    })

    it('追加新文本区间时仅新增 id，既有 id 保持稳定', () => {
        // 场景：无 think 块，纯文本流式追加（text 块 0..40 稳定，40 之后新增）
        mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: 'A'.repeat(40),
            streamBlocks: [],
        })
        updateMessageContentBlocks('conv-1')
        expect(writtenBlocks).toHaveLength(0) // streamBlocks 为空 → 直接 return，无写入

        // 有 streamBlock 锚点（think 块在 offset 40）时才会重建
        mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: 'A'.repeat(40) + 'C'.repeat(20),
            streamBlocks: [
                {type: 'think', id: 'think-x', textOffset: 40, thinkContent: 't'},
            ],
        })
        updateMessageContentBlocks('conv-1')
        mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: 'A'.repeat(40) + 'C'.repeat(50),
            streamBlocks: [
                {type: 'think', id: 'think-x', textOffset: 40, thinkContent: 't..'},
            ],
        })
        updateMessageContentBlocks('conv-1')

        const first = writtenBlocks[0].contentBlocks
        const second = writtenBlocks[1].contentBlocks
        const textBefore1 = first.find(cb => cb.type === 'text' && cb.text === 'A'.repeat(40))
        const textBefore2 = second.find(cb => cb.type === 'text' && cb.text === 'A'.repeat(40))
        const tail1 = first.find(cb => cb.type === 'text' && cb.text === 'C'.repeat(20))
        const tail2 = second.find(cb => cb.type === 'text' && cb.text === 'C'.repeat(50))

        // 稳定区间 id 恒定
        expect(textBefore2!.id).toBe(textBefore1!.id)
        // ★ tail 区间起始偏移相同（40），id 同样恒定——React 按 key 复用 DOM、
        //   仅更新文本节点（追加文本不重挂载，这正是稳定 id 的核心收益）；
        //   真正的保障是 id 不随机，而非随内容变化
        expect(tail2!.id).toBe(tail1!.id)
        expect(tail1!.id).toMatch(/^text-msg-1-40$/)
        expect(tail2!.text).toBe('C'.repeat(50))
    })

    it('乱序 streamBlocks 仍按 textOffset 排序重建', () => {
        mockConvData.convAgentStates['conv-1'] = mkConv({
            streamBuffer: 'A'.repeat(10) + 'B'.repeat(10) + 'C'.repeat(10),
            streamBlocks: [
                {type: 'think', id: 'think-2', textOffset: 20, thinkContent: 'c区'},
                {type: 'think', id: 'think-1', textOffset: 10, thinkContent: 'b区'},
            ],
        })
        updateMessageContentBlocks('conv-1')
        const blocks = writtenBlocks[0].contentBlocks
        // 期望顺序：text(0..10) → think-1 → text(10..20) → think-2 → text(20..30)
        expect(blocks[0].type).toBe('text')
        expect(blocks[0].text).toBe('A'.repeat(10))
        expect(blocks[1]).toMatchObject({type: 'think', id: 'think-1'})
        expect(blocks[2].text).toBe('B'.repeat(10))
        expect(blocks[3]).toMatchObject({type: 'think', id: 'think-2'})
        expect(blocks[4].text).toBe('C'.repeat(10))
    })
})
