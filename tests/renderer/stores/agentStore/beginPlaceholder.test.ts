// @vitest-environment jsdom
/**
 * handleBegin 占位气泡创建测试
 *
 * 保护：LLM 调用开始（思考中）时若还没有 assistant 消息（会话首轮），
 * handleBegin 必须创建空占位消息并写入 streamingMessageId，使运行状态提示
 * （思考中/响应中等气泡 statusNote）有气泡可挂载；后续 text/tool_use 复用
 * 该 ID，避免 handleText 再建一条新消息产生重复气泡。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
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

// 占位消息 id 注册 spy：断言 ensureStreamingMessage 创建占位后通过 IPC 上报主进程
const registerSpy = vi.fn()

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
        // electronAPI：注册链路（agent-register-streaming-message）已随 id 单源删除，
        // 渲染端不应再有上报调用
        vi.stubGlobal('electronAPI', {
            agentRegisterStreamingMessage: registerSpy,
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('begin 携带 messageId（id 单源）：以其创建占位 assistant 消息并写入 streamingMessageId', () => {
        seedConv()
        handleBegin(makeCtx({type: 'begin', messageId: 'msg-1728000000000-abc123'}))

        expect(mockConversationState.addMessageToConv).toHaveBeenCalledTimes(1)
        const [convId, msg] = mockConversationState.addMessageToConv.mock.calls[0]
        expect(convId).toBe('conv-1')
        expect(msg.id).toBe('msg-1728000000000-abc123')
        expect(msg.role).toBe('assistant')
        expect(msg.content).toBe('')

        const state = mockAgentState.convAgentStates['conv-1']
        expect(state.streamingMessageId).toBe(msg.id)
        // 阶段进入 streaming（思考中）
        expect(state.agentState).toMatchObject({status: 'running', phase: 'streaming'})
    })

    it('begin 无 messageId：不建占位（id 单源，事件未到不建占位，不自建 UUID）', () => {
        seedConv()
        handleBegin(makeCtx({type: 'begin'}))

        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBeNull()
    })

    it('已有 streamingMessageId（多轮工具后新一轮）：不创建占位，保留原 ID', () => {
        seedConv({streamingMessageId: 'msg-1'})
        handleBegin(makeCtx({type: 'begin', messageId: 'msg-other'}))

        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('msg-1')
    })

    it('不注册主进程（消息 id 单源自主进程，agent-register-streaming-message 链路已删除）', () => {
        seedConv()
        handleBegin(makeCtx({type: 'begin', messageId: 'msg-1728000000000-abc123'}))

        expect(registerSpy).not.toHaveBeenCalled()
    })

    it('已有 streamingMessageId 且 begin 携带 messageId：复用原 ID，忽略事件 id', () => {
        seedConv({streamingMessageId: 'msg-keep'})
        handleBegin(makeCtx({type: 'begin', messageId: 'msg-1728000000000-abc123'}))

        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('msg-keep')
    })
})
