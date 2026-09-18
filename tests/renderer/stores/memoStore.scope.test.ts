/**
 * memoStore 按作用域取数测试（Task 18）
 *
 * 覆盖：
 * - loadForScope：并行拉组内所有项目 → 按 id 合并；空作用域 → 清空且不调 IPC
 * - loadForScope 作用域级竞态：旧作用域请求晚归 → 整批丢弃
 * - load（单项目签名）行为不变（回归）
 * - subscribeMemoChangedForScope：推送项目属于当前作用域才 reload
 *
 * 隔离：node 环境 mock globalThis.window.electronAPI（形状对齐 preload：
 *   memo.* 在 electronAPI.memo 上、onMemoChanged 在 electronAPI 顶层），不触碰真实 IPC。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const convState: Record<string, unknown> = {viewScope: null, workspaces: {}}
    const useConversationStore = Object.assign(
        (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(convState) : convState),
        {getState: () => convState},
    )

    const groupState: {groups: Array<{id: string; members: Array<{projectPath: string}>}>} = {groups: []}
    const useProjectGroupStore = Object.assign(
        (selector?: (s: typeof groupState) => unknown) => (selector ? selector(groupState) : groupState),
        {getState: () => groupState},
    )

    const openConfigWindow = vi.fn()
    return {useConversationStore, convState, useProjectGroupStore, groupState, openConfigWindow}
})

// openMemoCreateWindow 的默认项目解析依赖这两个 store 的只读快照（此处 mock，不加载真实 store）
vi.mock('@/renderer/stores/conversationStore', () => ({useConversationStore: h.useConversationStore}))
vi.mock('@/renderer/stores/projectGroupStore', () => ({useProjectGroupStore: h.useProjectGroupStore}))

const api = {
    list: vi.fn(),
    update: vi.fn(),
    onMemoChanged: vi.fn((_h: (p: {workspacePath: string}) => void) => () => {}),
}

function memo(id: string, ws: string) {
    return {
        id, workspacePath: ws, title: id, content: '', status: 'active', priority: 'normal',
        pinned: false, sortIndex: 0, createdAt: 1, updatedAt: 1, attachments: [],
    }
}

beforeEach(() => {
    vi.resetAllMocks()
    ;(globalThis as {window?: unknown}).window = {
        electronAPI: {memo: api, onMemoChanged: api.onMemoChanged, openConfigWindow: h.openConfigWindow},
    }
    api.list.mockImplementation(async (ws: string) => ({ok: true, data: [memo(`m-${ws}`, ws)]}))
    // 默认项目解析的输入复位（各用例自行覆盖）
    h.convState.viewScope = null
    h.convState.workspaces = {}
    h.groupState.groups = []
})

import {useMemoStore, openMemoCreateWindow} from '@/renderer/stores/memoStore'

describe('loadForScope — 组视图合并取数', () => {
    it('并行拉取组内所有项目，按 id 合并（两个项目各 1 条 → 2 条）', async () => {
        await useMemoStore.getState().loadForScope(['/ws/a', '/ws/b'], 'group:pg-a')
        expect(api.list).toHaveBeenCalledTimes(2)
        expect(useMemoStore.getState().memos.map((m) => m.id).sort()).toEqual(['m-/ws/a', 'm-/ws/b'])
    })

    it('空作用域 → 清空列表且不调 IPC', async () => {
        await useMemoStore.getState().loadForScope([], 'group:pg-empty')
        expect(api.list).not.toHaveBeenCalled()
        expect(useMemoStore.getState().memos).toEqual([])
    })

    it('部分项目失败 → 其余仍合并，error 提示部分失败', async () => {
        api.list.mockImplementation(async (ws: string) =>
            ws === '/ws/b' ? {ok: false, error: '读取失败'} : {ok: true, data: [memo(`m-${ws}`, ws)]})
        await useMemoStore.getState().loadForScope(['/ws/a', '/ws/b'], 'group:pg-a')
        expect(useMemoStore.getState().memos.map((m) => m.id)).toEqual(['m-/ws/a'])
        expect(useMemoStore.getState().error).toBe('部分项目备忘录加载失败')
    })

    it('作用域级竞态：A 请求未返回时发起 B → A 的结果整体丢弃', async () => {
        let resolveA: (v: unknown) => void = () => {}
        api.list.mockImplementationOnce(() => new Promise((r) => { resolveA = r }))
        const pA = useMemoStore.getState().loadForScope(['/ws/a'], 'group:pg-a')
        api.list.mockResolvedValue({ok: true, data: [memo('m-b', '/ws/b')]})
        await useMemoStore.getState().loadForScope(['/ws/b'], 'group:pg-b')
        resolveA({ok: true, data: [memo('m-a', '/ws/a')]})
        await pA
        expect(useMemoStore.getState().memos.map((m) => m.id)).toEqual(['m-b'])
    })

    it('单项目签名 load(workspacePath) 行为不变（回归）', async () => {
        await useMemoStore.getState().load('/ws/a')
        expect(useMemoStore.getState().memos.map((m) => m.id)).toEqual(['m-/ws/a'])
    })
})

describe('作用域内条目变更后的刷新（Task 18 fix：组视图不塌缩）', () => {
    it('组视图内 updateItem 成功后仍按整组重取（打 2 次 list，两侧条目都在）', async () => {
        await useMemoStore.getState().loadForScope(['/ws/a', '/ws/b'], 'group:pg-a')
        expect(api.list).toHaveBeenCalledTimes(2)
        api.list.mockClear()
        api.update.mockResolvedValue({ok: true, data: memo('m-/ws/a', '/ws/a')})

        await useMemoStore.getState().updateItem('m-/ws/a', {pinned: true})

        expect(api.list).toHaveBeenCalledTimes(2)
        expect(api.list.mock.calls.map((c) => c[0]).sort()).toEqual(['/ws/a', '/ws/b'])
        expect(useMemoStore.getState().memos.map((m) => m.workspacePath).sort()).toEqual(['/ws/a', '/ws/b'])
    })

    it('单项目视图内 updateItem 成功后只重取该项目（回归：行为与改造前一致）', async () => {
        await useMemoStore.getState().load('/ws/a')
        api.list.mockClear()
        api.update.mockResolvedValue({ok: true, data: memo('m-/ws/a', '/ws/a')})

        await useMemoStore.getState().updateItem('m-/ws/a', {pinned: true})

        expect(api.list).toHaveBeenCalledTimes(1)
        expect(api.list).toHaveBeenCalledWith('/ws/a')
        expect(useMemoStore.getState().memos.map((m) => m.workspacePath)).toEqual(['/ws/a'])
    })
})

describe('subscribeMemoChangedForScope — 按作用域刷新', () => {
    it('推送项目属于当前作用域 → reload；不属于 → 忽略', async () => {
        let handler: ((p: {workspacePath: string}) => void) | null = null
        api.onMemoChanged.mockImplementation((h: (p: {workspacePath: string}) => void) => {
            handler = h
            return () => {}
        })
        const reload = vi.fn()
        const unsubscribe = useMemoStore.getState().subscribeMemoChangedForScope(() => ['/ws/a', '/ws/b'], reload)
        handler!({workspacePath: '/ws/b'})
        expect(reload).toHaveBeenCalled()
        reload.mockClear()
        handler!({workspacePath: '/ws/zzz'})
        expect(reload).not.toHaveBeenCalled()
        unsubscribe()
    })

    it('退订函数来自 preload 的 onMemoChanged 返回值（透传）', () => {
        const off = vi.fn()
        api.onMemoChanged.mockImplementation(() => off)
        const unsubscribe = useMemoStore.getState().subscribeMemoChangedForScope(() => ['/ws/a'], () => {})
        unsubscribe()
        expect(off).toHaveBeenCalled()
    })
})

// ── Task 19 / R-CA：新建窗口默认项目解析（组视图 → 组内最近活跃会话所属项目） ──
describe('openMemoCreateWindow — 默认项目解析', () => {
    const MEMO_EDIT = 'memo-edit'
    const injectedWorkspace = (path: string) => [`--hclaw-memo-workspace=${encodeURIComponent(path)}`]

    it('组视图 + 组内有会话 → 注入「组内最近活跃会话所属项目」（而非回退值）', () => {
        h.convState.viewScope = {type: 'group', groupId: 'pg-a'}
        h.groupState.groups = [{id: 'pg-a', members: [{projectPath: '/ws/a'}, {projectPath: '/ws/b'}]}]
        // /ws/b 的会话 updatedAt 更大 → 最近活跃的是 /ws/b；回退值 /ws/cur 不在组内
        h.convState.workspaces = {
            '/ws/a': {conversations: [{id: 'c1', createdAt: 999, updatedAt: 100}]},
            '/ws/b': {conversations: [{id: 'c2', createdAt: 1, updatedAt: 900}]},
        }

        openMemoCreateWindow('/ws/cur')

        expect(h.openConfigWindow).toHaveBeenCalledWith(MEMO_EDIT, injectedWorkspace('/ws/b'))
        expect(h.openConfigWindow).not.toHaveBeenCalledWith(MEMO_EDIT, injectedWorkspace('/ws/cur'))
    })

    it('非组视图（单项目 / 无作用域）→ 注入传入值', () => {
        h.convState.viewScope = {type: 'project', path: '/ws/cur'}
        h.convState.workspaces = {'/ws/b': {conversations: [{id: 'c2', updatedAt: 900}]}}
        h.groupState.groups = [{id: 'pg-a', members: [{projectPath: '/ws/b'}]}]

        openMemoCreateWindow('/ws/cur')

        expect(h.openConfigWindow).toHaveBeenCalledWith(MEMO_EDIT, injectedWorkspace('/ws/cur'))
    })

    it('组视图但组内无任何会话 → 注入回退值', () => {
        h.convState.viewScope = {type: 'group', groupId: 'pg-a'}
        h.groupState.groups = [{id: 'pg-a', members: [{projectPath: '/ws/a'}, {projectPath: '/ws/b'}]}]
        h.convState.workspaces = {
            '/ws/a': {conversations: []},
            '/ws/b': {conversations: []},
        }

        openMemoCreateWindow('/ws/cur')

        expect(h.openConfigWindow).toHaveBeenCalledWith(MEMO_EDIT, injectedWorkspace('/ws/cur'))
    })
})
