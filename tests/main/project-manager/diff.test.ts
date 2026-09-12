import {describe, it, expect, vi, beforeEach} from 'vitest'
import {resolve} from 'path'
const mockGit = vi.fn()
vi.mock('../../../src/main/project-manager/git/gitExec', () => ({
  gitExec: (...args: unknown[]) => mockGit(...args),
}))
import {buildDiffArgs, getDiff, resolveRefs} from '../../../src/main/project-manager/git/diff'

const mockReadFile = vi.fn()
const mockRealpath = vi.fn(async (p: unknown) => resolve(String(p)))
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  realpath: (p: unknown) => mockRealpath(p),
}))

describe('buildDiffArgs', () => {
  it('缺省 = working-tree（HEAD 对比）', () => {
    expect(buildDiffArgs({}, 'a.ts')).toEqual(['diff', '--no-color', 'HEAD', '--', 'a.ts'])
  })
  it('ref = parent -> commit', () => {
    expect(buildDiffArgs({ref: 'abc123'}, 'a.ts')).toEqual(['diff', '--no-color', 'abc123^', 'abc123', '--', 'a.ts'])
  })
  it('from/to = 区间', () => {
    expect(buildDiffArgs({from: 'abc', to: 'HEAD'}, 'a.ts')).toEqual(['diff', '--no-color', 'abc', 'HEAD', '--', 'a.ts'])
  })

  // --- 三模式 argv 逐元素等价性：锁定改造前既有行为（重构后必须逐元素不变） ---
  it('默认模式 argv 不含空串元素（targetRef 为空）', () => {
    const argv = buildDiffArgs({}, 'a.ts')
    expect(argv).toEqual(['diff', '--no-color', 'HEAD', '--', 'a.ts'])
    expect(argv).toHaveLength(5)
    expect(argv).not.toContain('')
  })

  it('ref 模式 argv 逐元素（parent -> commit），不含空串', () => {
    const argv = buildDiffArgs({ref: 'abc123'}, 'a.ts')
    expect(argv).toEqual(['diff', '--no-color', 'abc123^', 'abc123', '--', 'a.ts'])
    expect(argv).toHaveLength(6)
    expect(argv).not.toContain('')
  })

  it('from/to 模式 argv 逐元素，不含空串', () => {
    const argv = buildDiffArgs({from: 'abc', to: 'HEAD'}, 'a.ts')
    expect(argv).toEqual(['diff', '--no-color', 'abc', 'HEAD', '--', 'a.ts'])
    expect(argv).toHaveLength(6)
    expect(argv).not.toContain('')
  })

  // 保真护栏：只剔除空 targetRef，不得连空 filePath 一起剔除（否则 argv 会退化成「全工作区 diff」）
  it('空 filePath 不得被剔除（仅剔除空 targetRef）', () => {
    expect(buildDiffArgs({}, '')).toEqual(['diff', '--no-color', 'HEAD', '--', ''])
    expect(buildDiffArgs({ref: 'abc123'}, '')).toEqual(['diff', '--no-color', 'abc123^', 'abc123', '--', ''])
    expect(buildDiffArgs({from: 'abc', to: 'HEAD'}, '')).toEqual(['diff', '--no-color', 'abc', 'HEAD', '--', ''])
  })

  it('argv 结构固定：--no-color 在 refs 前、-- 与 filePath 在尾部', () => {
    for (const mode of [{}, {ref: 'x'}, {from: 'a', to: 'b'}]) {
      const argv = buildDiffArgs(mode, 'src/a.ts')
      expect(argv[0]).toBe('diff')
      expect(argv[1]).toBe('--no-color')
      expect(argv[argv.length - 2]).toBe('--')
      expect(argv[argv.length - 1]).toBe('src/a.ts')
    }
  })
})

describe('resolveRefs', () => {
  // 锁定改造前既有行为：三模式 refs/diffType 映射
  it('默认模式：HEAD + 空 targetRef + working-tree', () => {
    expect(resolveRefs({})).toEqual({baseRef: 'HEAD', targetRef: '', diffType: 'working-tree'})
  })
  it('ref 模式：parent -> commit', () => {
    expect(resolveRefs({ref: 'abc123'})).toEqual({baseRef: 'abc123^', targetRef: 'abc123', diffType: 'commit'})
  })
  it('from/to 模式：from -> to', () => {
    expect(resolveRefs({from: 'abc', to: 'HEAD'})).toEqual({baseRef: 'abc', targetRef: 'HEAD', diffType: 'commit'})
  })
  it('from/to 优先于 ref（两者同时存在时取区间）', () => {
    expect(resolveRefs({from: 'abc', to: 'HEAD', ref: 'ignored'})).toEqual({baseRef: 'abc', targetRef: 'HEAD', diffType: 'commit'})
  })
  it('buildDiffArgs 与 resolveRefs 派生一致（三模式）', () => {
    for (const mode of [{}, {ref: 'abc123'}, {from: 'abc', to: 'HEAD'}]) {
      const {baseRef, targetRef} = resolveRefs(mode)
      expect(buildDiffArgs(mode, 'a.ts')).toEqual(['diff', '--no-color', baseRef, targetRef, '--', 'a.ts'].filter(Boolean))
    }
  })
})

// 注：brief 原文 mock 以 args[0]==='numstat' 判断，但实现（git 语义正确）发的是
// 'diff --no-color --numstat ...'，故此处以 args.includes('--numstat') 判定 numstat 调用。
function isNumstat(args: string[]): boolean {
  return args[0] === 'diff' && args.includes('--numstat')
}

