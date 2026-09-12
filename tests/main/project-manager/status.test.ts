// tests/main/project-manager/status.test.ts
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mockGit = vi.fn()
vi.mock('../../../src/main/project-manager/git/gitExec', () => ({
  gitExec: (...args: unknown[]) => mockGit(...args),
}))
import {parsePorcelain, getGitStatusCached, invalidateStatusCache} from '../../../src/main/project-manager/git/status'

describe('parsePorcelain', () => {
  it('解析 M 状态', () => {
    const map = parsePorcelain(' M src/a.ts\n')
    expect(map['src/a.ts']).toMatchObject({status: 'M', indexStatus: ' ', worktreeStatus: 'M'})
  })
  it('解析 staged A', () => {
    const map = parsePorcelain('A  src/new.ts\n')
    expect(map['src/new.ts'].status).toBe('A')
  })
  it('解析 untracked', () => {
    const map = parsePorcelain('?? temp/log.txt\n')
    expect(map['temp/log.txt']).toMatchObject({status: '??', indexStatus: '?', worktreeStatus: '?'})
  })
  it('解析 rename old -> new', () => {
    const map = parsePorcelain('R  old.ts -> new.ts\n')
    expect(map['new.ts']).toMatchObject({status: 'R', oldPath: 'old.ts'})
  })
  it('解析 deleted', () => {
    const map = parsePorcelain('D  src/gone.ts\n')
    expect(map['src/gone.ts'].status).toBe('D')
  })
  it('解析复合状态 (MM 取 M)', () => {
    const map = parsePorcelain('MM src/both.ts\n')
    expect(map['src/both.ts'].status).toBe('M')
  })
})

