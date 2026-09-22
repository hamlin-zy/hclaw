/**
 * 渲染端消息序不变量（INV-ORDER）回归测试
 *
 * 契约：messagesMap[convId] 恒为「按 timestamp 升序、同值保持既有相对顺序」的稳定序列。
 * 所有以数组序当时间序的消费者（气泡渲染、用户消息导航、loadMoreMessages 游标）都依赖它。
 *
 * 覆盖缺陷：首次打开子会话偶发 user / assistant 气泡上下颠倒 —— 内存数组顺序被直接采信，
 * 切走切回不复原（不排序分支），只有整段重载（重开/驱逐）才自愈。
 *
 * 隔离：mock window.electronAPI / agentStore，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const convAgentStates = {
    'conv-order': {
        agentState: {status: 'running' as const, mode: 'auto' as const, phase: 'responding' as const},
        streamingMessageId: null,
    },
}

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates,
            updateConvData: () => {},
            removeConvData: () => {},
            clearConvDoneUnread: () => {},
            flushPendingStreamData: () => {},
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const ROOT_ID = 'conv-root'
const ORDER_ID = 'conv-order'

const readBeforeArgs: Array<{convId: string; before: number}> = []

function msg(id: string, role: 'user' | 'assistant', ts: number, content = id): Message {
    return {id, role, content, timestamp: ts}
}

function setup(seed: Message[]) {
    readBeforeArgs.length = 0
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ROOT_ID,
        workspaces: {
            '/ws': {
                lastOpenedAt: 0,
                conversations: [
                    {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    {id: ORDER_ID, title: 'order', preview: '', createdAt: 0, updatedAt: 0, parentConvId: ROOT_ID},
                ],
            },
        },
        messagesMap: {[ROOT_ID]: [], [ORDER_ID]: seed},
        loadedMessages: [],
        hasMoreMap: {[ORDER_ID]: true},
        loadingMoreMap: {},
    })
}

type ElectronAPIMock = {
    conversationReadMessages: ReturnType<typeof vi.fn>
    conversationReadTail: ReturnType<typeof vi.fn>
    conversationReadBefore: ReturnType<typeof vi.fn>
}

/** 取 beforeEach 挂载在 globalThis.window 上的 electronAPI mock 集合 */
function apiMock(): ElectronAPIMock {
    return (globalThis as unknown as {window: {electronAPI: ElectronAPIMock}}).window.electronAPI
}

beforeEach(() => {
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            conversationReadMessages: vi.fn(async () => []),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            conversationReadBefore: vi.fn(async (convId: string, before: number) => {
                readBeforeArgs.push({convId, before})
                return {messages: [], totalCount: 0}
            }),
        },
    }
    setup([])
})

