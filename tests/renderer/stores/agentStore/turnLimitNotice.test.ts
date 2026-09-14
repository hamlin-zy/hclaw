// @vitest-environment jsdom
/**
 * 达轮数上限终态在渲染端的收尾（turnLimitNotice）
 *
 * 背景：模型跑满 maxTurns 被截断后，controller 以 done(reason 'max_turns_reached')
 * 收尾。渲染端此前把它当普通 completed：既无提示、又续跑 pendingMessages，用户
 * 完全看不出任务没跑完。
 *
 * 现行为：
 * - 写入 convAgentStates[convId].turnLimitNotice（{turns, maxTurns}）供 UI 展示提示条；
 * - 该提示「运行结束后」产生，须留存于界面 —— 不在任何 done 收尾路径清除；
 * - 不触发 pendingMessages 续跑（先让用户看到提示再决定）；
 * - 纳入空占位清理集合（本轮 assistant 无内容时移除空泡）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleDone} from '../../../../src/renderer/stores/agentStore/handlers/streamInteraction'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, Array<{id: string; role: string; content: string; timestamp: number}>>,
        activeConversationId: 'conv-1',
        updateMessageForConv: vi.fn(),
        deleteMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, Record<string, unknown>>,
        errorMessage: null,
        agentState: {status: 'running'},
        startAgent: vi.fn(),
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {getState: () => mockConversationState},
    flushConversationDirty: vi.fn(),
    finalizeMessageDelta: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {getState: () => mockAgentState},
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

vi.mock('../../../../src/renderer/stores/agentStore/helpers/convHelpers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/renderer/stores/agentStore/helpers/convHelpers')>()
    return {...actual, clearConversationRuntimeState: vi.fn()}
})

Object.assign(mockAgentState, {
    updateConvData: (convId: string, patch: Record<string, unknown>) => {
        mockAgentState.convAgentStates[convId] = {
            ...mockAgentState.convAgentStates[convId],
            ...patch,
            agentState: {
                ...(mockAgentState.convAgentStates[convId]?.agentState as Record<string, unknown> || {}),
                ...(patch.agentState as Record<string, unknown> || {}),
            },
        }
    },
})

mockConversationState.deleteMessageForConv = vi.fn((convId: string, id: string) => {
    mockConversationState.messagesMap[convId] = (mockConversationState.messagesMap[convId] || []).filter(m => m.id !== id)
})

function makeCtx(reason: string, extra: Record<string, unknown> = {}) {
    return {
        set: vi.fn(),
        get: () => mockAgentState as never,
        convId: 'conv-1',
        isActiveConv: true,
        isAgentAborted: false,
        event: {type: 'done', reason, ...extra},
    }
}

function seedRunningConv(assistantContent: string, pendingMessages: Array<{content: string}> = []) {
    mockAgentState.convAgentStates['conv-1'] = {
        streamingMessageId: 'assist-1',
        agentState: {status: 'running', phase: 'streaming'},
        streamBuffer: '',
        streamBlocks: [],
        thinkingContent: null,
        executingToolsMessage: null,
        runningToolCount: 0,
        isThinkingAfterTools: false,
        pendingMessages,
    }
    mockConversationState.messagesMap['conv-1'] = [
        {id: 'user-1', role: 'user', content: '跑个长任务', timestamp: 1},
        {id: 'assist-1', role: 'assistant', content: assistantContent, timestamp: 2},
    ]
}

beforeEach(() => {
    mockAgentState.convAgentStates = {}
    mockAgentState.errorMessage = null
    mockAgentState.agentState = {status: 'running'}
    mockAgentState.startAgent = vi.fn()
    mockConversationState.messagesMap = {}
    mockConversationState.deleteMessageForConv.mockClear()
})

describe('handleDone(max_turns_reached) 收尾', () => {
    it('写入 turnLimitNotice（携带 turns/maxTurns）', async () => {
        seedRunningConv('')

        await handleDone(makeCtx('max_turns_reached', {turns: 500, maxTurns: 500}) as never)

        expect(mockAgentState.convAgentStates['conv-1'].turnLimitNotice).toEqual({turns: 500, maxTurns: 500})
    })

    it('提示留存：后续 done(completed) 不清除 turnLimitNotice', async () => {
        seedRunningConv('')
        await handleDone(makeCtx('max_turns_reached', {turns: 500, maxTurns: 500}) as never)

        // 用户再发一轮消息干净结束后，提示条仍应留在界面（直到下一 run 开始 / 用户关闭）
        await handleDone(makeCtx('completed') as never)

        expect(mockAgentState.convAgentStates['conv-1'].turnLimitNotice).toEqual({turns: 500, maxTurns: 500})
    })

    it('不触发 pendingMessages 续跑（先让用户看到提示）', async () => {
        seedRunningConv('', [{content: '排队消息'}])

        await handleDone(makeCtx('max_turns_reached', {turns: 500, maxTurns: 500}) as never)

        expect(mockAgentState.startAgent).not.toHaveBeenCalled()
    })

    it('空占位清理生效：无内容时移除空 assistant 气泡', async () => {
        seedRunningConv('')

        await handleDone(makeCtx('max_turns_reached', {turns: 500, maxTurns: 500}) as never)

        expect(mockConversationState.messagesMap['conv-1'].map(m => m.id)).toEqual(['user-1'])
    })

    it('有内容时消息保留（不误删）', async () => {
        seedRunningConv('部分产出')

        await handleDone(makeCtx('max_turns_reached', {turns: 500, maxTurns: 500}) as never)

        expect(mockConversationState.messagesMap['conv-1'].map(m => m.id)).toEqual(['user-1', 'assist-1'])
    })
})
