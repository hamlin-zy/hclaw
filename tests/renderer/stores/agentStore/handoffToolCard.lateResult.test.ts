// @vitest-environment jsdom
/**
 * 交接后工具卡片卡「处理中」回归测试
 *
 * 场景：session_handoff 后主会话强制结束 —— onWorkerExit 安全网 done('aborted')
 * 直发渲染端（绕过主进程批量累积器），可能先于 worker 尾批的 tool_result 到达，
 * handleDone 已清空 streamingMessageId。晚到的 tool_result 不得被丢弃，
 * 工具卡片必须能落到 success（顺序无关兜底）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleToolResult} from '@/renderer/stores/agentStore/handlers/streamTools'
import {
    scheduleToolResultUpdate,
    flushToolResultBatch,
    clearToolResultBatchData,
    getToolResultBatchMap,
} from '@/renderer/stores/agentStore/batching/toolResultBatch'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        updateMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        updateConvData: vi.fn(),
    },
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => mockConversationState,
    },
    recordToolResultBlock: vi.fn(),
}))

vi.mock('@/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockAgentState,
    },
}))

// handleToolResult 的重依赖（文本批/window、子会话、streamCore）与测试无关，mock 掉
vi.mock('@/renderer/stores/agentStore/batching/textBatch', () => ({
    flushTextBatch: vi.fn(),
    clearTextBatch: vi.fn(),
}))
vi.mock('@/renderer/stores/agentStore/handlers/streamSubAgents', () => ({
    ensureAgentToolTaskId: vi.fn(),
}))
vi.mock('@/renderer/stores/agentStore/handlers/streamCore', () => ({
    isRetryMessage: () => false,
}))
vi.mock('@/renderer/stores/toolCallsStore', () => ({
    useToolCallsStore: {
        getState: () => ({states: {}, setToolResult: vi.fn(), clearToolCall: vi.fn(), updateToolCall: vi.fn()}),
    },
}))

// rAF 不触发（模拟 done 同 tick 内手动 flush 的路径）
vi.stubGlobal('requestAnimationFrame', () => 1)

function seedConv(convId: string, streamingMessageId: string | null, status: string) {
    mockAgentState.convAgentStates[convId] = {
        streamingMessageId,
        agentState: {status},
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    for (const convId of Object.keys(getToolResultBatchMap())) {
        clearToolResultBatchData(convId)
    }
})

const toolResultEvent = (toolCallId: string) => ({
    type: 'tool_result',
    toolCallId,
    result: {success: true, output: '新会话已创建'},
})

describe('晚到的 tool_result（done 先行清空 streamingMessageId）', () => {
    it('handleToolResult 兜底：按 toolCallId 定位消息，应用 success 状态', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [{id: 'tc-1', name: 'session_handoff', status: 'running'}]},
        ]
        seedConv('conv-1', null, 'idle') // done 已收尾

        handleToolResult({
            set: vi.fn(),
            get: () => mockAgentState as any,
            convId: 'conv-1',
            isActiveConv: false,
            isAgentAborted: false,
            event: toolResultEvent('tc-1'),
        } as any)

        expect(mockConversationState.updateMessageForConv).toHaveBeenCalled()
        const call = mockConversationState.updateMessageForConv.mock.calls.find(
            (c: any[]) => c[0] === 'conv-1' && c[1] === 'msg-1',
        )
        expect(call).toBeDefined()
        expect(call![2].toolCalls.find((tc: any) => tc.id === 'tc-1').status).toBe('success')
    })

    it('flushToolResultBatch 兜底：streamingMessageId 为空时按 toolCallId 定位消息 flush', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [{id: 'tc-1', name: 'bash', status: 'running'}]},
        ]
        mockAgentState.convAgentStates['conv-1'] = {streamingMessageId: null}

        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'A'})
        flushToolResultBatch('conv-1')

        const call = mockConversationState.updateMessageForConv.mock.calls.find(
            (c: any[]) => c[0] === 'conv-1' && c[1] === 'msg-1',
        )
        expect(call).toBeDefined()
        expect(call![2].toolCalls.find((tc: any) => tc.id === 'tc-1').status).toBe('success')
    })

    it('消息中不存在该 toolCallId 时安全返回（不误写其他消息）', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [{id: 'tc-other', name: 'bash', status: 'running'}]},
        ]
        seedConv('conv-1', null, 'idle')

        handleToolResult({
            set: vi.fn(),
            get: () => mockAgentState as any,
            convId: 'conv-1',
            isActiveConv: false,
            isAgentAborted: false,
            event: toolResultEvent('tc-1'),
        } as any)

        expect(mockConversationState.updateMessageForConv).not.toHaveBeenCalled()
    })
})

describe('msgId 随 batch entry 固化（flush 与 streamingMessageId 解耦）', () => {
    it('entry.msgId 优先：streamingMessageId 指向错误消息时仍按 entry 定位', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [{id: 'tc-1', name: 'session_handoff', status: 'running'}]},
            {id: 'msg-2', role: 'assistant', toolCalls: [{id: 'tc-2', name: 'bash', status: 'running'}]},
        ]
        // done 已收尾且 streamingMessageId 被清空（或残留指向 msg-2）
        mockAgentState.convAgentStates['conv-1'] = {streamingMessageId: 'msg-2', agentState: {status: 'idle'}}

        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'A'})
        flushToolResultBatch('conv-1')

        const call = mockConversationState.updateMessageForConv.mock.calls.find(
            (c: any[]) => c[0] === 'conv-1' && c[1] === 'msg-1',
        )
        expect(call).toBeDefined()
        expect(call![2].toolCalls.find((tc: any) => tc.id === 'tc-1').status).toBe('success')
        // 不得误写 msg-2
        expect(mockConversationState.updateMessageForConv.mock.calls.some(
            (c: any[]) => c[1] === 'msg-2',
        )).toBe(false)
    })

    it('handleToolResult：running 中途 streamingMessageId 漂移，按 toolCallId 反查消息应用结果', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [{id: 'tc-1', name: 'bash', status: 'running'}]},
        ]
        seedConv('conv-1', 'msg-gone', 'running') // 指向已不存在的消息

        handleToolResult({
            set: vi.fn(),
            get: () => mockAgentState as any,
            convId: 'conv-1',
            isActiveConv: false,
            isAgentAborted: false,
            event: toolResultEvent('tc-1'),
        } as any)
        // running 状态下结果经 rAF flush（此处手动触发模拟下一帧）
        flushToolResultBatch('conv-1')

        const call = mockConversationState.updateMessageForConv.mock.calls.find(
            (c: any[]) => c[0] === 'conv-1' && c[1] === 'msg-1',
        )
        expect(call).toBeDefined()
        expect(call![2].toolCalls.find((tc: any) => tc.id === 'tc-1').status).toBe('success')
    })
})
