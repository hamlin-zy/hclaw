// @vitest-environment jsdom
// 新增用例：验证三个 store 的 workspace 归属/代际校验 —— 切仓库后旧响应晚到必须被丢弃，
// 修复「store 层跨 workspace 串写」P1。可独立运行：ws 切换 + 迟到响应丢弃。
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'
import type {DirEntry, GitStatusSummary} from '@shared/types/project-manager'

const flush = () => new Promise(r => setTimeout(r, 0))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return {promise, resolve, reject}
}

function logEntry(i: number) {
  return {
    hash: `h${i}`, abbreviatedHash: `h${i}`.slice(0, 9), parents: [], message: `c${i}`, body: '',
    author: 't', authorEmail: 't@t', authorDate: i, date: i, branches: [], tags: [], isHead: i === 0,
  }
}

function statusSummary(additions: number): GitStatusSummary {
  return {statusMap: {}, additions, deletions: 0, updatedAt: additions}
}

const dirEntry = (path: string): DirEntry =>
  ({name: path, path, isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false})

beforeEach(() => {
  useGitLogStore.setState({ws: null, generation: 0, entries: [], selectedHash: null, selectedBranch: null, loading: false, hasMore: true, lastOptions: null})
  useGitStatusStore.setState({ws: null, generation: 0, summary: null, loading: false})
  useFileTreeStore.setState({ws: null, expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null})
  vi.restoreAllMocks()
})

describe('gitLogStore workspace 归属校验', () => {
  it('切到仓库 B 后，A 的迟到 loadMore 响应被丢弃（不覆盖 B 的列表）', async () => {
    const pending: Array<{ws: string, d: ReturnType<typeof deferred<unknown>>}> = []
    ;(window as any).electronAPI = {
      projectManager: {
        gitLog: vi.fn((ws: string) => {
          const d = deferred<unknown>()
          pending.push({ws, d})
          return d.promise
        }),
      },
    }
    // 1) 在 A 初次加载：100 条 → hasMore=true
    const pInitA = useGitLogStore.getState().loadInitial('/A')
    await flush()
    expect(pending[0]!.ws).toBe('/A')
    pending[0]!.d.resolve(Array.from({length: 100}, (_, i) => logEntry(i)))
    await pInitA
    expect(useGitLogStore.getState().entries).toHaveLength(100)

    // 2) 在 A 触底 loadMore（挂起不返回）
    const pMoreA = useGitLogStore.getState().loadMore('/A')
    await flush()
    expect(pending[1]!.ws).toBe('/A')

    // 3) 期间切到 B 并加载 B（先返回）→ 当前列表归属 B
    const pInitB = useGitLogStore.getState().loadInitial('/B')
    await flush()
    expect(pending[2]!.ws).toBe('/B')
    pending[2]!.d.resolve(Array.from({length: 5}, (_, i) => logEntry(1000 + i)))
    await pInitB
    expect(useGitLogStore.getState().entries).toHaveLength(5)
    expect(useGitLogStore.getState().ws).toBe('/B')

    // 4) A 的 loadMore 现在才晚到：必须被丢弃，B 的列表/分页不受污染
    pending[1]!.d.resolve(Array.from({length: 100}, (_, i) => logEntry(100 + i)))
    await pMoreA
    const s = useGitLogStore.getState()
    expect(s.entries).toHaveLength(5)
    expect(s.entries[0]!.hash).toBe('h1000')
    expect(s.ws).toBe('/B')
  })

  it('同仓库内被更新请求覆盖的旧响应也会被丢弃（generation 生效）', async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = []
    ;(window as any).electronAPI = {
      projectManager: {
        gitLog: vi.fn(() => {
          const d = deferred<unknown>()
          pending.push(d)
          return d.promise
        }),
      },
    }
    const p1 = useGitLogStore.getState().applyFilters('/A', {limit: 100})
    const p2 = useGitLogStore.getState().applyFilters('/A', {limit: 100, filterBranch: ['feature']})
    await flush()
    // 后发先至：p2 先落地
    pending[1]!.resolve([logEntry(2)])
    await p2
    expect(useGitLogStore.getState().selectedBranch).toBe('feature')
    // 先发后至：p1 陈旧，丢弃，不覆盖 p2 的结果
    pending[0]!.resolve([logEntry(1)])
    await p1
    expect(useGitLogStore.getState().entries).toHaveLength(1)
    expect(useGitLogStore.getState().selectedBranch).toBe('feature')
  })
})

describe('gitStatusStore workspace 归属校验', () => {
  it('切到 B 后，A 的迟到 refresh 响应被丢弃', async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = []
    ;(window as any).electronAPI = {
      projectManager: {
        gitStatus: vi.fn(() => {
          const d = deferred<unknown>()
          pending.push(d)
          return d.promise
        }),
      },
    }
    const pA = useGitStatusStore.getState().refresh('/A')
    const pB = useGitStatusStore.getState().refresh('/B')
    await flush()
    pending[1]!.resolve(statusSummary(7))   // B 先返回
    await pB
    expect(useGitStatusStore.getState().summary!.additions).toBe(7)
    pending[0]!.resolve(statusSummary(999)) // A 晚到
    await pA
    expect(useGitStatusStore.getState().summary!.additions).toBe(7)
    expect(useGitStatusStore.getState().ws).toBe('/B')
  })

  it('applyPushed 丢弃非当前 workspace 的推送', () => {
    useGitStatusStore.setState({ws: '/A', generation: 1, summary: statusSummary(1)})
    useGitStatusStore.getState().applyPushed('/B', statusSummary(42))
    expect(useGitStatusStore.getState().summary!.additions).toBe(1)
    useGitStatusStore.getState().applyPushed('/A', statusSummary(2))
    expect(useGitStatusStore.getState().summary!.additions).toBe(2)
  })
})

describe('fileTreeStore workspace 归属校验', () => {
  it('切 ws 整体失效缓存；旧 ws 的迟到写入被丢弃', () => {
    useFileTreeStore.getState().setWorkspace('/A')
    useFileTreeStore.getState().setChildren('.', [dirEntry('src')], '/A')
    expect(useFileTreeStore.getState().getChildren('.')).toBeDefined()

    // 切到 B：整体失效
    useFileTreeStore.getState().setWorkspace('/B')
    expect(useFileTreeStore.getState().getChildren('.')).toBeUndefined()
    expect(useFileTreeStore.getState().cacheOrder).toEqual([])

    // A 的迟到响应（ownerWs='/A'）落地：必须被丢弃，不得写进 B 的同名键
    useFileTreeStore.getState().setChildren('.', [dirEntry('oldsrc')], '/A')
    expect(useFileTreeStore.getState().getChildren('.')).toBeUndefined()

    // B 自己的响应正常写入
    useFileTreeStore.getState().setChildren('.', [dirEntry('newsrc')], '/B')
    expect(useFileTreeStore.getState().getChildren('.')![0]!.path).toBe('newsrc')
  })
})
