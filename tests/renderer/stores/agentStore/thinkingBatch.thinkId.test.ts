// @vitest-environment jsdom
/**
 * thinkingBatch think 块 id「段序号派生」测试（Task 1 修复）
 *
 * 保护：think 块 id 不能用 textOffset（= streamBuffer.length）派生——think 内容
 * 不入 streamBuffer，工具前后两个 think 段（think → tool_use → think）的 offset
 * 可能相同（典型：两段 offset 都是 0），同 id 两次 INSERT OR REPLACE 会静默覆盖，
 * 第一个 think 段的数据落库时丢失。
 *
 * 修复后 id = `think-${msgId}-${thinkSeq}`，thinkSeq = 该消息 streamBlocks 中已有
 * think 块数（0, 1, 2, ...），单调递增天然唯一；textOffset 字段保留（仍是
 * contentBlocks 交错重建的锚点语义）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {
    accumulateThinkingBatch,
    flushThinkingBatch,
    clearThinkingBatch,
} from '@/renderer/stores/agentStore/batching/thinkingBatch'
import {updateMessageContentBlocks} from '@/renderer/stores/agentStore/contentBlocks'
import {messageToBlocks} from '@/main/repositories/sqlite/messageBlockHelper'
import type {ContentBlock} from '@shared/types'

type StreamBlock = {
    type: 'think' | 'tool_use'
    id: string
    textOffset: number
    thinkContent?: string
    toolCall?: {
        id: string
        name: string
        arguments: Record<string, unknown>
        status: string
        textOffset?: number
    }
}

interface MockConv {
    agentState: {status: string; mode: string; phase: string}
    streamBuffer: string
    thinkingContent: string | null
    streamBlocks: StreamBlock[]
    streamingMessageId: string | null
    isThinkingAfterTools: boolean
    runningToolCount: number
    pendingQuestion: unknown
    toolPopupData: unknown
    pendingPermissionConfirm: unknown
    tasks: unknown[]
    intentResult: unknown
    errorMessage: unknown
    executingToolsMessage: unknown
    pendingMessages: unknown[]
}

// ── 依赖 mock：静态 store（getState 返回可变最小形态，支持多次 flush 读最新状态） ──
const {mockAgentState, mockConversationState, mkConv} = vi.hoisted(() => {
    const mkConv = (): MockConv => ({
        agentState: {status: 'running', mode: 'auto', phase: 'streaming'},
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        streamingMessageId: 'm1',
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
    })
    const mockAgentState: {
        convAgentStates: Record<string, MockConv>
        updateConvData: ReturnType<typeof vi.fn>
        updateMessageContentBlocks: ReturnType<typeof vi.fn>
    } = {
        convAgentStates: {},
        updateConvData: vi.fn(),
        updateMessageContentBlocks: vi.fn(),
    }
    mockAgentState.updateConvData.mockImplementation((convId: string, patch: Partial<MockConv>) => {
        mockAgentState.convAgentStates[convId] = {
            ...(mockAgentState.convAgentStates[convId] || mkConv()),
            ...patch,
        }
    })
    const mockConversationState = {
        messagesMap: {
            'conv-1': [{id: 'm1', role: 'assistant', content: '', toolCalls: []}],
        },
        activeConversationId: 'conv-1',
        updateMessageForConv: vi.fn(),
    }
    return {mockAgentState, mockConversationState, mkConv}
})

vi.mock('@/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockAgentState,
    },
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => mockConversationState,
    },
    recordThinkBlock: vi.fn(),
}))

/** 从 updateMessageForConv mock 调用中取出最近一次写入的 contentBlocks */
function lastContentBlocksWrite(): ContentBlock[] | undefined {
    for (const call of mockConversationState.updateMessageForConv.mock.calls) {
        const updates = call[2] as {contentBlocks?: ContentBlock[]} | undefined
        if (updates?.contentBlocks) return updates.contentBlocks
    }
    return undefined
}

beforeEach(() => {
    mockAgentState.convAgentStates['conv-1'] = mkConv()
    mockConversationState.updateMessageForConv.mockClear()
    mockAgentState.updateConvData.mockClear()
    mockAgentState.updateMessageContentBlocks.mockClear()
    clearThinkingBatch('conv-1')
})

