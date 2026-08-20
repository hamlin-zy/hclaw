// @vitest-environment jsdom
/**
 * handleBegin 占位气泡创建测试
 *
 * 保护：LLM 调用开始（思考中）时若还没有 assistant 消息（会话首轮），
 * handleBegin 必须创建空占位消息并写入 streamingMessageId，使运行状态提示
 * （思考中/响应中等气泡 statusNote）有气泡可挂载；后续 text/tool_use 复用
 * 该 ID，避免 handleText 再建一条新消息产生重复气泡。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleBegin} from '../../../../src/renderer/stores/agentStore/handlers/streamCore'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {},
        addMessageToConv: vi.fn(),
        addMessage: vi.fn(),
        updateMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        errorMessage: null,
        agentState: {status: 'running'},
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => mockConversationState,
    },
    recordTextBlock: vi.fn(),
    flushConversationDirty: vi.fn(),
    finalizeMessageDelta: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockAgentState,
    },
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/textBatch', () => ({
    accumulateTextBatch: vi.fn(),
    scheduleImmediateTextFlush: vi.fn(),
    flushTextBatch: vi.fn(),
    clearTextBatch: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/thinkingBatch', () => ({
    accumulateThinkingBatch: vi.fn(),
    scheduleImmediateThinkingFlush: vi.fn(),
    flushThinkingBatch: vi.fn(),
    clearThinkingBatch: vi.fn(),
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
        streamingMessageId: null,
        agentState: {status: 'idle', phase: 'idle'},
        streamBuffer: '',
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

describe('handleBegin 占位气泡（会话首轮思考中有气泡可挂）', () => {
    beforeEach(() => {
        mockAgentState.convAgentStates = {}
        mockAgentState.errorMessage = null
        mockAgentState.agentState = {status: 'running'}
        mockConversationState.addMessageToConv.mockClear()
    })

    it('无 streamingMessageId：创建占位 assistant 消息并写入 streamingMessageId', () => {
        seedConv()
        handleBegin(makeCtx({type: 'begin'}))

        expect(mockConversationState.addMessageToConv).toHaveBeenCalledTimes(1)
        const [convId, msg] = mockConversationState.addMessageToConv.mock.calls[0]
        expect(convId).toBe('conv-1')
        expect(msg.role).toBe('assistant')
        expect(msg.content).toBe('')

        const state = mockAgentState.convAgentStates['conv-1']
        expect(state.streamingMessageId).toBe(msg.id)
        // 阶段进入 streaming（思考中）
        expect(state.agentState).toMatchObject({status: 'running', phase: 'streaming'})
    })

    it('已有 streamingMessageId（多轮工具后新一轮）：不创建占位，保留原 ID', () => {
        seedConv({streamingMessageId: 'msg-1'})
        handleBegin(makeCtx({type: 'begin'}))

        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('msg-1')
    })
})
