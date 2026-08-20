// @vitest-environment jsdom
/**
 * 重试提示占位气泡创建测试
 *
 * 保护：首次 LLM 调用即失败（无 text/tool 事件）时渲染端还没有 assistant 消息，
 * handleWarning 的 retry 分支必须创建空占位消息并写入 streamingMessageId，
 * 使重试提示有气泡可挂载（气泡内 statusNote），且后续 text/thinking/tool_start
 * 复用该 ID，避免 handleText 再建一条新消息产生重复气泡。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleWarning} from '../../../../src/renderer/stores/agentStore/handlers/streamInteraction'
import {handleToolProgress} from '../../../../src/renderer/stores/agentStore/handlers/streamTools'

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
    flushConversationDirty: vi.fn(),
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
        streamingMessageId: null,
        agentState: {status: 'running', phase: 'streaming'},
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

describe('handleWarning 重试分支占位气泡', () => {
    beforeEach(() => {
        mockAgentState.convAgentStates = {}
        mockAgentState.errorMessage = null
        mockAgentState.agentState = {status: 'running'}
        mockConversationState.addMessageToConv.mockClear()
        mockConversationState.updateMessageForConv.mockClear()
    })

    it('无 streamingMessageId：创建占位 assistant 消息并写入 streamingMessageId', () => {
        seedConv()
        handleWarning(makeCtx({type: 'warning', message: 'retry 1/10：timeout'}))

        // 创建占位消息
        expect(mockConversationState.addMessageToConv).toHaveBeenCalledTimes(1)
        const [convId, msg] = mockConversationState.addMessageToConv.mock.calls[0]
        expect(convId).toBe('conv-1')
        expect(msg.role).toBe('assistant')
        expect(msg.content).toBe('')
        expect(typeof msg.id).toBe('string')

        // streamingMessageId 指向占位消息 → 后续 text 复用，不重复建消息
        const state = mockAgentState.convAgentStates['conv-1']
        expect(state.streamingMessageId).toBe(msg.id)
        // 重试提示状态照常更新
        expect(state.executingToolsMessage).toEqual({
            label: '重试 1/10：timeout',
            urgent: false,
        })
    })

    it('已有 streamingMessageId：不创建占位（多轮场景复用现有活跃消息）', () => {
        seedConv({streamingMessageId: 'msg-1'})
        handleWarning(makeCtx({type: 'warning', message: 'retry 2/10：network_error'}))

        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('msg-1')
        expect(mockAgentState.convAgentStates['conv-1'].executingToolsMessage).toEqual({
            label: '重试 2/10：network_error',
            urgent: false,
        })
    })

    it('已取消重试：仅更新状态，不创建占位', () => {
        seedConv()
        handleWarning(makeCtx({type: 'warning', message: 'retry 3/10：已取消重试'}))

        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBeNull()
        expect(mockAgentState.convAgentStates['conv-1'].executingToolsMessage).toEqual({
            label: '重试已取消',
            urgent: true,
        })
    })

    it('非 retry warning（如配置警告）：不创建占位（走既有 warning 兜底分支）', () => {
        seedConv()
        handleWarning(makeCtx({type: 'warning', message: '会话指定的模型已失效，已切换为主力模型'}))

        // 占位 API 不被调用（addMessageToConv 仅 retry 分支使用）
        expect(mockConversationState.addMessageToConv).not.toHaveBeenCalled()
        // conv 级 streamingMessageId 不被改动（既有兜底走顶层 addMessage + set）
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBeNull()
    })

    it('倒计时 tool_progress：label 使用主进程 progress（保留次数+错误详情），不覆盖详情', () => {
        seedConv({streamingMessageId: 'msg-1'})
        handleToolProgress(makeCtx({
            type: 'tool_progress',
            toolCallId: 'retry-backoff',
            progress: '重试 2/10：timeout，剩余 3s',
            retryCountdown: 3,
        }))

        expect(mockAgentState.convAgentStates['conv-1'].executingToolsMessage).toEqual({
            label: '重试 2/10：timeout，剩余 3s',
            urgent: true, // 3s ≤ 3 阈值 → 紧迫态
        })
    })

    it('倒计时 tool_progress：无 progress 字段时回退旧文案（兼容旧事件）', () => {
        seedConv({streamingMessageId: 'msg-1'})
        handleToolProgress(makeCtx({
            type: 'tool_progress',
            toolCallId: 'retry-backoff',
            retryCountdown: 5,
        }))

        expect(mockAgentState.convAgentStates['conv-1'].executingToolsMessage).toEqual({
            label: '重试中，5s 后重试...',
            urgent: false,
        })
    })
})
