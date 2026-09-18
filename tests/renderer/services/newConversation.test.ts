import {describe, expect, it, beforeEach, vi} from 'vitest'

const store = vi.hoisted(() => ({
    currentWorkspacePath: '/ws/a' as string | null,
    activeConversationId: 'c-1' as string | null,
    viewScope: null as any,
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: [{id: 'c-1', workspacePath: '/ws/a'}]}} as any,
    createConversation: vi.fn(async () => 'conv-new'),
    setWorkspace: vi.fn(async () => {}),
    focusProjectSegment: vi.fn(),
    followScopeToProject: vi.fn(),
}))
const groupStore = vi.hoisted(() => ({
    groups: [] as any[],
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {getState: () => store},
}))
vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: {getState: () => groupStore},
}))

import {newConversation} from '../../../src/renderer/services/newConversation'

beforeEach(() => {
    vi.clearAllMocks()
    store.currentWorkspacePath = '/ws/a'
    store.activeConversationId = 'c-1'
    store.viewScope = null
    groupStore.groups = []
    ;(globalThis as any).window = {electronAPI: {openFolderDialog: vi.fn(async () => null)}}
})

describe('newConversation — 目标项目解析', () => {
    it('无参：落到激活会话所属项目 + 跟随视图', async () => {
        await newConversation()
        expect(store.createConversation).toHaveBeenCalledWith(undefined, {workspacePath: '/ws/a', follow: true})
        expect(store.followScopeToProject).toHaveBeenCalledWith('/ws/a')
    })

    it('无激活会话：落到 currentWorkspacePath + 跟随视图', async () => {
        store.activeConversationId = null
        await newConversation()
        expect(store.createConversation).toHaveBeenCalledWith(undefined, {workspacePath: '/ws/a', follow: true})
    })

    it('指定项目 + stayInScope：不跟随视图，改为定位该项目段', async () => {
        await newConversation({workspacePath: '/ws/b', stayInScope: true})
        expect(store.createConversation).toHaveBeenCalledWith(undefined, {workspacePath: '/ws/b', follow: false})
        expect(store.focusProjectSegment).toHaveBeenCalledWith('/ws/b')
        expect(store.followScopeToProject).not.toHaveBeenCalled()
    })

    it('组视图内 Ctrl+N：目标属于当前组 → 停留组视图 + 定位段，不跟随', async () => {
        store.viewScope = {type: 'group', groupId: 'g-1'}
        groupStore.groups = [{id: 'g-1', members: [{projectPath: '/ws/a'}, {projectPath: '/ws/b'}]}]
        await newConversation()
        expect(store.createConversation).toHaveBeenCalledWith(undefined, {workspacePath: '/ws/a', follow: false})
        expect(store.focusProjectSegment).toHaveBeenCalledWith('/ws/a')
        expect(store.followScopeToProject).not.toHaveBeenCalled()
    })

    it('组视图内 Ctrl+N：目标不属于当前组 → 维持跟随（保证新会话可见）', async () => {
        store.viewScope = {type: 'group', groupId: 'g-1'}
        groupStore.groups = [{id: 'g-1', members: [{projectPath: '/ws/x'}]}]
        await newConversation()
        expect(store.createConversation).toHaveBeenCalledWith(undefined, {workspacePath: '/ws/a', follow: true})
        expect(store.followScopeToProject).toHaveBeenCalledWith('/ws/a')
    })

    it('无项目可落：问用户（openFolderDialog 返回 null → 不创建）', async () => {
        store.currentWorkspacePath = null
        store.activeConversationId = null
        await expect(newConversation()).resolves.toBeNull()
        expect(store.createConversation).not.toHaveBeenCalled()
    })

    it('无项目但用户选了目录 → 创建', async () => {
        store.currentWorkspacePath = null
        store.activeConversationId = null
        ;(globalThis as any).window = {electronAPI: {openFolderDialog: vi.fn(async () => '/ws/picked')}}
        await newConversation()
        expect(store.createConversation).toHaveBeenCalledWith(undefined, {workspacePath: '/ws/picked', follow: true})
        // 对话框分支必须**先登记工作区**再创建（createConversation 不登记：
        // 不建 DB 记录 / 不同步主进程 setCurrent），否则会话会落到未登记路径上
        expect(store.setWorkspace).toHaveBeenCalledWith('/ws/picked')
        expect(store.setWorkspace.mock.invocationCallOrder[0])
            .toBeLessThan(store.createConversation.mock.invocationCallOrder[0])
    })
})
