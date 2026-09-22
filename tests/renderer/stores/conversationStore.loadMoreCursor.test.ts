/**
 * T5 双键游标回归测试 —— 修「同毫秒消息跨 LIMIT 边界永久漏取」
 *
 * 缺陷：`loadMoreMessages` 的游标只有 `existing[0].timestamp`，主进程
 * `readMessagesBefore` 是 `WHERE timestamp < ? ORDER BY timestamp DESC, rowid DESC LIMIT ?`。
 * 当同一毫秒（ts 相同）的消息条数超过 pageSize、被 LIMIT 切在边界时，DB 侧同 ts 的
 * 更早消息被严格 `<` 永久排除，永远取不回来（pageSize=2 放大触发概率）。
 *
 * 契约：游标必须是 (timestamp, id) 双键 —— 渲染端把 `existing[0].id` 作为**第 4 个可选参数**
 * 追加传给 `conversationReadBefore`；IPC 通道名与既有参数顺序不变（只允许追加可选参数）。
 *
 * 隔离：mock window.electronAPI / agentStore，用一个「按 SQL 语义执行」的假 DB 模拟主进程分页：
 *   - 提供了 beforeId → 双键语义 `(ts < ? OR (ts = ? AND rowid < cursor))`
 *   - 未提供 beforeId → 旧单键语义 `ts < ?`（当前生产行为，即红灯来源）
 * 数组下标即 rowid 序（DB 中 rowid 严格递增）。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
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
const ORDER_ID = 'conv-cursor'

/** 假 DB：数组下标 = rowid 序 */
let DB: Message[] = []

const beforeCalls: Array<{convId: string; beforeTimestamp: number; count: number; beforeId?: string}> = []

function msg(id: string, role: 'user' | 'assistant', ts: number, content = id): Message {
    return {id, role, content, timestamp: ts}
}

/** 模拟 conversationRepository.readMessagesBefore 的 SQL 语义 */
function readBeforeLikeSql(convId: string, beforeTimestamp: number, count: number, beforeId?: string) {
    const cursorIdx = beforeId !== undefined ? DB.findIndex(m => m.id === beforeId) : -1
    const rows = DB.map((m, i) => ({m, i})).filter(({m, i}) => {
        if (m.timestamp < beforeTimestamp) return true
        // 双键分支：仅当调用方下传了游标 id 时，才取「同 ts 且 rowid 更小」的那批
        return beforeId !== undefined && m.timestamp === beforeTimestamp && cursorIdx >= 0 && i < cursorIdx
    })
    // ORDER BY timestamp DESC, rowid DESC → LIMIT → reverse()（与 repo 实现一致）
    rows.sort((a, b) => (b.m.timestamp - a.m.timestamp) || (b.i - a.i))
    return {messages: rows.slice(0, count).map(r => r.m).reverse(), totalCount: DB.length}
}

function setup(existing: Message[]) {
    beforeCalls.length = 0
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ROOT_ID,
        workspaces: {
            '/ws': {
                lastOpenedAt: 0,
                conversations: [
                    {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    {id: ORDER_ID, title: 'cursor', preview: '', createdAt: 0, updatedAt: 0, parentConvId: ROOT_ID},
                ],
            },
        },
        messagesMap: {[ROOT_ID]: [], [ORDER_ID]: existing},
        loadedMessages: [],
        hasMoreMap: {[ORDER_ID]: true},
        loadingMoreMap: {},
    })
}

beforeEach(() => {
    DB = []
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            conversationReadMessages: vi.fn(async () => []),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            conversationReadBefore: vi.fn(
                async (convId: string, beforeTimestamp: number, count: number, beforeId?: string) => {
                    beforeCalls.push({convId, beforeTimestamp, count, beforeId})
                    return readBeforeLikeSql(convId, beforeTimestamp, count, beforeId)
                },
            ),
        },
    }
    setup([])
})

function currentMsgs(): Message[] {
    return useConversationStore.getState().messagesMap[ORDER_ID] || []
}

describe('T5 双键游标：同毫秒消息跨 LIMIT 边界不丢不重', () => {
    it('C1 边界同 ts 组被 LIMIT 切开 → 连续两次 loadMoreMessages 后条数守恒、无丢失、无重复', async () => {
        // rowid 序：a,b,c(ts=1000) / d,e(ts=2000) / f(ts=3000)
        // existing = tail(2) = [e,f]；游标 (2000, e) 处 ts=2000 被 LIMIT 切在 d|e 之间
        DB = [
            msg('a', 'user', 1000),
            msg('b', 'assistant', 1000),
            msg('c', 'user', 1000),
            msg('d', 'assistant', 2000),
            msg('e', 'user', 2000),
            msg('f', 'assistant', 3000),
        ]
        setup([msg('e', 'user', 2000), msg('f', 'assistant', 3000)])

        await useConversationStore.getState().loadMoreMessages(ORDER_ID, 2)
        await useConversationStore.getState().loadMoreMessages(ORDER_ID, 2)

        const msgs = currentMsgs()
        expect(msgs.map(m => m.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
        expect(msgs.map(m => m.timestamp)).toEqual([1000, 1000, 1000, 2000, 2000, 3000])
        // 条数守恒 + 无重复
        expect(msgs).toHaveLength(DB.length)
        expect(new Set(msgs.map(m => m.id)).size).toBe(DB.length)
        expect(useConversationStore.getState().hasMoreMap[ORDER_ID]).toBe(false)
    })

    it('C2 游标以 (timestamp, id) 双键下传：IPC 第 4 参 = existing 首条 id', async () => {
        DB = [msg('x', 'user', 500), msg('e', 'user', 2000), msg('f', 'assistant', 3000)]
        setup([msg('e', 'user', 2000), msg('f', 'assistant', 3000)])

        await useConversationStore.getState().loadMoreMessages(ORDER_ID, 2)

        expect(beforeCalls).toHaveLength(1)
        expect(beforeCalls[0]).toEqual({
            convId: ORDER_ID,
            beforeTimestamp: 2000,
            count: 2,
            beforeId: 'e',
        })
        // 同 ts（2000）的更早消息 x 不应被误取，ts<2000 的 x 才应被取回
        expect(currentMsgs().map(m => m.id)).toEqual(['x', 'e', 'f'])
    })

    it('C3 终止性：同 ts 组条数 > LIMIT，逐页取尽后 hasMore=false，不死循环', async () => {
        DB = [
            msg('p1', 'user', 1000),
            msg('p2', 'user', 1000),
            msg('p3', 'user', 1000),
            msg('p4', 'user', 1000),
            msg('p5', 'assistant', 1500),
        ]
        setup([msg('p5', 'assistant', 1500)])

        let rounds = 0
        while (useConversationStore.getState().hasMoreMap[ORDER_ID] !== false && rounds < 10) {
            await useConversationStore.getState().loadMoreMessages(ORDER_ID, 2)
            rounds++
        }

        // 两轮：p3,p4 → p1,p2；第三轮空返回触发 hasMore=false（轮次数有限）
        expect(rounds).toBe(2)
        expect(currentMsgs().map(m => m.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
        expect(currentMsgs()).toHaveLength(DB.length)
        expect(new Set(currentMsgs().map(m => m.id)).size).toBe(DB.length)
        expect(useConversationStore.getState().hasMoreMap[ORDER_ID]).toBe(false)
    })
})
