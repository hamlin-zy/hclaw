/**
 * conversationStore 渲染层加固 · 回归测试（第 1 项 + 补的不变量）
 *
 * 覆盖：
 * 1) `loadMessagesInitial` 无 in-flight 去重 → 并发读取同一会话会重复发起
 *    `conversationReadTail`（`switchActiveConversation` 与预热/`preloadConversation`
 *    会对同一 convId 同时发起）。修复：模块级 Map<convId, Promise> 复用同一 Promise。
 * 1b) 驱逐后迟到写回破坏 messagesMap 上限不变量：`loadMessagesInitial` 写回后未调用
 *    `enforceMessagesMapSizeLimit()`，在途响应落地时键数可超过每项目常驻预算
 *    （Task 17 前为全局 MAX_MESSAGES_MAP_SIZE=20，现为 MAX_RESIDENT_PER_PROJECT=3）。
 *
 * 隔离：mock agentStore / electronAPI（不触碰真实 IPC / SQLite）。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const mockAgent = vi.hoisted(() => ({
    convAgentStates: {} as Record<string, any>,
    removeConvDataCalls: [] as string[],
}))

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: mockAgent.convAgentStates,
            updateConvData: () => {},
            removeConvData: (id: string) => { mockAgent.removeConvDataCalls.push(id) },
            flushPendingStreamData: () => {},
            reconcileStreamingContent: () => {},
            refreshActiveBatch: () => {},
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

/** 与实现常量一致（Task 17：每项目常驻预算）；实现改动时此处红灯 */
const MAP_MAX = 3

function userMsg(convId: string, content = `正文-${convId}`): Message {
    return {id: `m-${convId}`, role: 'user', content, timestamp: 1}
}

const readTailMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())

beforeEach(() => {
    readTailMock.mockReset()
    listMock.mockReset()
    mockAgent.convAgentStates = {}
    mockAgent.removeConvDataCalls.length = 0
    ;(globalThis as any).window = {
        electronAPI: {
            conversationReadTail: readTailMock,
            conversationList: listMock,
            workspace: {
                getCurrent: vi.fn(async () => ({path: '/ws'})),
                getGitBranch: vi.fn(async () => null),
            },
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: null,
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {},
        loadedMessages: [],
        hasMoreMap: {},
        loadingMoreMap: {},
        renderedConversationIds: [],
        conversationLastActiveAt: {},
    })
})

// ─────────────────────────────────────────────────────────
// 1) loadMessagesInitial in-flight 去重
// ─────────────────────────────────────────────────────────

