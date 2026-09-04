// @vitest-environment jsdom
/**
 * removeEmptyAssistantMessage 空占位气泡清理测试
 *
 * 缺陷：用户发送消息后立即手动终止（abort），MessageList 残留一个空白 assistant 气泡。
 *
 * 根因：handleBegin/ensureStreamingMessage 在 LLM 首 token 前创建空占位消息
 *   （content: ''，无 contentBlocks/thinkBlock/toolCalls），用户立即 abort 时
 *   abortAgentImpl/handleDone 只补 endedAt，从不移除该空占位 → 空白气泡残留。
 *
 * 修复：abort/done(aborted) 收尾时，若 assistant 消息为空则从 messagesMap 移除。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {isAssistantMessageEmpty} from '../../../../src/renderer/stores/agentStore/helpers/convHelpers'
import {removeEmptyAssistantMessage} from '../../../../src/renderer/stores/agentStore/helpers/convHelpers'
import type {Message} from '../../../../src/shared/types'

// ── mock conversationStore ──
const mockMessagesMap: Record<string, Message[]> = {}
const deletedCalls: Array<{convId: string; id: string}> = []
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            messagesMap: mockMessagesMap,
            activeConversationId: 'conv-1',
            deleteMessageForConv: (convId: string, id: string) => {
                deletedCalls.push({convId, id})
                mockMessagesMap[convId] = (mockMessagesMap[convId] || []).filter(m => m.id !== id)
            },
        }),
    },
}))

describe('isAssistantMessageEmpty', () => {
    it('空占位（仅空 content）→ true', () => {
        const msg = {id: 'm1', role: 'assistant', content: '', timestamp: 1} as Message
        expect(isAssistantMessageEmpty(msg)).toBe(true)
    })

    it('空占位（无 content 字段）→ true', () => {
        const msg = {id: 'm1', role: 'assistant', timestamp: 1} as unknown as Message
        expect(isAssistantMessageEmpty(msg)).toBe(true)
    })

    it('有正文 → false', () => {
        const msg = {id: 'm1', role: 'assistant', content: '你好', timestamp: 1} as Message
        expect(isAssistantMessageEmpty(msg)).toBe(false)
    })

    it('有思考块 → false', () => {
        const msg = {id: 'm1', role: 'assistant', content: '', thinkBlock: {id: 't', content: '思考', status: 'complete', timestamp: 1}} as Message
        expect(isAssistantMessageEmpty(msg)).toBe(false)
    })

    it('有工具调用 → false', () => {
        const msg = {id: 'm1', role: 'assistant', content: '', toolCalls: [{id: 'tc', name: 'bash', arguments: {}}]} as unknown as Message
        expect(isAssistantMessageEmpty(msg)).toBe(false)
    })

    it('有 contentBlocks → false', () => {
        const msg = {id: 'm1', role: 'assistant', content: '', contentBlocks: [{id: 'b', type: 'text', text: 'x'}]} as Message
        expect(isAssistantMessageEmpty(msg)).toBe(false)
    })

    it('非 assistant（user）→ false', () => {
        const msg = {id: 'm1', role: 'user', content: '', timestamp: 1} as Message
        expect(isAssistantMessageEmpty(msg)).toBe(false)
    })
})

describe('removeEmptyAssistantMessage', () => {
    beforeEach(() => {
        deletedCalls.length = 0
        for (const k of Object.keys(mockMessagesMap)) delete mockMessagesMap[k]
    })

    it('空 assistant 消息 → 从 messagesMap 移除', () => {
        mockMessagesMap['conv-1'] = [
            {id: 'user-1', role: 'user', content: 'hi', timestamp: 1},
            {id: 'assist-1', role: 'assistant', content: '', timestamp: 2},
        ]
        removeEmptyAssistantMessage('conv-1', 'assist-1')
        expect(mockMessagesMap['conv-1'].map(m => m.id)).toEqual(['user-1'])
        expect(deletedCalls).toEqual([{convId: 'conv-1', id: 'assist-1'}])
    })

    it('有内容的 assistant 消息 → 不删除', () => {
        mockMessagesMap['conv-1'] = [
            {id: 'user-1', role: 'user', content: 'hi', timestamp: 1},
            {id: 'assist-1', role: 'assistant', content: '有内容', timestamp: 2},
        ]
        removeEmptyAssistantMessage('conv-1', 'assist-1')
        expect(mockMessagesMap['conv-1'].map(m => m.id)).toEqual(['user-1', 'assist-1'])
        expect(deletedCalls).toHaveLength(0)
    })

    it('messageId 为 null/undefined → 不操作', () => {
        mockMessagesMap['conv-1'] = [{id: 'assist-1', role: 'assistant', content: '', timestamp: 2}]
        removeEmptyAssistantMessage('conv-1', null)
        removeEmptyAssistantMessage('conv-1', undefined)
        expect(mockMessagesMap['conv-1']).toHaveLength(1)
        expect(deletedCalls).toHaveLength(0)
    })

    it('消息不存在 → 不操作', () => {
        mockMessagesMap['conv-1'] = []
        removeEmptyAssistantMessage('conv-1', 'ghost')
        expect(deletedCalls).toHaveLength(0)
    })
})
