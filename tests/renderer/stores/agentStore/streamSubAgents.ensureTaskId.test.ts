import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── 依赖 mock：conversationStore 用 hoisted 状态（工厂被提升，必须 hoisted 引用） ──
const {mockState, mockUpdate, mockUpdateToolCall} = vi.hoisted(() => {
    type MockToolCall = {id: string; name: string; arguments: Record<string, unknown>; status: string; taskId?: string}
    return {
        mockState: {
            messagesMap: {
                'conv-root': [
                    {
                        id: 'msg-1',
                        role: 'assistant',
                        toolCalls: [
                            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'success'},
                        ] as MockToolCall[],
                    },
                ],
            },
        },
        mockUpdate: vi.fn(),
        mockUpdateToolCall: vi.fn(),
    }
})

// 被测模块（src/renderer/stores/agentStore/handlers/streamSubAgents.ts）用相对路径
// '../../conversationStore' 与 '../../toolCallsStore' 导入，此处按被测模块的解析路径 mock。
vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({messagesMap: mockState.messagesMap, updateMessageForConv: mockUpdate}),
    },
}))

vi.mock('@/renderer/stores/toolCallsStore', () => ({
    useToolCallsStore: {getState: () => ({updateToolCall: mockUpdateToolCall})},
}))

import {ensureAgentToolTaskId} from '@/renderer/stores/agentStore/handlers/streamSubAgents'

describe('ensureAgentToolTaskId — 子会话关联补写（需求1 链路）', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockState.messagesMap['conv-root'][0].toolCalls[0].taskId = undefined
    })

    it('agent 工具无 taskId 时补写 childConvId', () => {
        ensureAgentToolTaskId('conv-root', 'tc-agent', 'conv-child-1')
        expect(mockUpdate).toHaveBeenCalledTimes(1)
        const [convId, msgId, updates] = mockUpdate.mock.calls[0]
        expect(convId).toBe('conv-root')
        expect(msgId).toBe('msg-1')
        expect(updates.toolCalls[0].taskId).toBe('conv-child-1')
        // 其余字段不变
        expect(updates.toolCalls[0].id).toBe('tc-agent')
        expect(updates.toolCalls[0].name).toBe('agent')
    })

    it('已存在相同 taskId 时幂等跳过', () => {
        mockState.messagesMap['conv-root'][0].toolCalls[0].taskId = 'conv-child-1'
        ensureAgentToolTaskId('conv-root', 'tc-agent', 'conv-child-1')
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('toolCallId 缺失时直接返回', () => {
        ensureAgentToolTaskId('conv-root', undefined, 'conv-child-1')
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('childConvId 缺失时直接返回', () => {
        ensureAgentToolTaskId('conv-root', 'tc-agent', '')
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('找不到 toolCallId 时不调用更新', () => {
        ensureAgentToolTaskId('conv-root', 'tc-no-such', 'conv-child-1')
        expect(mockUpdate).not.toHaveBeenCalled()
    })
})