describe('think 块 id 段序号派生（Task 1）', () => {
    it('工具前后两个 think 段 → think-m1-0 / think-m1-1 不同 id，经 messageToBlocks 两块都存在', () => {
        // 段 1：think（offset 0）
        accumulateThinkingBatch('conv-1', '思考A')
        flushThinkingBatch('conv-1')
        expect(mockAgentState.convAgentStates['conv-1'].streamBlocks).toEqual([
            {type: 'think', id: 'think-m1-0', textOffset: 0, thinkContent: '思考A'},
        ])

        // 工具 push：streamBuffer 不推进，textOffset=0 的 tool_use 块加入（streamTools.ts:81-87 语义）
        mockAgentState.convAgentStates['conv-1'].streamBlocks.push({
            type: 'tool_use',
            id: 'tool-tc1',
            textOffset: 0,
            toolCall: {id: 'tc1', name: 'bash', arguments: {}, status: 'running', textOffset: 0},
        })

        // 段 2：think（offset 仍是 streamBuffer.length = 0）
        accumulateThinkingBatch('conv-1', '思考B')
        flushThinkingBatch('conv-1')

        const blocks = mockAgentState.convAgentStates['conv-1'].streamBlocks
        expect(blocks).toHaveLength(3)
        expect(blocks[0]).toMatchObject({type: 'think', id: 'think-m1-0', textOffset: 0, thinkContent: '思考A'})
        expect(blocks[1]).toMatchObject({type: 'tool_use', id: 'tool-tc1', textOffset: 0})
        expect(blocks[2]).toMatchObject({type: 'think', id: 'think-m1-1', textOffset: 0, thinkContent: '思考B'})
        // ★ 修复核心：两段 offset 相同（均为 0），但 id 由段序号派生 → 不碰撞
        expect(blocks[2].id).not.toBe(blocks[0].id)

        // 重建 contentBlocks：两个 think 块各自保留（不再同 id 互相覆盖）
        updateMessageContentBlocks('conv-1')
        const contentBlocks = lastContentBlocksWrite()
        expect(contentBlocks).toBeDefined()
        expect(contentBlocks!.filter(cb => cb.type === 'think').map(cb => cb.id)).toEqual([
            'think-m1-0',
            'think-m1-1',
        ])

        // 主进程 messageToBlocks：两个不同 id 各产生独立块（INSERT OR REPLACE 不再覆盖）
        const msg = {id: 'm1', role: 'assistant' as const, content: '', timestamp: 1000, contentBlocks: contentBlocks!}
        const {blocks: dbBlocks} = messageToBlocks(msg, 'conv-1')
        const persistedThink = dbBlocks.filter(b => b.blockType === 'think')
        expect(persistedThink.map(b => b.id).sort()).toEqual(['think-m1-0', 'think-m1-1'])
        expect(persistedThink.map(b => b.content).sort()).toEqual(['思考A', '思考B'])
    })

    it('think 段内多次 flush → 仍是单块、id 不变（幂等 UPDATE 语义依赖）', () => {
        accumulateThinkingBatch('conv-1', '思考1')
        flushThinkingBatch('conv-1')
        accumulateThinkingBatch('conv-1', '思考2')
        flushThinkingBatch('conv-1')

        const blocks = mockAgentState.convAgentStates['conv-1'].streamBlocks
        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toMatchObject({
            type: 'think',
            id: 'think-m1-0', // 段内追加不 push → id 不变
            textOffset: 0,
            thinkContent: '思考1思考2',
        })
    })

    it('第三个新段序号继续递增（think→tool→think→tool→think）', () => {
        const pushTool = (id: string) => {
            mockAgentState.convAgentStates['conv-1'].streamBlocks.push({
                type: 'tool_use',
                id: `tool-${id}`,
                textOffset: 0,
                toolCall: {id, name: 'bash', arguments: {}, status: 'running', textOffset: 0},
            })
        }
        accumulateThinkingBatch('conv-1', 'A')
        flushThinkingBatch('conv-1')
        pushTool('tc1')
        accumulateThinkingBatch('conv-1', 'B')
        flushThinkingBatch('conv-1')
        pushTool('tc2')
        accumulateThinkingBatch('conv-1', 'C')
        flushThinkingBatch('conv-1')

        const thinkIds = mockAgentState.convAgentStates['conv-1'].streamBlocks
            .filter(b => b.type === 'think')
            .map(b => b.id)
        expect(thinkIds).toEqual(['think-m1-0', 'think-m1-1', 'think-m1-2'])
    })

    it('text 块 id 仍为 text-${msgId}-${offset}（不受 think id 改动影响）', () => {
        // 场景：textOffset=5 的 think 块 + 15 字符文本 → 文本段 0..5 与 5..15
        mockAgentState.convAgentStates['conv-1'] = {
            ...mockAgentState.convAgentStates['conv-1'],
            streamBuffer: 'AAAAA' + 'BBBBBBBBBB',
            streamBlocks: [
                {type: 'think', id: 'think-m1-0', textOffset: 5, thinkContent: '思考'},
            ],
        }
        updateMessageContentBlocks('conv-1')
        const contentBlocks = lastContentBlocksWrite()
        expect(contentBlocks).toBeDefined()
        const textIds = contentBlocks!.filter(cb => cb.type === 'text').map(cb => cb.id)
        // 段前文本起始 offset 0，段后剩余文本起始 offset 5
        expect(textIds).toEqual(['text-m1-0', 'text-m1-5'])
        expect(textIds.every(id => /^text-m1-\d+$/.test(id))).toBe(true)
    })
})
