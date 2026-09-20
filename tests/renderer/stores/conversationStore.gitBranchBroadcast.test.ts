import {describe, expect, it, beforeEach, vi} from 'vitest'

vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: {getState: () => ({groups: []})},
    projectGroupOf: () => null,
}))
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: any[]) => items,
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({convAgentStates: {}, updateConvData: () => {}, removeConvData: () => {}}),
        setState: () => {},
    },
}))

import {useConversationStore, subscribeGitBranchChanges} from '../../../src/renderer/stores/conversationStore'

/** 捕获 preload 注册的广播回调，模拟主进程 workspace:git-branch-changed */
function captureBroadcast(): (branch: string | null) => void {
    let handler: ((branch: string | null) => void) | undefined
    ;(globalThis as any).window = {
        electronAPI: {
            workspace: {
                onGitBranchChanged: (fn: (branch: string | null) => void) => {
                    handler = fn
                    return () => {}
                },
                // 缺 getGitBranches：验证显式覆盖当前键的兜底路径
            },
        },
    }
    return (branch) => handler?.(branch)
}

beforeEach(() => {
    useConversationStore.setState({
        workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: []}},
        gitBranches: {'/ws/a': 'main'},
        currentWorkspacePath: '/ws/a',
        gitBranch: 'main',
    })
})

// 根因：广播只写 gitBranch，gitBranches[path] 旧缓存挡住 ?? 回退 → 段头徽章停留旧值。
// 修复契约：广播到达时同步覆盖 gitBranches 中当前工作区的缓存值。
describe('subscribeGitBranchChanges — 段头徽章同步', () => {
    it('广播到达 → gitBranches[currentWorkspacePath] 同步为新分支（无 getGitBranches IPC 也生效）', () => {
        const broadcast = captureBroadcast()
        const unsub = subscribeGitBranchChanges()
        broadcast('feat-x')
        unsub()
        expect(useConversationStore.getState().gitBranch).toBe('feat-x')
        expect(useConversationStore.getState().gitBranches['/ws/a']).toBe('feat-x')
    })

    it('currentWorkspacePath 为 null（无工作区）→ 不写 gitBranches，只更新 gitBranch', () => {
        useConversationStore.setState({currentWorkspacePath: null, gitBranches: {'/ws/a': 'main'}})
        const broadcast = captureBroadcast()
        const unsub = subscribeGitBranchChanges()
        broadcast('feat-x')
        unsub()
        expect(useConversationStore.getState().gitBranch).toBe('feat-x')
        expect(useConversationStore.getState().gitBranches).toEqual({'/ws/a': 'main'})
    })

    it('getGitBranches IPC 可用 → refreshVisibleBranches 被触发兜底批量刷新', async () => {
        const getGitBranches = vi.fn(async (_paths: string[]) => ({'/ws/a': 'feat-y'}))
        ;(globalThis as any).window = {
            electronAPI: {
                workspace: {
                    onGitBranchChanged: (fn: (b: string | null) => void) => {
                        ;(globalThis as any).__branchHandler = fn
                        return () => {}
                    },
                    getGitBranches,
                },
            },
        }
        const unsub = subscribeGitBranchChanges()
        ;(globalThis as any).__branchHandler('feat-y')
        await vi.waitFor(() => expect(getGitBranches).toHaveBeenCalledTimes(1))
        unsub()
        expect(useConversationStore.getState().gitBranches['/ws/a']).toBe('feat-y')
    })
})
