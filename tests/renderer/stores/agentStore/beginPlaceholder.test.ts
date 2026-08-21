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
        registerSpy.mockClear()
        // electronAPI：占位创建后注册 id 到主进程（幽灵双写防御链路的渲染端入口）
        vi.stubGlobal('electronAPI', {
            agentRegisterStreamingMessage: registerSpy,
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
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

    it('创建占位后通过 IPC 注册占位 id（主进程 pending 复用，防幽灵双写）', () => {
        seedConv()
        handleBegin(makeCtx({type: 'begin'}))

        const msg = mockConversationState.addMessageToConv.mock.calls[0][1]
        // 注册 id 必须与渲染端占位消息 id 完全一致，否则主进程 pending 独立生成
        // 新 id → done 全量写兜底以新 id 插入幽灵副本（重启加载后气泡渲染 2 份）
        expect(registerSpy).toHaveBeenCalledTimes(1)
        expect(registerSpy).toHaveBeenCalledWith('conv-1', msg.id)
    })

    it('已有 streamingMessageId：不重复注册（复用原 ID，注册仅发生在新建占位时）', () => {
        seedConv({streamingMessageId: 'msg-1'})
        handleBegin(makeCtx({type: 'begin'}))

        expect(registerSpy).not.toHaveBeenCalled()
    })

    it('begin 携带 messageId（子会话 agentTool 累积器固定 id）：占位消息 id 对齐该 id 而非 UUID', () => {
        seedConv()
        handleBegin(makeCtx({type: 'begin', messageId: 'msg-1728000000000-abc123'}))

        expect(mockConversationState.addMessageToConv).toHaveBeenCalledTimes(1)
        const [convId, msg] = mockConversationState.addMessageToConv.mock.calls[0]
        expect(convId).toBe('conv-1')
        expect(msg.id).toBe('msg-1728000000000-abc123')
        expect(msg.role).toBe('assistant')

        // 后续流式事件复用该 id → 与主进程 SQLite 增量落库消息同 id，
        // 首次打开子会话时 switchActiveConversation 按 id 去重合并两轨 → 单条气泡
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('msg-1728000000000-abc123')
    })

    it('begin 携带 messageId：不注册主进程（子会话持久化走 agentTool 累积器路径，无 pending 机制可复用）', () => {
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
