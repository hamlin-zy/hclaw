/**
 * setWorkspace / removeWorkspace（工作区路径归一化等价）测试
 *
 * 缺陷背景：同一工作目录因路径书写形式不同（尾分隔符、分隔符方向、Windows 大小写）
 * 被当成两个工作区。主进程 getByPath 是 `WHERE path = ?` 精确匹配、本轮不改，
 * 且 DB 里已存在 `E:\workspace\` 这类带尾分隔符的历史记录；
 * 渲染层若用原始串写键、用未命中就 create，就会建出第二条记录 + 侧栏重复项。
 *
 * 修复约定（解析顺序固定，三处调用点共用）：
 *  ① workspaces 里已有等价键 → 复用（优先取 conversations 非空的）；
 *  ② 注册表返回 / 扫描到的规范路径（DB 原串）；
 *  ③ 兜底原始 path。
 * 未命中 getByPath 时回退 workspace.list() 做等价扫描（不 create），
 * 比较一律走 workspacePathKey（仅比较，绝不回传主进程）。
 *
 * 隔离：mock agentStore / electronAPI，不触碰真实 IPC / SQLite。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const reconcileSpy = vi.hoisted(() => vi.fn())
const refreshBatchSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            reconcileStreamingContent: reconcileSpy,
            refreshActiveBatch: refreshBatchSpy,
        }),
        setState: () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const getByPath = vi.fn()
const setCurrent = vi.fn()
const getGitBranch = vi.fn()
const list = vi.fn()
const create = vi.fn()
const del = vi.fn()
const listByWorkspace = vi.fn()
const deleteBatch = vi.fn()

function conv(id: string) {
    return {id, title: id, preview: '', createdAt: 0, updatedAt: 0}
}

function ws(id: string, path: string, updatedAt = 0) {
    return {id, path, name: 'ws', createdAt: 0, updatedAt}
}

beforeEach(() => {
    getByPath.mockReset()
    setCurrent.mockReset()
    getGitBranch.mockReset()
    list.mockReset()
    create.mockReset()
    del.mockReset()
    listByWorkspace.mockReset()
    deleteBatch.mockReset()
    getGitBranch.mockResolvedValue('main')
    list.mockResolvedValue([])
    create.mockResolvedValue(true)
    del.mockResolvedValue(true)
    listByWorkspace.mockResolvedValue([])
    deleteBatch.mockResolvedValue(true)
    reconcileSpy.mockClear()
    refreshBatchSpy.mockClear()
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            platform: 'win32',
            workspace: {getByPath, setCurrent, getGitBranch, list, create, delete: del},
            conversationListByWorkspace: listByWorkspace,
            conversationDeleteBatch: deleteBatch,
            conversationReadMessages: vi.fn(async (): Promise<Message[]> => []),
            conversationReadTail: vi.fn(async (): Promise<{messages: Message[]; totalCount: number}> => ({
                messages: [],
                totalCount: 0,
            })),
        },
    }
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('setWorkspace — 归一化等价的既有工作区', () => {
    it('getByPath 未命中 + list() 有等价项：不 create、setCurrent 用等价项 id、键用等价项 DB 串、已有会话未丢', async () => {
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            gitBranch: null,
            workspaces: {
                'E:\\workspace\\': {lastOpenedAt: 0, conversations: [conv('conv-a')]},
            },
            messagesMap: {},
        })
        getByPath.mockResolvedValue(null)
        // DB（workspaces 表）里存的是带尾分隔符的历史串
        list.mockResolvedValue([ws('ws-legacy', 'E:\\workspace\\', 100)])

        await useConversationStore.getState().setWorkspace('E:\\workspace')

        expect(create).not.toHaveBeenCalled()
        // getByPath 必须是精确匹配 → 传原始串
        expect(getByPath).toHaveBeenCalledWith('E:\\workspace')
        expect(setCurrent).toHaveBeenCalledTimes(1)
        expect(setCurrent).toHaveBeenCalledWith('ws-legacy')

        const state = useConversationStore.getState()
        expect(state.currentWorkspacePath).toBe('E:\\workspace\\')
        expect(Object.keys(state.workspaces)).toEqual(['E:\\workspace\\'])
        expect(state.workspaces['E:\\workspace\\'].conversations.map(c => c.id)).toEqual(['conv-a'])
        // git 分支查询与生效键同源
        await vi.waitFor(() => expect(getGitBranch).toHaveBeenCalledWith('E:\\workspace\\'))
    })

    it('getByPath 未命中 + list() 无等价项：仍 create，且 create 收到原始串', async () => {
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {},
            messagesMap: {},
        })
        getByPath
            .mockResolvedValueOnce(null) // 首查未命中
            .mockResolvedValueOnce(ws('ws-new', 'E:\\brand-new')) // create 后回读
        list.mockResolvedValue([ws('ws-other', 'E:\\elsewhere', 1)])

        await useConversationStore.getState().setWorkspace('E:\\brand-new')

        expect(create).toHaveBeenCalledTimes(1)
        expect(create).toHaveBeenCalledWith(expect.any(String), 'E:\\brand-new', 'brand-new')
        expect(setCurrent).toHaveBeenCalledWith('ws-new')
        expect(useConversationStore.getState().currentWorkspacePath).toBe('E:\\brand-new')
    })

    it('getByPath 精确命中：行为不变，且不额外调 list()', async () => {
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {'E:\\Foo': {lastOpenedAt: 0, conversations: [conv('c1')]}},
            messagesMap: {},
        })
        getByPath.mockResolvedValue(ws('ws-foo', 'E:\\Foo', 5))

        await useConversationStore.getState().setWorkspace('E:\\Foo')

        expect(list).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        expect(setCurrent).toHaveBeenCalledWith('ws-foo')
        expect(useConversationStore.getState().currentWorkspacePath).toBe('E:\\Foo')
    })

    it('getByPath 未命中 + list() 多条等价项：取 updatedAt 最新 + console.warn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {},
            messagesMap: {},
        })
        getByPath.mockResolvedValue(null)
        list.mockResolvedValue([
            ws('ws-old', 'E:\\workspace\\', 100),
            ws('ws-new', 'E:\\workspace', 200),
        ])

        await useConversationStore.getState().setWorkspace('E:\\workspace')

        expect(setCurrent).toHaveBeenCalledWith('ws-new')
        expect(useConversationStore.getState().currentWorkspacePath).toBe('E:\\workspace')
        expect(warn).toHaveBeenCalled()
    })
})

describe('removeWorkspace — 归一化等价的既有工作区', () => {
    it('getByPath 精确未命中但有等价项：DB 记录被删、所有等价键清掉、currentWorkspacePath 置 null', async () => {
        useConversationStore.setState({
            currentWorkspacePath: 'E:\\workspace\\',
            activeConversationId: 'conv-a',
            gitBranch: 'main',
            workspaces: {
                'E:\\workspace\\': {lastOpenedAt: 0, conversations: [conv('conv-a')]},
                'E:\\workspace': {lastOpenedAt: 0, conversations: []},
            },
            messagesMap: {},
        })
        getByPath.mockResolvedValue(null)
        list.mockResolvedValue([ws('ws-legacy', 'E:\\workspace\\', 100)])

        await useConversationStore.getState().removeWorkspace('E:\\workspace')

        expect(create).not.toHaveBeenCalled()
        expect(del).toHaveBeenCalledTimes(1)
        expect(del).toHaveBeenCalledWith('ws-legacy')

        const state = useConversationStore.getState()
        expect(Object.keys(state.workspaces)).toEqual([])
        expect(state.currentWorkspacePath).toBeNull()
    })

    it('完全找不到：不抛错、不 create，会话删除仍按原串进行', async () => {
        useConversationStore.setState({
            currentWorkspacePath: 'E:\\other',
            activeConversationId: 'conv-a',
            workspaces: {'E:\\other': {lastOpenedAt: 0, conversations: [conv('conv-a')]}},
            messagesMap: {},
        })
        getByPath.mockResolvedValue(null)
        list.mockResolvedValue([ws('ws-x', 'E:\\elsewhere', 1)])

        await expect(
            useConversationStore.getState().removeWorkspace('E:\\Ghost')
        ).resolves.toBeUndefined()

        expect(create).not.toHaveBeenCalled()
        expect(listByWorkspace).toHaveBeenCalledWith('E:\\Ghost')
        expect(useConversationStore.getState().currentWorkspacePath).toBe('E:\\other')
    })
})

describe('等价判定口径 — 平台相关（走 workspacePathKey）', () => {
    it('win32：E:\\Foo\\ 与用户选的 E:\\Foo 等价（尾分隔符归一）', async () => {
        ;(globalThis as any).window.electronAPI.platform = 'win32'
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {'E:\\Foo\\': {lastOpenedAt: 0, conversations: [conv('c1')]}},
            messagesMap: {},
        })
        getByPath.mockResolvedValue(null)
        list.mockResolvedValue([ws('ws-1', 'E:\\Foo\\', 1)])

        await useConversationStore.getState().setWorkspace('E:\\Foo')

        expect(create).not.toHaveBeenCalled()
        expect(setCurrent).toHaveBeenCalledWith('ws-1')
    })

    it('POSIX：E:\\Foo 与 e:/foo 不等价（大小写不折叠 → 走 create，不误合并）', async () => {
        ;(globalThis as any).window.electronAPI.platform = 'linux'
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {'e:/foo': {lastOpenedAt: 0, conversations: [conv('c1')]}},
            messagesMap: {},
        })
        getByPath.mockResolvedValueOnce(null).mockResolvedValueOnce(ws('ws-new', 'E:\\Foo', 1))
        list.mockResolvedValue([ws('ws-lower', 'e:/foo', 1)])

        await useConversationStore.getState().setWorkspace('E:\\Foo')

        expect(create).toHaveBeenCalledTimes(1)
        expect(create).toHaveBeenCalledWith(expect.any(String), 'E:\\Foo', 'Foo')
        expect(setCurrent).toHaveBeenCalledWith('ws-new')
    })
})
