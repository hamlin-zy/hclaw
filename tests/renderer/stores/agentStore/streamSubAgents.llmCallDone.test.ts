import {beforeEach, describe, expect, it, vi} from 'vitest'

const {mockMessages, mockUpdate, mockAppend, mockUpdateToolCall} = vi.hoisted(() => ({
    mockMessages: [{id: 'msg-1', role: 'assistant', content: '', toolCalls: []}],
    mockUpdate: vi.fn(),
    mockAppend: vi.fn(),
    mockUpdateToolCall: vi.fn(),
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            messagesMap: {'conv-1': mockMessages},
            updateMessageForConv: mockUpdate,
        }),
    },
}))

vi.mock('@/renderer/stores/toolCallsStore', () => ({
    useToolCallsStore: {
        getState: () => ({appendProgressLog: mockAppend, updateToolCall: mockUpdateToolCall}),
    },
}))

import {handleSubagentProgress} from '@/renderer/stores/agentStore/handlers/streamSubAgents'

describe('handleSubagentProgress — llmStats 组装', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockMessages.length = 1
        mockMessages[0] = {id: 'msg-1', role: 'assistant', content: '', toolCalls: []}
    })

    function ctx(event: unknown) {
        return {
            get: () => ({
                convAgentStates: {
                    'conv-1': {streamingMessageId: 'msg-1', agentState: {status: 'running'}},
                },
            }),
            convId: 'conv-1',
            isAgentAborted: false,
            event,
        }
    }

    it('子代理 llm_call_done 新字段写入 llmStats', () => {
        handleSubagentProgress(ctx({
            type: 'subagent_progress',
            taskId: 'child-1',
            progress: 'ok',
            subAgentStreamEvent: {
                type: 'llm_call_done',
                inputTokens: 100,
                outputTokens: 200,
                provider: 'test',
                model: 'm',
                duration: 5000,
                ttftMs: 800,
                decodeMs: 5000,
                tokensPerSecond: 40,
            },
        }) as any)

        expect(mockUpdate).toHaveBeenCalledTimes(1)
        const [, , updates] = mockUpdate.mock.calls[0]
        expect(updates.llmStats[0].ttftMs).toBe(800)
        expect(updates.llmStats[0].decodeMs).toBe(5000)
        expect(updates.llmStats[0].tokensPerSecond).toBe(40)
    })
})
