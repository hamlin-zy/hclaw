// @vitest-environment jsdom
/**
 * lastDoneReason —— 「继续」按钮的视觉权重信号（store 层）
 *
 * 契约：
 * - handleDone 写入 lastDoneReason = event.reason（本轮 run 的结束原因）；
 * - handleError 是独立路径（不经过 handleDone），必须单独写 'error'；
 * - startAgentImpl 新一轮开始复位 lastDoneReason = undefined（与 turnLimitNotice 并列）。
 *
 * 说明：本文件沿用 turnLimitNotice.test.ts / startAgent.test.ts 既有 mock 设施，
 * 不新建重型 mock。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, Array<{id: string; role: string; content: string; timestamp: number}>>,
        activeConversationId: 'conv-1',
        updateMessageForConv: vi.fn(),
        updateMessage: vi.fn(),
        deleteMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, Record<string, unknown>>,
        errorMessage: null as string | null,
        agentState: {status: 'running'} as Record<string, unknown>,
        startAgent: vi.fn(),
        markConvDoneUnread: vi.fn(),
        clearConvDoneUnread: vi.fn(),
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {getState: () => mockConversationState},
    flushConversationDirty: vi.fn(),
    finalizeMessageDelta: vi.fn(),
    // 「完成未读」判定用：摘要查不到 → 按普通顶层会话处理（本文件断言不涉及）
    findConvAcrossWorkspaces: () => null,
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
    return {...actual, clearConversationRuntimeState: vi.fn(), clearAllBatches: vi.fn()}
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

import {handleDone, handleError} from '../../../../src/renderer/stores/agentStore/handlers/streamInteraction'
import {startAgentImpl} from '../../../../src/renderer/stores/agentStore/handlers/startAgent'
import {createDefaultConvData, IDLE_STATE} from '../../../../src/renderer/stores/agentStore/defaultState'

const CONV = 'conv-1'

function makeCtx(event: Record<string, unknown>) {
    return {
        set: vi.fn(),
        get: () => mockAgentState as never,
        convId: CONV,
        isActiveConv: true,
        isAgentAborted: false,
        event,
    }
}

function seedRunningConv() {
    mockAgentState.convAgentStates[CONV] = {
        streamingMessageId: 'assist-1',
        agentState: {status: 'running', phase: 'streaming'},
        streamBuffer: '',
        streamBlocks: [],
        thinkingContent: null,
        executingToolsMessage: null,
        runningToolCount: 0,
        isThinkingAfterTools: false,
        pendingMessages: [],
    }
    mockConversationState.messagesMap[CONV] = [
        {id: 'user-1', role: 'user', content: '跑个长任务', timestamp: 1},
        {id: 'assist-1', role: 'assistant', content: '部分产出', timestamp: 2},
    ]
}

beforeEach(() => {
    mockAgentState.convAgentStates = {}
    mockAgentState.errorMessage = null
    mockAgentState.agentState = {status: 'running'}
    mockAgentState.startAgent = vi.fn()
    mockConversationState.messagesMap = {}
})

describe('lastDoneReason 写入 / 复位', () => {
    it('handleDone 写入 event.reason', async () => {
        seedRunningConv()

        await handleDone(makeCtx({type: 'done', reason: 'max_turns_reached', turns: 500, maxTurns: 500}) as never)

        expect(mockAgentState.convAgentStates[CONV].lastDoneReason).toBe('max_turns_reached')
    })

    it('handleDone(completed) 写入 completed', async () => {
        seedRunningConv()

        await handleDone(makeCtx({type: 'done', reason: 'completed'}) as never)

        expect(mockAgentState.convAgentStates[CONV].lastDoneReason).toBe('completed')
    })

    it('handleError 独立路径写入 error', () => {
        seedRunningConv()

        handleError(makeCtx({type: 'error', error: 'boom'}) as never)

        expect(mockAgentState.convAgentStates[CONV].lastDoneReason).toBe('error')
    })

    it('startAgentImpl 新一轮开始复位 lastDoneReason', async () => {
        const store: any = {
            convAgentStates: {
                [CONV]: {...createDefaultConvData(), agentState: {...IDLE_STATE, status: 'idle'}, lastDoneReason: 'error'},
            },
            updateConvData: (convId: string, updates: any) => {
                const prev = store.convAgentStates[convId] || createDefaultConvData()
                store.convAgentStates = {...store.convAgentStates, [convId]: {...prev, ...updates}}
            },
            clearConvDoneUnread: vi.fn(),
        }
        ;(window as any).electronAPI = {agentStart: vi.fn(async () => ({success: true}))}

        await startAgentImpl(vi.fn(), () => store as never, {conversationId: CONV, message: '继续'} as never)

        expect(store.convAgentStates[CONV].lastDoneReason).toBeUndefined()
    })
})
