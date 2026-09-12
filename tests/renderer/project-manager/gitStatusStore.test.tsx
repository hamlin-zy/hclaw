// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'

beforeEach(() => useGitStatusStore.setState({summary: null, loading: false}))

describe('gitStatusStore', () => {
  it('grouped 按状态分组且 untracked 独立', async () => {
    ;(window as any).electronAPI = {
      projectManager: {gitStatus: vi.fn(async () => ({
        statusMap: {
          'm.ts': {path: 'm.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
          'a.ts': {path: 'a.ts', status: 'A', indexStatus: 'A', worktreeStatus: ' '},
          'u.txt': {path: 'u.txt', status: '??', indexStatus: '?', worktreeStatus: '?'},
          'r.ts': {path: 'r.ts', status: 'R', oldPath: 'o.ts', indexStatus: 'R', worktreeStatus: ' '},
        },
        additions: 1, deletions: 0, updatedAt: 1,
      }))},
    }
    await useGitStatusStore.getState().refresh('/ws')
    const g = useGitStatusStore.getState().grouped()
    expect(g.modified.map(f => f.path)).toEqual(['m.ts'])
    expect(g.added.map(f => f.path)).toEqual(['a.ts'])
    expect(g.untracked.map(f => f.path)).toEqual(['u.txt'])
    expect(g.renamed[0]!.oldPath).toBe('o.ts')
  })
  it('refresh IPC reject 时 loading 复位且不崩溃', async () => {
    ;(window as any).electronAPI = {
      projectManager: {gitStatus: vi.fn(async () => { throw new Error('ipc failed') })},
    }
    await expect(useGitStatusStore.getState().refresh('/ws')).rejects.toThrow('ipc failed')
    expect(useGitStatusStore.getState().loading).toBe(false)
  })
  it('applyPushed 直接采用推送数据', () => {
    useGitStatusStore.getState().applyPushed('/ws', {statusMap: {}, additions: 2, deletions: 3, updatedAt: 9})
    expect(useGitStatusStore.getState().summary!.additions).toBe(2)
  })
})

describe('refsVersion（spec §4.4 刷新面 5）', () => {
  it('初始 0，bumpRefs 自增', () => {
    useGitStatusStore.setState({refsVersion: 0})
    expect(useGitStatusStore.getState().refsVersion).toBe(0)
    useGitStatusStore.getState().bumpRefs()
    expect(useGitStatusStore.getState().refsVersion).toBe(1)
    useGitStatusStore.getState().bumpRefs()
    expect(useGitStatusStore.getState().refsVersion).toBe(2)
  })
})