describe('INV-ORDER：渲染端消息数组恒为时间序', () => {
    it('T1 内存数组乱序（[assistant, user]）且已有 user：切回即校正为时间序', async () => {
        // 缺陷现场：assistant 先落内存（ts 大），user 后落但时间更早 → 数组序 = [assistant, user]
        setup([msg('msg-a', 'assistant', 200), msg('msg-u', 'user', 100)])

        await useConversationStore.getState().setActiveConversation(ORDER_ID)

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id)).toEqual(['msg-u', 'msg-a'])
        // 全局镜像 loadedMessages 同步为同一有序数组
        expect((useConversationStore.getState().loadedMessages || []).map(m => m.id)).toEqual(['msg-u', 'msg-a'])
    })

    it('T2 addMessageToConv 显式传入更早的 timestamp：插入到时间序正确位置', () => {
        setup([msg('msg-u', 'user', 100), msg('msg-a', 'assistant', 300)])

        useConversationStore.getState().addMessageToConv(ORDER_ID, {id: 'msg-mid', role: 'assistant', content: 'mid'}, 200)

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id)).toEqual(['msg-u', 'msg-mid', 'msg-a'])
        expect(msgs[1].timestamp).toBe(200)
    })

    it('T3 不传 timestamp（乐观 user 路径）：仍落在末尾且 ts 为当前时刻', () => {
        setup([msg('msg-u', 'user', 100), msg('msg-a', 'assistant', 300)])
        const before = Date.now()

        useConversationStore.getState().addMessageToConv(ORDER_ID, {role: 'user', content: '新消息'})

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id).slice(0, 2)).toEqual(['msg-u', 'msg-a'])
        expect(msgs[2].role).toBe('user')
        expect(msgs[2].timestamp).toBeGreaterThanOrEqual(before)
    })

    it('T4 同 timestamp：后写入者靠后（稳定序，与 DB rowid 口径一致）', () => {
        setup([msg('msg-1', 'user', 100)])
        useConversationStore.getState().addMessageToConv(ORDER_ID, {id: 'msg-2', role: 'assistant', content: '2'}, 100)
        useConversationStore.getState().addMessageToConv(ORDER_ID, {id: 'msg-3', role: 'assistant', content: '3'}, 100)

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    })

    it('T5 切回后 loadMoreMessages 的游标取数组首条（真实最早）的 timestamp', async () => {
        setup([msg('msg-a', 'assistant', 200), msg('msg-u', 'user', 100)])

        await useConversationStore.getState().setActiveConversation(ORDER_ID)
        await useConversationStore.getState().loadMoreMessages(ORDER_ID)

        expect(readBeforeArgs).toHaveLength(1)
        // 有序后首条是 ts=100 的 user；乱序时会错取 200
        expect(readBeforeArgs[0]).toEqual({convId: ORDER_ID, before: 100})
    })

    it('T6 loadMessages 全量读回：IPC 返回乱序 → 写入 messagesMap 即升序', async () => {
        apiMock().conversationReadMessages = vi.fn(async () => [
            msg('m-late', 'assistant', 300),
            msg('m-early', 'user', 100),
            msg('m-mid', 'assistant', 200),
        ])

        await useConversationStore.getState().loadMessages(ORDER_ID)

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id)).toEqual(['m-early', 'm-mid', 'm-late'])
        expect(msgs.map(m => m.timestamp)).toEqual([100, 200, 300])
    })

    it('T7 loadMessagesInitial 尾部分页：IPC 返回乱序 → 写入即升序且 hasMore 判定不变', async () => {
        apiMock().conversationReadTail = vi.fn(async () => ({
            messages: [msg('t-late', 'assistant', 300), msg('t-early', 'user', 100)],
            totalCount: 5,
        }))

        await useConversationStore.getState().loadMessagesInitial(ORDER_ID, 2)

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id)).toEqual(['t-early', 't-late'])
        // 条数守恒：仍为返回的 2 条；hasMore 判定沿用 length < totalCount
        expect(msgs).toHaveLength(2)
        expect(useConversationStore.getState().hasMoreMap[ORDER_ID]).toBe(true)
    })

    it('T8 loadMoreMessages 同 timestamp 跨游标边界 + olderMsgs 乱序 → 拼接整体升序、条数守恒', async () => {
        // existing 首条 ts=200 即游标；mock 出的 olderMsgs 含与游标同 ts 的 o2（边界两侧）、
        // 且整体顺序非升序（模拟返回序不可信）。
        setup([msg('e1', 'user', 200), msg('e2', 'assistant', 300)])
        apiMock().conversationReadBefore = vi.fn(async () => ({
            messages: [msg('o2', 'assistant', 200), msg('o1', 'user', 100)],
            totalCount: 4,
        }))

        await useConversationStore.getState().loadMoreMessages(ORDER_ID)

        const msgs = useConversationStore.getState().messagesMap[ORDER_ID] || []
        expect(msgs.map(m => m.id)).toEqual(['o1', 'o2', 'e1', 'e2'])
        expect(msgs.map(m => m.timestamp)).toEqual([100, 200, 200, 300])
        // 条数守恒：olderMsgs(2) + existing(2)，无丢失、无重复
        expect(msgs).toHaveLength(4)
        expect(new Set(msgs.map(m => m.id)).size).toBe(4)
        expect(useConversationStore.getState().hasMoreMap[ORDER_ID]).toBe(false)
    })
})
