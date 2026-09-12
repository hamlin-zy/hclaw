// @vitest-environment jsdom
/**
 * 取消 tools 变动弹窗后的空助手气泡清理（P3 收口）
 *
 * 缺陷：用户在 tools 变动确认弹窗点「取消」→ controller 以
 *   `done(reason:'tools_change_cancelled')` 收尾（controller.ts:556）。
 *   渲染端 handleDone 的空占位清理条件只认 aborted / loop_detected，
 *   若本轮 assistant 消息在首 token 前即被取消（tools_change_confirm 会
 *   凭空建 pending → 落一条无内容消息行），就残留一个空白助手气泡；
 *   刷新后该空白气泡依旧存在（行未被删）。
 *
 * 修复：把 tools_change_cancelled 纳入同款收尾——复用 removeEmptyAssistantMessage，
 *   其内部经 deleteMessageForConv 下发 IPC 删库行，故刷新后也不残留。
 *
 * 本用例用真实 removeEmptyAssistantMessage（仅 mock conversationStore 的落库面），
 *   断言 messagesMap 实际被清理，而非断言「某函数被调用」。
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

// 只替换副作用较大的运行时清理，保留真实 removeEmptyAssistantMessage / isAssistantMessageEmpty
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

/** 真实 deleteMessageForConv 的语义等价替身：同步过滤 messagesMap + 记录 IPC 删库调用 */
mockConversationState.deleteMessageForConv = vi.fn((convId: string, id: string) => {
    mockConversationState.messagesMap[convId] = (mockConversationState.messagesMap[convId] || []).filter(m => m.id !== id)
})

function makeCtx(reason: string) {
    return {
        set: vi.fn(),
        get: () => mockAgentState as never,
        convId: 'conv-1',
        isActiveConv: true,
        isAgentAborted: false,
        event: {type: 'done', reason},
    }
}

function seedRunningConv(assistantContent: string) {
    mockAgentState.convAgentStates['conv-1'] = {
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
    mockConversationState.messagesMap['conv-1'] = [
        {id: 'user-1', role: 'user', content: '改一下工具', timestamp: 1},
        {id: 'assist-1', role: 'assistant', content: assistantContent, timestamp: 2},
    ]
}

beforeEach(() => {
    mockAgentState.convAgentStates = {}
    mockAgentState.errorMessage = null
    mockAgentState.agentState = {status: 'running'}
    mockConversationState.messagesMap = {}
    mockConversationState.deleteMessageForConv.mockClear()
})

describe('handleDone(tools_change_cancelled) 空占位清理', () => {
    it('取消 tools 变动 → 空 assistant 占位被移除（含删库 IPC），不再残留空白气泡', async () => {
        seedRunningConv('')

        await handleDone(makeCtx('tools_change_cancelled') as never)

        expect(mockConversationState.messagesMap['conv-1'].map(m => m.id)).toEqual(['user-1'])
        // 删库行：刷新后历史加载也不会再出现空 assistant 行
        expect(mockConversationState.deleteMessageForConv).toHaveBeenCalledWith('conv-1', 'assist-1')
    })

    it('取消 tools 变动但有正文 → 消息保留（不误删）', async () => {
        seedRunningConv('已完成的正文')

        await handleDone(makeCtx('tools_change_cancelled') as never)

        expect(mockConversationState.messagesMap['conv-1'].map(m => m.id)).toEqual(['user-1', 'assist-1'])
        expect(mockConversationState.deleteMessageForConv).not.toHaveBeenCalled()
    })

    it('completed 收尾不受影响：空占位不清理（既有语义保持）', async () => {
        seedRunningConv('')

        await handleDone(makeCtx('completed') as never)

        expect(mockConversationState.messagesMap['conv-1'].map(m => m.id)).toEqual(['user-1', 'assist-1'])
        expect(mockConversationState.deleteMessageForConv).not.toHaveBeenCalled()
    })
})
