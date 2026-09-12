// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'

const PAGE_SIZE = 100

function makeEntry(i: number) {
  return {
    hash: `hash${i}`,
    abbreviatedHash: `hash${i}`.slice(0, 9),
    parents: [],
    message: `commit ${i}`,
    body: '',
    author: 'test',
    authorEmail: 'test@test.com',
    authorDate: i * 1000,
    date: i * 1000,
    branches: [],
    tags: [],
    isHead: i === 0,
  }
}

beforeEach(() => {
  useGitLogStore.setState({entries: [], selectedHash: null, selectedHashes: new Set(), anchorHash: null, selectedBranch: null, loading: false, hasMore: true, lastOptions: null})
  vi.restoreAllMocks()
})

describe('gitLogStore applyFilters 联动断链修复', () => {
  it('applyFilters 后 selectedHash 被清空（换过滤 = 重新开始浏览）', async () => {
    // 先有一个选中的 hash
    useGitLogStore.setState({
      entries: [makeEntry(0)],
      selectedHash: 'hash0',
      selectedBranch: null,
      lastOptions: {limit: PAGE_SIZE},
    })
    ;(window as any).electronAPI = {
      projectManager: {gitLog: vi.fn(async () => [makeEntry(0)])},
    }
    await useGitLogStore.getState().applyFilters('/ws', {limit: PAGE_SIZE, filterBranch: ['main']})
    const state = useGitLogStore.getState()
    expect(state.selectedHash).toBeNull()
    expect(state.entries).toHaveLength(1)
  })

  it('applyFilters 写入 selectedBranch = filterBranch[0]（分支行选中态用）', async () => {
    useGitLogStore.setState({selectedBranch: 'old-branch', selectedHash: 'hash0'})
    ;(window as any).electronAPI = {
      projectManager: {gitLog: vi.fn(async () => [makeEntry(0)])},
    }
    await useGitLogStore.getState().applyFilters('/ws', {limit: PAGE_SIZE, filterBranch: ['develop']})
    expect(useGitLogStore.getState().selectedBranch).toBe('develop')
  })

  it('applyFilters 不带 filterBranch 时 selectedBranch 归空', async () => {
    useGitLogStore.setState({selectedBranch: 'old-branch'})
    ;(window as any).electronAPI = {
      projectManager: {gitLog: vi.fn(async () => [makeEntry(0)])},
    }
    await useGitLogStore.getState().applyFilters('/ws', {limit: PAGE_SIZE})
    expect(useGitLogStore.getState().selectedBranch).toBeNull()
  })
})

describe('gitLogStore loadMore 触顶死循环修复', () => {
  it('达 MAX_LOG_ENTRIES 时 hasMore 置 false（不再请求更多）', async () => {
    // 初始已有 1900 条 + 更多 200 条 = 2100 → 裁剪至 2000 → atCap → hasMore=false
    const initial = Array.from({length: 1900}, (_, i) => makeEntry(i))
    useGitLogStore.setState({
      entries: initial,
      hasMore: true,
      lastOptions: {limit: PAGE_SIZE},
    })
    const more = Array.from({length: PAGE_SIZE}, (_, i) => makeEntry(1900 + i))
    ;(window as any).electronAPI = {
      projectManager: {
        gitLog: vi.fn(async () => more),
      },
    }
    await useGitLogStore.getState().loadMore('/ws')
    const state = useGitLogStore.getState()
    expect(state.entries).toHaveLength(2000)
    expect(state.hasMore).toBe(false)  // 触顶 → false
  })

  it('未达 MAX_LOG_ENTRIES 时 hasMore 按返回量裁定', async () => {
    const initial = Array.from({length: 100}, (_, i) => makeEntry(i))
    useGitLogStore.setState({
      entries: initial,
      hasMore: true,
      lastOptions: {limit: PAGE_SIZE},
    })
    // 返回 100 条（未触顶），hasMore 保持 true
    const more = Array.from({length: PAGE_SIZE}, (_, i) => makeEntry(100 + i))
    ;(window as any).electronAPI = {
      projectManager: {
        gitLog: vi.fn(async () => more),
      },
    }
    await useGitLogStore.getState().loadMore('/ws')
    expect(useGitLogStore.getState().hasMore).toBe(true)
    expect(useGitLogStore.getState().entries).toHaveLength(200)
  })

  it('返回不足 PAGE_SIZE 时 hasMore 置 false（到达历史尽头）', async () => {
    const initial = Array.from({length: 200}, (_, i) => makeEntry(i))
    useGitLogStore.setState({
      entries: initial,
      hasMore: true,
      lastOptions: {limit: PAGE_SIZE},
    })
    // 返回 50 条（< PAGE_SIZE → 历史尽头）
    const more = Array.from({length: 50}, (_, i) => makeEntry(200 + i))
    ;(window as any).electronAPI = {
      projectManager: {
        gitLog: vi.fn(async () => more),
      },
    }
    await useGitLogStore.getState().loadMore('/ws')
    expect(useGitLogStore.getState().hasMore).toBe(false)
    expect(useGitLogStore.getState().entries).toHaveLength(250)
  })
})

describe('gitLogStore 多选（commit 列表）', () => {
  it('普通点击替换为单项，主选 = 该项', () => {
    useGitLogStore.getState().selectWithMods('h1', ['h1', 'h2', 'h3'], {})
    expect([...useGitLogStore.getState().selectedHashes]).toEqual(['h1'])
    expect(useGitLogStore.getState().selectedHash).toBe('h1')
    expect(useGitLogStore.getState().anchorHash).toBe('h1')
  })

  it('Ctrl 加选并成为主选', () => {
    useGitLogStore.getState().selectWithMods('h1', ['h1', 'h2', 'h3'], {})
    useGitLogStore.getState().selectWithMods('h3', ['h1', 'h2', 'h3'], {ctrl: true})
    expect([...useGitLogStore.getState().selectedHashes].sort()).toEqual(['h1', 'h3'])
    expect(useGitLogStore.getState().selectedHash).toBe('h3')
  })

  it('Shift 区间选，anchor 保持为起点', () => {
    useGitLogStore.getState().selectWithMods('h1', ['h1', 'h2', 'h3'], {})
    useGitLogStore.getState().selectWithMods('h3', ['h1', 'h2', 'h3'], {shift: true})
    expect([...useGitLogStore.getState().selectedHashes].sort()).toEqual(['h1', 'h2', 'h3'])
    expect(useGitLogStore.getState().anchorHash).toBe('h1')
  })

  it('applyFilters 同时清空多选（换过滤 = 重新开始浏览）', async () => {
    useGitLogStore.getState().selectWithMods('h1', ['h1', 'h2'], {})
    ;(window as any).electronAPI = {projectManager: {gitLog: vi.fn(async () => [makeEntry(0)])}}
    await useGitLogStore.getState().applyFilters('/ws', {limit: PAGE_SIZE})
    expect(useGitLogStore.getState().selectedHashes.size).toBe(0)
    expect(useGitLogStore.getState().selectedHash).toBeNull()
    expect(useGitLogStore.getState().anchorHash).toBeNull()
  })

  it('select(hash) 收敛为单项多选；select(null) 清空', () => {
    useGitLogStore.getState().selectWithMods('h2', ['h1', 'h2'], {})
    useGitLogStore.getState().select('h1')
    expect([...useGitLogStore.getState().selectedHashes]).toEqual(['h1'])
    useGitLogStore.getState().select(null)
    expect(useGitLogStore.getState().selectedHashes.size).toBe(0)
    expect(useGitLogStore.getState().selectedHash).toBeNull()
  })
})