describe('1) loadMessagesInitial in-flight 去重', () => {
    it('并发调用同一 convId → 底层 conversationReadTail 只发生一次，且共享同一 Promise', async () => {
        let resolveTail!: (v: any) => void
        readTailMock.mockImplementation(() => new Promise(r => { resolveTail = r }))

        const store = useConversationStore.getState()
        const p1 = store.loadMessagesInitial('c1')
        const p2 = store.loadMessagesInitial('c1')

        // 底层读取只发生一次
        expect(readTailMock).toHaveBeenCalledTimes(1)
        // 共享同一 Promise
        expect(p1).toBe(p2)

        resolveTail({messages: [userMsg('c1')], totalCount: 1})
        await Promise.all([p1, p2])

        expect(readTailMock).toHaveBeenCalledTimes(1)
        expect(useConversationStore.getState().messagesMap['c1']).toHaveLength(1)
    })

    it('preloadConversation 与 loadMessagesInitial 走同一去重入口（不重复读）', async () => {
        let resolveTail!: (v: any) => void
        readTailMock.mockImplementation(() => new Promise(r => { resolveTail = r }))

        const store = useConversationStore.getState()
        const p1 = store.loadMessagesInitial('c2')
        const p2 = store.preloadConversation('c2')

        // 底层读取只发生一次（preloadConversation 是 async 包装，引用不保证相同）
        expect(readTailMock).toHaveBeenCalledTimes(1)

        resolveTail({messages: [userMsg('c2')], totalCount: 1})
        await Promise.all([p1, p2])
        expect(readTailMock).toHaveBeenCalledTimes(1)
    })

    it('预热（loadConversations）与显式 loadMessagesInitial 并发时同一会话只读一次', async () => {
        const ROOT = 'conv-root'
        const list = [
            {id: 'conv-a', title: 'a', workspacePath: '/ws', createdAt: 1, updatedAt: 1},
            {id: 'conv-b', title: 'b', workspacePath: '/ws', createdAt: 2, updatedAt: 2},
            {id: ROOT, title: 'root', workspacePath: '/ws', createdAt: 3, updatedAt: 3},
        ]
        listMock.mockResolvedValue(list)

        // 根会话立即返回（loadConversations 会 await 它）；预热目标挂起 → 保证预热处于在途
        const pending = new Map<string, (v: any) => void>()
        readTailMock.mockImplementation((id: string) => {
            if (id === ROOT) return Promise.resolve({messages: [userMsg(id)], totalCount: 1})
            return new Promise(r => { pending.set(id, r) })
        })

        const p = useConversationStore.getState().loadConversations()
        await p // 根会话已加载，预热 IIFE 已对 conv-a / conv-b 发起读取（在途）

        const readsOf = (id: string) => readTailMock.mock.calls.filter(c => c[0] === id).length
        expect(readsOf('conv-a')).toBe(1)

        // 并发地对正在预热的同一会话发起显式加载 → 必须复用，不新增读取
        const explicit = useConversationStore.getState().loadMessagesInitial('conv-a')
        expect(readsOf('conv-a')).toBe(1)

        for (const [, resolve] of pending) resolve({messages: [userMsg('x')], totalCount: 1})
        await explicit
        expect(readsOf('conv-a')).toBe(1)
    })

    it('settle 后去重入口被清理：再次调用会重新读取（不是永久缓存）', async () => {
        readTailMock.mockResolvedValue({messages: [userMsg('c3')], totalCount: 1})
        const store = useConversationStore.getState()

        await store.loadMessagesInitial('c3')
        expect(readTailMock).toHaveBeenCalledTimes(1)

        await store.loadMessagesInitial('c3')
        expect(readTailMock).toHaveBeenCalledTimes(2)
    })
})

// ─────────────────────────────────────────────────────────
// 1b) 迟到写回仍满足 messagesMap 上限不变量
// ─────────────────────────────────────────────────────────

describe('1b) loadMessagesInitial 写回后执行数量上限约束', () => {
    it('驱逐后迟到响应写回不会把键数顶到上限之上', async () => {
        // 先塞满 MAP_MAX 个同项目会话（conv-0 最旧 … conv-4 最新）+
        // 待水合的 conv-new（Task 17：项目归属反查读 workspaces.conversations，故须注册）
        const map: Record<string, Message[]> = {}
        const lastActive: Record<string, number> = {}
        const conversations = Array.from({length: MAP_MAX + 2}, (_, i) => ({
            id: `conv-${i}`, title: `t${i}`, preview: '', createdAt: 1, updatedAt: 1,
        }))
        conversations.push({id: 'conv-new', title: 'conv-new', preview: '', createdAt: 1, updatedAt: 1})
        for (let i = 0; i < MAP_MAX + 2; i++) {
            map[`conv-${i}`] = [userMsg(`conv-${i}`)]
            lastActive[`conv-${i}`] = 1000 + i
        }
        useConversationStore.setState({
            messagesMap: map,
            conversationLastActiveAt: lastActive,
            renderedConversationIds: Object.keys(map),
            activeConversationId: 'conv-4',
            workspaces: {'/ws': {lastOpenedAt: 0, conversations}},
        })

        // 切换新会话（uncached）→ 读取在途；此时 messagesMap 已超每项目预算
        let resolveTail!: (v: any) => void
        readTailMock.mockImplementation(() => new Promise(r => { resolveTail = r }))
        const pending = useConversationStore.getState().loadMessagesInitial('conv-new')

        // 模拟 switchActiveConversation：先登记为最新活跃，再等待在途响应落地
        useConversationStore.getState().markConversationRendered('conv-new')
        useConversationStore.setState({activeConversationId: 'conv-new'})

        resolveTail({messages: [userMsg('conv-new')], totalCount: 1})
        await pending

        const s = useConversationStore.getState()
        // 写回后必须回落 ≤ 每项目预算（迟到写回触发一次 enforce）
        expect(Object.keys(s.messagesMap).length).toBeLessThanOrEqual(MAP_MAX)
        expect(s.messagesMap['conv-new']).toBeDefined()
        // 最久未激活者被驱逐
        expect(s.messagesMap['conv-0']).toBeUndefined()
    })
})