describe('getDiff', () => {
  beforeEach(() => {
    // 注意：不能用 `() => mockGit.mockReset()`，mockReset 返回 mock 本身会被 vitest 当作 cleanup 函数以 0 参调用
    mockGit.mockReset()
    mockReadFile.mockReset()
    mockRealpath.mockReset()
    mockRealpath.mockImplementation(async (p: unknown) => resolve(String(p)))
  })

  it('working-tree 模式：old 取 HEAD blob，new 直接读磁盘（不走 git show :file）', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'show') return args[1]!.includes('HEAD:') ? 'old content' : ''
      if (isNumstat(args)) return '2\t1\ta.ts\n'
      if (args[0] === 'diff') return '1 files changed, 2 insertions(+), 1 deletions(-)'
      return ''
    })
    mockReadFile.mockResolvedValue('disk content')
    const r = await getDiff('/ws', 'a.ts', {})
    expect(r.diffType).toBe('working-tree')
    expect(r.oldRef).toBe('HEAD')
    expect(r.newContent).toBe('disk content')
    // 正式实现走 fileSystem.readFileText（含 assertInWorkspace 的 path.resolve），路径为解析后的绝对路径
    expect(mockReadFile).toHaveBeenCalledWith(resolve('/ws', 'a.ts'), 'utf-8')
    // 确保未发起 index 读取（git show :file）
    expect(mockGit.mock.calls.some(([, args]) => (args as string[])[1] === ':a.ts')).toBe(false)
  })

  it('commit 模式：diffType 为 commit，refs 为 hash^ -> hash', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'show') return args[1]!.endsWith('^:a.ts') ? 'old' : 'new'
      if (isNumstat(args)) return '3\t1\ta.ts\n'
      return ''
    })
    const r = await getDiff('/ws', 'a.ts', {ref: 'abc'})
    expect(r.diffType).toBe('commit')
    expect(r.oldRef).toBe('abc^')
    expect(r.newRef).toBe('abc')
    expect(r.additions).toBe(3)
  })

  it('区间模式：from -> to', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'show') return args[1]!.startsWith('abc:') ? 'old' : 'new'
      if (isNumstat(args)) return '1\t0\ta.ts\n'
      return ''
    })
    const r = await getDiff('/ws', 'a.ts', {from: 'abc', to: 'HEAD'})
    expect(r.oldRef).toBe('abc')
    expect(r.newRef).toBe('HEAD')
  })

  it('文件在 base ref 不存在时 oldContent 为空串', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'show' && args[1]!.includes('HEAD:')) throw new Error('does not exist')
      if (isNumstat(args)) return '5\t0\ta.ts\n'
      return 'new'
    })
    const r = await getDiff('/ws', 'a.ts', {})
    expect(r.oldContent).toBe('')
  })

  it('I1: working-tree 模式已删除文件读盘 ENOENT 回退空串', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'show') return 'old content'
      if (isNumstat(args)) return '0\t5\ta.ts\n'
      return ''
    })
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'))
    const r = await getDiff('/ws', 'deleted.ts', {})
    expect(r.newContent).toBe('')  // 不抛异常，回退空串
  })

  // --- getDiff numstat 聚合边界：锁定改造前既有行为 ---
  function withNumstat(raw: string) {
    mockGit.mockImplementation(async (_ws, args) => {
      const a = args as string[]
      if (a[0] === 'show') return ''
      if (isNumstat(a)) return raw
      return ''
    })
  }

  it('numstat 边界：二进制行跳过、正常行累加', async () => {
    withNumstat('1\t2\tx.ts\n-\t-\tbin.png\n4\t0\ty.ts\n')
    const r = await getDiff('/ws', 'x.ts', {})
    expect(r.additions).toBe(5)
    expect(r.deletions).toBe(2)
  })

  it('numstat 行尾无换行与有换行结果一致', async () => {
    withNumstat('5\t2\ta.ts')
    const noNl = await getDiff('/ws', 'a.ts', {})
    withNumstat('5\t2\ta.ts\n')
    const withNl = await getDiff('/ws', 'a.ts', {})
    expect({a: noNl.additions, d: noNl.deletions}).toEqual({a: 5, d: 2})
    expect({a: withNl.additions, d: withNl.deletions}).toEqual({a: noNl.additions, d: noNl.deletions})
  })

  it('numstat 缺列/多列以前两列为准', async () => {
    withNumstat('5\n')
    const missing = await getDiff('/ws', 'a.ts', {})
    expect({a: missing.additions, d: missing.deletions}).toEqual({a: 5, d: 0})
    withNumstat('5\t0\textra\tmore\n')
    const extra = await getDiff('/ws', 'a.ts', {})
    expect({a: extra.additions, d: extra.deletions}).toEqual({a: 5, d: 0})
  })

  it('numstat 空串/仅换行 -> 0/0', async () => {
    withNumstat('')
    const empty = await getDiff('/ws', 'a.ts', {})
    expect({a: empty.additions, d: empty.deletions}).toEqual({a: 0, d: 0})
    withNumstat('\n')
    const nl = await getDiff('/ws', 'a.ts', {})
    expect({a: nl.additions, d: nl.deletions}).toEqual({a: 0, d: 0})
  })

  it('numstat 非数字列保持 parseInt 的 NaN 语义', async () => {
    withNumstat('foo\tbar\tx.ts\n')
    const r = await getDiff('/ws', 'x.ts', {})
    expect(Number.isNaN(r.additions)).toBe(true)
    expect(Number.isNaN(r.deletions)).toBe(true)
  })
})
