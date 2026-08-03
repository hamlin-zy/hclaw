/**
 * conversationStore 增量落库（delta-first persistence）单元测试
 *
 * 覆盖本次性能优化（优化 2+3+4）：
 * - addMessageToConv / updateMessageForConv 只触发增量写（conversationWriteMessagesDelta），
 *   不触发全量写（conversationWriteMessages）
 * - 高频流式更新被 debounce 合并：N 次更新只产生一次 delta IPC 调用
 * - 多条 dirty 消息一次性 flush，且只写变化的消息
 * - flushMessages（abort 场景）强制立即刷 dirty
 * - saveMessages 优先刷 dirty，无 dirty 时才走全量兜底
 *
 * 隔离：mock window.electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

// mock agentStore（conversationStore 依赖它，但仅 action 内部惰性调用 getState）
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            getState: () => ({convAgentStates: {}, activeConversationId: null}),
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

// mock search（纯函数，真实实现也可用，但保持轻量）
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

function makeMsg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): Message {
    return {id, role, content, timestamp: Date.now()}
}

let deltaCalls: Array<{convId: string; message: Message}>
let fullCalls: Array<{convId: string; messages: Message[]}>

beforeEach(() => {
    deltaCalls = []
    fullCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationWriteMessagesDelta: vi.fn(async (convId: string, message: Message) => {
                deltaCalls.push({convId, message})
                return true
            }),
            conversationWriteMessages: vi.fn(async (convId: string, messages: Message[]) => {
                fullCalls.push({convId, messages})
                return true
            }),
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: 'conv-1',
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {'conv-1': []},
        loadedMessages: [],
    })
})

afterEach(() => {
    vi.useRealTimers()
    // 清空 pending timers，避免跨用例泄漏
    useConversationStore.getState().cancelPendingSave()
})

describe('增量落库（delta-first）', () => {
    it('addMessageToConv 触发 delta 写，不触发全量写', async () => {
        vi.useFakeTimers()
        useConversationStore.getState().addMessageToConv('conv-1', makeMsg('m1', 'hello'))
        await vi.advanceTimersByTimeAsync(1200)

        expect(deltaCalls.length).toBe(1)
        expect(deltaCalls[0].message.id).toBe('m1')
        expect(fullCalls.length).toBe(0)
    })

    it('高频流式更新被 debounce 合并为一次 delta 写', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        // 模拟流式 10 次增量文本更新（同一消息）
        for (let i = 0; i < 10; i++) {
            store.addMessageToConv('conv-1', makeMsg('m1', `chunk${i}`))
            store.updateMessageForConv('conv-1', 'm1', {content: `chunk${i + 1}`})
        }
        // debounce 窗口内不应有任何调用
        expect(deltaCalls.length).toBe(0)

        await vi.advanceTimersByTimeAsync(2100)
        expect(deltaCalls.length).toBe(1)
        expect(deltaCalls[0].message.id).toBe('m1')
        expect(fullCalls.length).toBe(0)
    })

    it('多条不同消息各自入 dirty，flush 时全部写入', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        store.addMessageToConv('conv-1', makeMsg('m2', 'b'))
        await vi.advanceTimersByTimeAsync(2100)

        expect(deltaCalls.length).toBe(2)
        expect(deltaCalls.map(c => c.message.id).sort()).toEqual(['m1', 'm2'])
        expect(fullCalls.length).toBe(0)
    })

    it('flushMessages 强制立即刷 dirty（abort 场景）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        expect(deltaCalls.length).toBe(0) // debounce 未到期

        store.flushMessages()
        await Promise.resolve()

        expect(deltaCalls.length).toBe(1)
        expect(deltaCalls[0].message.id).toBe('m1')
    })

    it('saveMessages 优先刷 dirty；无 dirty 时才全量兜底', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        // 场景 1：有 dirty → 只走 delta
        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        await store.saveMessages()
        expect(deltaCalls.length).toBe(1)
        expect(fullCalls.length).toBe(0)

        // 场景 2：无 dirty（已 flush）→ 全量兜底
        await store.saveMessages()
        expect(fullCalls.length).toBe(1)
    })

    it('updateMessageForConv 修改后再次落库携带最新内容', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'v1'))
        store.updateMessageForConv('conv-1', 'm1', {content: 'v2'})
        await vi.advanceTimersByTimeAsync(2100)

        expect(deltaCalls).toHaveLength(1)
        expect(deltaCalls[0].message.content).toBe('v2')
    })

    it('cancelPendingSave 后不再落库（compact 场景）', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv('conv-1', makeMsg('m1', 'a'))
        store.cancelPendingSave()

        await vi.advanceTimersByTimeAsync(5000)
        expect(deltaCalls.length).toBe(0)
    })
})
