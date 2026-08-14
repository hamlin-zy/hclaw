// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import type {ContentBlock} from '../../../src/shared/types'

// conversationStore 真实 zustand store 依赖 window.electronAPI（invoke 写库），
// jsdom 下 undefined 走 ?? true 兜底不崩溃；此处 mock electronAPI 防意外
beforeEach(() => {
    vi.stubGlobal('window', {electronAPI: undefined})
})

// 直接 import store 模块（zustand 工厂在模块加载时执行）
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const convId = 'conv-1'
const msgId = 'msg-1'
const blockA: ContentBlock = {id: 'text-msg-1-0', type: 'text', text: '甲'}
const blockB: ContentBlock = {id: 'think-msg-1-0', type: 'think', thinkBlock: {id: 'think-msg-1-0', content: '想', status: 'thinking', timestamp: 1}}
const blockB2: ContentBlock = {id: 'think-msg-1-0', type: 'think', thinkBlock: {id: 'think-msg-1-0', content: '想想', status: 'thinking', timestamp: 2}}

describe('updateMessageBlockForConv — 块级引用更新', () => {
    beforeEach(() => {
        useConversationStore.getState().addMessageToConv(convId, {
            id: msgId, role: 'assistant', content: '甲',
        })
        // 先写入初始 contentBlocks
        useConversationStore.getState().updateMessageForConv(convId, msgId, {contentBlocks: [blockA, blockB]})
    })

    it('替换指定 id 块：目标块更新，其他块引用不变', () => {
        const store = useConversationStore.getState()
        const before = store.messagesMap[convId].find(m => m.id === msgId)!.contentBlocks!
        const aRef = before[0]
        store.updateMessageBlockForConv(convId, msgId, blockB.id, blockB2)
        const after = useConversationStore.getState().messagesMap[convId].find(m => m.id === msgId)!.contentBlocks!
        expect(after[0]).toBe(aRef)                 // ★ 未变化块引用不变（React.memo 可 bail out）
        expect(after[1].id).toBe(blockB.id)
        expect((after[1] as any).thinkBlock.content).toBe('想想')
        expect(after.length).toBe(2)
    })

    it('无该 id 时追加到末尾', () => {
        const store = useConversationStore.getState()
        const newBlock: ContentBlock = {id: 'text-msg-1-2', type: 'text', text: '尾'}
        store.updateMessageBlockForConv(convId, msgId, newBlock.id, newBlock)
        const after = useConversationStore.getState().messagesMap[convId].find(m => m.id === msgId)!.contentBlocks!
        expect(after.length).toBe(3)
        expect(after[2].id).toBe('text-msg-1-2')
    })

    it('找不到 message 安全返回，不抛错', () => {
        const store = useConversationStore.getState()
        expect(() => store.updateMessageBlockForConv(convId, 'no-such-msg', blockB.id, blockB2)).not.toThrow()
    })
})
