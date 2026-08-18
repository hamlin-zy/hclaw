import {beforeEach, describe, expect, it, vi} from 'vitest'

const {mockMessages, mockUpdate, mockElectronUpdate} = vi.hoisted(() => ({
    mockMessages: [{id: 'msg-1', role: 'assistant', content: ''}],
    mockUpdate: vi.fn(),
    mockElectronUpdate: vi.fn(),
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            messagesMap: {'conv-1': mockMessages},
            updateMessageForConv: mockUpdate,
        }),
    },
}))

vi.stubGlobal('window', {
    electronAPI: {message: {updateLlmStats: mockElectronUpdate}},
})

import {handleLlmCallDone} from '@/renderer/stores/agentStore/handlers/streamSystem'

describe('handleLlmCallDone — llmStats 组装', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockElectronUpdate.mockClear()
        mockMessages.length = 1
        mockMessages[0] = {id: 'msg-1', role: 'assistant', content: ''}
    })

    function ctx(event: unknown) {
        return {
            get: () => ({convAgentStates: {'conv-1': {streamingMessageId: 'msg-1'}}}),
            convId: 'conv-1',
            event,
        }
    }

    it('新字段写入 llmStats', () => {
        handleLlmCallDone(ctx({
            type: 'llm_call_done',
            inputTokens: 100,
            outputTokens: 200,
            provider: 'test',
            providerType: 'test',
            providerName: 'MiniMax',
            model: 'm',
            duration: 5000,
            ttftMs: 800,
            decodeMs: 5000,
            tokensPerSecond: 40,
        }) as any)

        expect(mockUpdate).toHaveBeenCalledTimes(1)
        const [, , updates] = mockUpdate.mock.calls[0]
        expect(updates.llmStats).toHaveLength(1)
        expect(updates.llmStats[0].ttftMs).toBe(800)
        expect(updates.llmStats[0].decodeMs).toBe(5000)
        expect(updates.llmStats[0].tokensPerSecond).toBe(40)
        expect(updates.llmStats[0].providerName).toBe('MiniMax')
        // ★ B1 唯一源：不再通过 IPC 写回 llm_stats 列（llm_usage 为主进程唯一写入源）
        expect(mockElectronUpdate).not.toHaveBeenCalled()
    })

    it('无新字段时不报错', () => {
        handleLlmCallDone(ctx({
            type: 'llm_call_done',
            inputTokens: 100,
            outputTokens: 200,
            provider: 'test',
            providerType: 'test',
            model: 'm',
            duration: 5000,
        }) as any)

        expect(mockUpdate).toHaveBeenCalledTimes(1)
        const [, , updates] = mockUpdate.mock.calls[0]
        expect(updates.llmStats[0].ttftMs).toBeUndefined()
        expect(updates.llmStats[0].tokensPerSecond).toBeUndefined()
        // ★ B1 唯一源：内存态更新保留，IPC 写回已移除
        expect(mockElectronUpdate).not.toHaveBeenCalled()
    })
})