describe('getGitStatusCached', () => {
  beforeEach(() => {
    mockGit.mockReset()
    invalidateStatusCache('/ws')
  })

  it('5 秒内命中缓存不重复调 git', async () => {
    mockGit.mockResolvedValueOnce(' M a.ts\nM  b.ts\n')   // porcelain
    mockGit.mockResolvedValueOnce('2\t1\ta.ts\n3\t0\tb.ts\n') // numstat
    await getGitStatusCached('/ws')
    await getGitStatusCached('/ws')
    // 首次调用发起 2 次 git（porcelain + numstat），缓存命中 0 次
    expect(mockGit).toHaveBeenCalledTimes(2)
  })

  it('invalidateStatusCache 后重新拉取', async () => {
    mockGit.mockResolvedValue(' M a.ts\n')
    await getGitStatusCached('/ws')
    invalidateStatusCache('/ws')
    await getGitStatusCached('/ws')
    expect(mockGit).toHaveBeenCalledTimes(4)
  })

  it('statusMap 为 plain object 且含统计', async () => {
    mockGit.mockResolvedValue(' M a.ts\n?? b.txt\n')
    const summary = await getGitStatusCached('/ws')
    expect(summary.statusMap['a.ts'].status).toBe('M')
    expect(summary.updatedAt).toBeGreaterThan(0)
  })

  it('非 git 仓库时返回空 statusMap', async () => {
    mockGit.mockRejectedValue(new Error('fatal: not a git repository'))
    const summary = await getGitStatusCached('/ws')
    expect(Object.keys(summary.statusMap)).toHaveLength(0)
  })

  it('失败路径不写缓存（后续调用能立即重试，不被 5s 窗口粘滞）', async () => {
    mockGit.mockRejectedValueOnce(new Error('fatal: boom'))
    const first = await getGitStatusCached('/ws')
    expect(Object.keys(first.statusMap)).toHaveLength(0)
    // 若失败也写缓存，第二次调用会命中缓存且不发起 git 调用；本用例断言 git 被再次调起
    mockGit.mockResolvedValueOnce(' M a.ts\n')
    mockGit.mockResolvedValueOnce('1\t0\ta.ts\n')
    const second = await getGitStatusCached('/ws')
    expect(second.statusMap['a.ts']?.status).toBe('M')
    // 首次失败 2 次（Promise.all 并行 status + numstat）+ 第二次成功 2 次 = 4 次 git 调用
    expect(mockGit).toHaveBeenCalledTimes(4)
  })

  it('numstat 聚合 additions/deletions（二进制 - 跳过）', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'status') return ' M a.ts\nA  b.ts\n'
      if (args[0] === 'diff' && args.includes('--numstat')) return '2\t1\ta.ts\n-\t-\tbin.png\n5\t0\tb.ts\n'
      return ''
    })
    const summary = await getGitStatusCached('/ws')
    expect(summary.additions).toBe(7)   // 2 + 5
    expect(summary.deletions).toBe(1)  // 1 + 0
  })

  it('numstat 返回空时 additions/deletions 为 0', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'status') return ''  // clean
      if (args[0] === 'diff' && args.includes('--numstat')) return ''
      return ''
    })
    const summary = await getGitStatusCached('/ws')
    expect(summary.additions).toBe(0)
    expect(summary.deletions).toBe(0)
  })

  it('过期条目在读路径被回收：TTL 过后重新拉取，而非返回旧值', async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mockGit.mockImplementation(async (_ws, args) => (args[0] === 'status' ? ' M a.ts\n' : ''))
      const first = await getGitStatusCached('/ws')
      expect(first.statusMap['a.ts'].status).toBe('M')
      expect(mockGit).toHaveBeenCalledTimes(2)

      now += 4_999 // TTL 内：命中缓存
      await getGitStatusCached('/ws')
      expect(mockGit).toHaveBeenCalledTimes(2)

      now += 2 // TTL 外：过期条目被 delete，必须重新拉取
      mockGit.mockImplementation(async (_ws, args) => (args[0] === 'status' ? '?? b.txt\n' : ''))
      const third = await getGitStatusCached('/ws')
      expect(mockGit).toHaveBeenCalledTimes(4)
      expect(third.statusMap['b.txt'].status).toBe('??')
      expect(third.statusMap['a.ts']).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('过期后 git 失败：不返回旧缓存，恢复后立即重新拉取（无残留条目粘滞）', async () => {
    let now = 2_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mockGit.mockImplementation(async (_ws, args) => (args[0] === 'status' ? ' M a.ts\n' : ''))
      await getGitStatusCached('/ws')
      expect(mockGit).toHaveBeenCalledTimes(2)

      now += 6_000 // 过期
      mockGit.mockRejectedValue(new Error('fatal: not a git repository'))
      const failed = await getGitStatusCached('/ws')
      expect(Object.keys(failed.statusMap)).toHaveLength(0)
      expect(mockGit).toHaveBeenCalledTimes(4)

      // 失败分支已清掉该 key：即便仍在 5s 窗口内，下一次也必须重新拉取
      mockGit.mockReset()
      mockGit.mockImplementation(async (_ws, args) => (args[0] === 'status' ? ' M c.ts\n' : ''))
      const recovered = await getGitStatusCached('/ws')
      expect(mockGit).toHaveBeenCalledTimes(2) // 重新拉取（status + numstat），而非命中旧缓存
      expect(recovered.statusMap['c.ts'].status).toBe('M')
    } finally {
      nowSpy.mockRestore()
    }
  })

  // --- numstat 聚合边界：锁定改造前既有行为（此块在重构前也须全绿） ---
  function withNumstat(numstat: string) {
    mockGit.mockImplementation(async (_ws, args) => {
      if ((args as string[])[0] === 'status') return ' M a.ts\n'
      if ((args as string[])[0] === 'diff' && (args as string[]).includes('--numstat')) return numstat
      return ''
    })
  }

  it('numstat 行尾无换行与有换行结果一致', async () => {
    withNumstat('5\t2\ta.ts')
    const noNl = await getGitStatusCached('/ws')
    invalidateStatusCache('/ws')
    withNumstat('5\t2\ta.ts\n')
    const withNl = await getGitStatusCached('/ws')
    expect(noNl.additions).toBe(5)
    expect(noNl.deletions).toBe(2)
    expect({a: withNl.additions, d: withNl.deletions}).toEqual({a: noNl.additions, d: noNl.deletions})
  })

  it('numstat 中间混入空行不影响累加', async () => {
    withNumstat('2\t1\ta.ts\n\n3\t0\tb.ts\n')
    const summary = await getGitStatusCached('/ws')
    expect(summary.additions).toBe(5)
    expect(summary.deletions).toBe(1)
  })

  it('numstat 缺列/多列以前两列为准', async () => {
    withNumstat('5\n')
    const missing = await getGitStatusCached('/ws')
    expect({a: missing.additions, d: missing.deletions}).toEqual({a: 5, d: 0})
    invalidateStatusCache('/ws')
    withNumstat('5\t0\textra\tmore\n')
    const extra = await getGitStatusCached('/ws')
    expect({a: extra.additions, d: extra.deletions}).toEqual({a: 5, d: 0})
  })

  it('numstat 二进制行与正常行混合：只累加正常行', async () => {
    withNumstat('1\t2\tx.ts\n-\t-\tbin.png\n4\t0\ty.ts\n')
    const summary = await getGitStatusCached('/ws')
    expect(summary.additions).toBe(5)
    expect(summary.deletions).toBe(2)
  })

  it('numstat 非数字列保持 parseInt 的 NaN 语义', async () => {
    withNumstat('foo\tbar\tx.ts\n')
    const summary = await getGitStatusCached('/ws')
    expect(Number.isNaN(summary.additions)).toBe(true)
    expect(Number.isNaN(summary.deletions)).toBe(true)
  })

  it('无 HEAD 仓库（numstat 失败）时 statusMap 仍完整，仅统计归零 [A19]', async () => {
    mockGit.mockImplementation(async (_ws: string, args: string[]) => {
      if (args[0] === 'status') return '?? a.txt\n'
      if (args[0] === 'diff') throw new Error("fatal: ambiguous argument 'HEAD': unknown revision")
      return ''
    })
    const s = await getGitStatusCached('/ws-nohead')
    expect(s.statusMap['a.txt']?.status).toBe('??')
    expect(s.additions).toBe(0)
    expect(s.deletions).toBe(0)
  })

  it('非 git 仓库（两侧都失败）仍返回空状态且不写缓存 [A20]', async () => {
    mockGit.mockRejectedValue(new Error('fatal: not a git repository'))
    const first = await getGitStatusCached('/ws-nogit')
    expect(Object.keys(first.statusMap)).toHaveLength(0)
    // 失败不写缓存：下一次调用必须重新拉取，而不是命中陈旧空态
    mockGit.mockReset()
    mockGit.mockImplementation(async (_ws: string, args: string[]) => (args[0] === 'status' ? ' M a.ts\n' : ''))
    const second = await getGitStatusCached('/ws-nogit')
    expect(second.statusMap['a.ts']?.status).toBe('M')
  })
})
