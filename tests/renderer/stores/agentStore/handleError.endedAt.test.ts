// @vitest-environment jsdom
/**
 * handleError 收尾补 endedAt 测试
 *
 * 保护：error 事件收尾时，handleError 必须先补流式消息 endedAt 再 flushConversationDirty
 * （与 done / user_message_injected 对称）。writeMessagesDelta 是 INSERT OR REPLACE 全行替换
 * （ended_at = msgRecord.endedAt ?? null），若无 endedAt 快照会把主进程
 * doMergeAndPersist(pending, true) 刚写的 final（含 ended_at）覆盖为 NULL →
 * 报错消息重载后被标记为 partial/未完成。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleError} from '../../../../src/renderer/stores/agentStore/handlers/streamInteraction'

// ── 依赖 mock：静态 store（getState 返回可断言的最小形态） ──
const {mockConversationState, mockAgentState, mockFlushDirty} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {},
        addMessageToConv: vi.fn(),
        updateMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        errorMessage: null,
        agentState: {status: 'running'},
    },
    mockFlushDirty: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => mockConversationState,
    },
    flushConversationDirty: mockFlushDirty,
    finalizeMessageDelta: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockAgentState,
    },
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/textBatch', () => ({
    flushTextBatch: vi.fn(),
    clearTextBatch: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/thinkingBatch', () => ({
    flushThinkingBatch: vi.fn(),
    clearThinkingBatch: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/toolResultBatch', () => ({
    flushToolResultBatch: vi.fn(),
    clearToolResultBatchData: vi.fn(),
    getToolResultBatchMap: () => new Map(),
}))

vi.mock('../../../../src/renderer/stores/agentStore/helpers/misc', () => ({
    parseCommands: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore/helpers/convHelpers', () => ({
    saveCurrentConversation: vi.fn(),
}))

Object.assign(mockAgentState, {
    updateConvData: (convId: string, patch: any) => {
        mockAgentState.convAgentStates[convId] = {
            ...mockAgentState.convAgentStates[convId],
            ...patch,
            agentState: {
                ...(mockAgentState.convAgentStates[convId]?.agentState || {}),
                ...(patch.agentState || {}),
            },
        }
    },
})

function seedConv(overrides: any = {}) {
    mockAgentState.convAgentStates['conv-1'] = {
        streamingMessageId: 'msg-1',
        agentState: {status: 'running', phase: 'streaming'},
        streamBuffer: 'partial text',
        streamBlocks: [],
        thinkingContent: null,
        executingToolsMessage: null,
        runningToolCount: 0,
        isThinkingAfterTools: false,
        pendingMessages: [],
        ...overrides,
    }
}

function makeCtx(event: any) {
    return {
        set: vi.fn(),
        get: () => mockAgentState as any,
        convId: 'conv-1',
        isActiveConv: true,
        isAgentAborted: false,
        event,
    }
}

describe('handleError 收尾补 endedAt（防无 endedAt 快照覆盖主进程 final 写）', () => {
    beforeEach(() => {
        mockAgentState.convAgentStates = {} as Record<string, any>
        mockAgentState.errorMessage = null
        mockAgentState.agentState = {status: 'running'}
        mockConversationState.addMessageToConv.mockClear()
        mockConversationState.updateMessageForConv.mockClear()
        mockFlushDirty.mockClear()
    })

    it('有流式消息：flush 前补 endedAt（updateMessageForConv 先于 flushConversationDirty 调用）', () => {
        seedConv()
        handleError(makeCtx({type: 'error', error: 'boom'}))

        // 补 endedAt：updateMessageForConv('conv-1', 'msg-1', {endedAt: number})
        expect(mockConversationState.updateMessageForConv).toHaveBeenCalledTimes(1)
        const [convId, msgId, patch] = mockConversationState.updateMessageForConv.mock.calls[0]
        expect(convId).toBe('conv-1')
        expect(msgId).toBe('msg-1')
        expect(patch.endedAt).toBeTypeOf('number')

        // ★ 顺序：endedAt 补写必须发生在 flush 之前（否则无 endedAt 快照覆盖 final 写）
        const updateOrder = mockConversationState.updateMessageForConv.mock.invocationCallOrder[0]
        const flushOrder = mockFlushDirty.mock.invocationCallOrder[0]
        expect(updateOrder).toBeLessThan(flushOrder)
        expect(mockFlushDirty).toHaveBeenCalledWith('conv-1')
    })

    it('无流式消息：不补 endedAt（分支跳过），但 flush 仍执行', () => {
        seedConv({streamingMessageId: null})
        handleError(makeCtx({type: 'error', error: 'boom'}))

        // 无流式消息 → 新建占位消息，但不补 endedAt
        expect(mockConversationState.addMessageToConv).toHaveBeenCalledTimes(1)
        expect(mockConversationState.updateMessageForConv).not.toHaveBeenCalled()
        expect(mockFlushDirty).toHaveBeenCalledWith('conv-1')
    })

    it('末尾 streamingMessageId 已置 null，但基于进入 error 前的快照仍补 endedAt', () => {
        seedConv()
        handleError(makeCtx({type: 'error', error: 'boom'}))

        // 收尾后 conv 状态已重置 streamingMessageId=null（updateConvData 已执行）
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBeNull()
        // 但仍以进入 error 前的消息快照补了 endedAt
        expect(mockConversationState.updateMessageForConv).toHaveBeenCalledWith(
            'conv-1',
            'msg-1',
            expect.objectContaining({endedAt: expect.any(Number)}),
        )
    })
})
