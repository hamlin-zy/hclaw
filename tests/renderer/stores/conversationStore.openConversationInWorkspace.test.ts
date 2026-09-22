/**
 * openConversationInWorkspace（跨窗口跳转：切工作区 + 激活会话）测试
 *
 * 缺陷背景：投递来的 workspacePath 与本地已有键归一化后相等时，
 * 旧实现写库仍用**原串** → 新建第二个键，侧栏同一项目出现两条记录，
 * currentWorkspacePath 指向空列表的新键，与 setCurrent(ws.id) 指向的工作区不一致。
 *
 * 修复约定：先算「生效键」（优先复用已有等价键 → 其次注册表返回的规范路径 → 最后投递原串），
 * set / refreshGitBranch 统一用该键；比较用同一个 workspacePathKey。
 * 仍：不为未登记路径 create、不抢占根会话、以 setActiveConversation 收尾。
 * 关键约束：传给主进程（getByPath / setCurrent / getGitBranch）的路径不得是归一化串。
 *
 * 隔离：mock agentStore / electronAPI，不触碰真实 IPC / SQLite。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const reconcileSpy = vi.hoisted(() => vi.fn())
const refreshBatchSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            clearConvDoneUnread: () => {},
            flushPendingStreamData: () => {},
            reconcileStreamingContent: reconcileSpy,
            refreshActiveBatch: refreshBatchSpy,
        }),
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

function conv(id: string) {
    return {id, title: id, preview: '', createdAt: 0, updatedAt: 0}
}

beforeEach(() => {
    getByPath.mockReset()
    setCurrent.mockReset()
    getGitBranch.mockReset()
    getGitBranch.mockResolvedValue('main')
    reconcileSpy.mockClear()
    refreshBatchSpy.mockClear()
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            platform: 'win32',
            workspace: {getByPath, setCurrent, getGitBranch},
            conversationReadTail: vi.fn(async (): Promise<{messages: Message[]; totalCount: number}> => ({
                messages: [],
                totalCount: 0,
            })),
        },
    }
})

describe('openConversationInWorkspace（生效键解析）', () => {
    it('payload `E:\\Foo\\` + 已有键 `e:/foo`：不新增键、currentWorkspacePath 命中已有键、setCurrent 恰好一次、已有会话未丢失', async () => {
        useConversationStore.setState({
            currentWorkspacePath: '/other',
            activeConversationId: null,
            workspaces: {
                'e:/foo': {lastOpenedAt: 0, conversations: [conv('conv-a'), conv('conv-b')]},
                '/other': {lastOpenedAt: 0, conversations: []},
            },
            messagesMap: {},
        })
        getByPath.mockResolvedValue({id: 'ws-foo', path: 'e:/foo'})

        await useConversationStore.getState().openConversationInWorkspace('conv-a', 'E:\\Foo\\')

        const state = useConversationStore.getState()
        expect(Object.keys(state.workspaces).sort()).toEqual(['/other', 'e:/foo'])
        expect(Object.keys(state.workspaces)).not.toContain('E:\\Foo\\')
        expect(state.currentWorkspacePath).toBe('e:/foo')
        expect(setCurrent).toHaveBeenCalledTimes(1)
        expect(setCurrent).toHaveBeenCalledWith('ws-foo')
        expect(state.workspaces['e:/foo'].conversations.map(c => c.id)).toEqual(['conv-a', 'conv-b'])
        // 主进程是精确串匹配：IPC 收到的是投递来的原串，不是归一化串
        expect(getByPath).toHaveBeenCalledWith('E:\\Foo\\')
        // git 分支查询与「当前工作区」同源
        await vi.waitFor(() => expect(getGitBranch).toHaveBeenCalledWith('e:/foo'))
    })

    it('payload 与任何键都不等价、注册表返回 ws：用 ws.path 建键', async () => {
        ;(globalThis as any).window.electronAPI.platform = 'linux'
        useConversationStore.setState({
            currentWorkspacePath: '/other',
            activeConversationId: null,
            workspaces: {'/other': {lastOpenedAt: 0, conversations: []}},
            messagesMap: {},
        })
        getByPath.mockResolvedValue({id: 'ws-canon', path: '/srv/canonical/proj'})

        await useConversationStore
            .getState()
            .openConversationInWorkspace('conv-x', '/tmp/proj/')

        const state = useConversationStore.getState()
        expect(Object.keys(state.workspaces).sort()).toEqual(['/other', '/srv/canonical/proj'])
        expect(state.currentWorkspacePath).toBe('/srv/canonical/proj')
        expect(state.workspaces['/srv/canonical/proj']).toBeTruthy()
        expect(setCurrent).toHaveBeenCalledTimes(1)
        expect(setCurrent).toHaveBeenCalledWith('ws-canon')
        expect(getByPath).toHaveBeenCalledWith('/tmp/proj/')
    })

    it('注册表返回 null：用投递原串建键且不调用 setCurrent（不 create、不登记悬空路径）', async () => {
        useConversationStore.setState({
            currentWorkspacePath: '/other',
            activeConversationId: null,
            workspaces: {'/other': {lastOpenedAt: 0, conversations: []}},
            messagesMap: {},
        })
        getByPath.mockResolvedValue(null)

        await useConversationStore
            .getState()
            .openConversationInWorkspace('conv-ghost', 'E:\\Ghost\\')

        const state = useConversationStore.getState()
        expect(state.currentWorkspacePath).toBe('E:\\Ghost\\')
        expect(Object.keys(state.workspaces)).toContain('E:\\Ghost\\')
        expect(setCurrent).not.toHaveBeenCalled()
    })

    it('目标工作区与当前工作区等价（归一化后相等）：整体跳过切换，不新增键、不调 setCurrent', async () => {
        useConversationStore.setState({
            currentWorkspacePath: 'e:/foo',
            activeConversationId: null,
            workspaces: {
                'e:/foo': {lastOpenedAt: 0, conversations: [conv('conv-a')]},
            },
            messagesMap: {},
        })

        await useConversationStore.getState().openConversationInWorkspace('conv-a', 'E:\\Foo\\')

        const state = useConversationStore.getState()
        expect(Object.keys(state.workspaces)).toEqual(['e:/foo'])
        expect(state.currentWorkspacePath).toBe('e:/foo')
        expect(getByPath).not.toHaveBeenCalled()
        expect(setCurrent).not.toHaveBeenCalled()
    })

    it('始终以 setActiveConversation 收尾（不抢占根会话）', async () => {
        useConversationStore.setState({
            currentWorkspacePath: 'e:/foo',
            activeConversationId: null,
            workspaces: {
                'e:/foo': {lastOpenedAt: 0, conversations: [conv('conv-a'), conv('conv-b')]},
            },
            messagesMap: {'conv-a': [{id: 'm1', role: 'user', content: 'hi', timestamp: 1}]},
        })

        await useConversationStore.getState().openConversationInWorkspace('conv-b', 'E:\\Foo\\')

        expect(useConversationStore.getState().activeConversationId).toBe('conv-b')
    })
})
