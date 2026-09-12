// tests/main/project-manager/watcher.test.ts
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'

// chokidar 内部依赖定时器推进 + 真实 I/O 轮转：advanceTimersByTimeAsync 只泵微任务，
// 需穿插真实 setTimeout 让 libuv 处理 fs 事件，否则 watcher 永远收不到变更。
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const sleep = (ms: number) => new Promise<void>(r => realSetTimeout(r, ms))
const pump = async (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise<void>(r => realSetTimeout(r, 20))
  }
}

vi.mock('../../../src/main/project-manager/git/status', () => ({
  getGitStatusCached: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 1})),
  invalidateStatusCache: vi.fn(),
}))
// gitdir 解析走 git rev-parse：用 mock 固定返回值，测试无需真的 git 仓库；
// 默认（非 git 仓库）抛错，保证不关心 git 的用例完全不受 gitdir 监听影响
const {gitExecMock} = vi.hoisted(() => ({
  gitExecMock: vi.fn<(ws: string, args: string[]) => Promise<string>>(
    async () => { throw new Error('not a git repository') }),
}))
vi.mock('../../../src/main/project-manager/git/gitExec', () => ({gitExec: gitExecMock}))
import chokidar from 'chokidar'
import {startWatcher, stopWatcher, getWatcherCount, getGitWatchPaths, watchRefDirs} from '../../../src/main/project-manager/watcher'
import {getGitStatusCached, invalidateStatusCache} from '../../../src/main/project-manager/git/status'

/**
 * 造一个「真实 worktree 布局」的仓库：
 * - gitDir（--git-dir）    = <main>/.git/worktrees/wt，内含 HEAD / index / logs/HEAD，**refs/ 是空的**；
 * - commonDir（--git-common-dir）= <main>/.git，内含 refs/heads、refs/remotes、packed-refs。
 * 旧实现对 refs 用 --git-dir 定位（落到空 refs/），真实 worktree 里 commit 只写 common dir 的
 * refs/heads/<branch>，于是 pm:refs-changed 永不触发——这个 helper 就是用来钉住这个布局的。
 */
function makeWorktreeLayout() {
  const main = mkdtempSync(join(tmpdir(), 'pm-worktree-'))
  const gitDir = join(main, '.git', 'worktrees', 'wt')
  const commonDir = join(main, '.git')
  mkdirSync(join(gitDir, 'logs'), {recursive: true})
  mkdirSync(join(gitDir, 'refs', 'heads'), {recursive: true})   // 空 refs：真实布局
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/wtbranch\n')
  writeFileSync(join(gitDir, 'index'), 'stub')
  writeFileSync(join(gitDir, 'logs', 'HEAD'), 'first\n')
  mkdirSync(join(commonDir, 'refs', 'heads'), {recursive: true})
  mkdirSync(join(commonDir, 'refs', 'remotes'), {recursive: true})
  writeFileSync(join(commonDir, 'packed-refs'), '')
  gitExecMock.mockImplementation(async (_ws: string, args: string[]) =>
    args[0] === 'rev-parse'
      ? (args[1] === '--git-common-dir' ? `${commonDir}\n` : `${gitDir}\n`)
      : '')
  return {main, gitDir, commonDir}
}

describe('watcher 生命周期', () => {
  let ws: string
  beforeEach(() => {
    vi.useFakeTimers()
    ws = mkdtempSync(join(tmpdir(), 'pm-watch-'))
  })

  it('同 workspace 重复 start 只建一个实例', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    startWatcher(ws, send)
    expect(getWatcherCount(ws)).toBe(1)
    await stopWatcher(ws)
    expect(getWatcherCount(ws)).toBe(1)   // 引用计数 2 -> 1，未关闭
    await stopWatcher(ws)
    expect(getWatcherCount(ws)).toBe(0)
  })

  it('文件变更防抖 500ms 后推送 status', async () => {
    const send = vi.fn()
    vi.mocked(getGitStatusCached).mockClear()
    vi.mocked(invalidateStatusCache).mockClear()
    startWatcher(ws, send)
    await pump(300)   // 等待 watcher ready
    writeFileSync(join(ws, 'x.txt'), 'change')
    await pump(1500)  // awaitWriteFinish 500ms + 防抖 500ms + I/O 轮转
    expect(send).toHaveBeenCalledWith('pm:file-changed', ws, {path: 'x.txt', type: 'add'})
    expect(send).toHaveBeenCalledWith('pm:status-changed', ws, expect.objectContaining({updatedAt: 1}))
    // notify 取 status 前先失效缓存，避免推送 5s TTL 内的陈旧状态
    expect(invalidateStatusCache).toHaveBeenCalledWith(ws)
    expect(getGitStatusCached).toHaveBeenCalledWith(ws)
    const invalidCalls = vi.mocked(invalidateStatusCache).mock.invocationCallOrder
    const fetchCalls = vi.mocked(getGitStatusCached).mock.invocationCallOrder
    expect(invalidCalls.length).toBeGreaterThan(0)
    expect(invalidCalls[invalidCalls.length - 1]).toBeLessThan(fetchCalls[fetchCalls.length - 1])
    await stopWatcher(ws)
  })

  it('子目录变更推送相对正斜杠路径（Windows 反斜杠规范化）', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    await pump(300)
    const fs = await import('fs')
    fs.mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub', 'y.txt'), 'new')
    await pump(1500)
    expect(send).toHaveBeenCalledWith('pm:file-changed', ws, {path: 'sub/y.txt', type: 'add'})
    await stopWatcher(ws)
  })

  it('close 后防抖定时器被清除，不再 notify', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    await pump(300)
    await stopWatcher(ws)   // close：clearTimeout + closed 标记
    vi.mocked(getGitStatusCached).mockClear()
    vi.mocked(invalidateStatusCache).mockClear()
    writeFileSync(join(ws, 'late.txt'), 'change')
    await pump(1500)
    expect(send).not.toHaveBeenCalled()
    expect(getGitStatusCached).not.toHaveBeenCalled()
    expect(invalidateStatusCache).not.toHaveBeenCalled()
  })

  it('清理临时目录', async () => {
    await stopWatcher(ws).catch(() => {})
    vi.useRealTimers()
    rmSync(ws, {recursive: true, force: true})
  })
})

describe('gitdir 内部监听（外部 add / commit / push 只改 .git）', () => {
  let gws: string
  beforeEach(() => {
    vi.useFakeTimers()
    gws = mkdtempSync(join(tmpdir(), 'pm-watch-git-'))
    gitExecMock.mockReset()
    // 普通仓库：rev-parse --git-dir 输出相对 cwd 的 '.git'
    gitExecMock.mockImplementation(async (_ws: string, args: string[]) =>
      args[0] === 'rev-parse' ? '.git\n' : '')
  })
  afterEach(async () => {
    await stopWatcher(gws).catch(() => {})
    vi.useRealTimers()
    rmSync(gws, {recursive: true, force: true})
  })

  it('rev-parse 的相对 gitdir 被绝对化：refs 变化推送 status + refs-changed', async () => {
    const send = vi.fn()
    mkdirSync(join(gws, '.git', 'refs', 'heads'), {recursive: true})
    writeFileSync(join(gws, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    startWatcher(gws, send)
    await pump(500)   // 等 rev-parse 落地 + chokidar ready
    writeFileSync(join(gws, '.git', 'refs', 'heads', 'main'), 'f00d\n')   // 模拟外部 commit
    await pump(1500)
    expect(send).toHaveBeenCalledWith('pm:status-changed', gws, expect.objectContaining({updatedAt: 1}))
    expect(send).toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
    await stopWatcher(gws)
  })

  it('HEAD 变化同样推送 refs-changed', async () => {
    const send = vi.fn()
    mkdirSync(join(gws, '.git', 'refs', 'heads'), {recursive: true})
    writeFileSync(join(gws, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    startWatcher(gws, send)
    await pump(500)
    writeFileSync(join(gws, '.git', 'HEAD'), 'ref: refs/heads/other\n')   // 模拟外部 checkout
    await pump(1500)
    expect(send).toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
    await stopWatcher(gws)
  })

  it('仅 index 变化只推 status-changed（index 不属于 refs）', async () => {
    const send = vi.fn()
    mkdirSync(join(gws, '.git'), {recursive: true})
    writeFileSync(join(gws, '.git', 'index'), 'stub')
    startWatcher(gws, send)
    await pump(500)
    writeFileSync(join(gws, '.git', 'index'), 'stub2')   // 模拟外部 git add / rm --cached
    await pump(1500)
    expect(send).toHaveBeenCalledWith('pm:status-changed', gws, expect.objectContaining({updatedAt: 1}))
    expect(send).not.toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
    await stopWatcher(gws)
  })

  it('objects 目录写入不产生任何推送（没有递归监听整个 .git）', async () => {
    const send = vi.fn()
    mkdirSync(join(gws, '.git', 'objects', 'ab'), {recursive: true})
    startWatcher(gws, send)
    await pump(500)
    writeFileSync(join(gws, '.git', 'objects', 'ab', 'cdef0123'), 'blob')   // 模拟松散对象写入
    await pump(1500)
    expect(send).not.toHaveBeenCalled()
    await stopWatcher(gws)
  })

  it('worktree 场景：worktree gitdir 的 reflog 变化能触发 refs-changed', async () => {
    const {main, gitDir} = makeWorktreeLayout()
    try {
      const send = vi.fn()
      startWatcher(gws, send)
      await pump(500)
      // worktree 里 commit / checkout / reset 等都会追加写 worktree gitdir 的 logs/HEAD
      writeFileSync(join(gitDir, 'logs', 'HEAD'), 'first\nsecond\n')
      await pump(1500)
      expect(send).toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
      await stopWatcher(gws)
    } finally {
      rmSync(main, {recursive: true, force: true})
    }
  })

  it('worktree 场景：common dir 的 refs 变化能触发 refs-changed', async () => {
    const {main, commonDir} = makeWorktreeLayout()
    try {
      const send = vi.fn()
      startWatcher(gws, send)
      await pump(500)
      // worktree 里 commit 实际写的是 common dir 的 refs/heads/<branch>（worktree gitdir 下的 refs/ 是空的）
      writeFileSync(join(commonDir, 'refs', 'heads', 'wtbranch'), 'abcd\n')
      await pump(1500)
      expect(send).toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
      await stopWatcher(gws)
    } finally {
      rmSync(main, {recursive: true, force: true})
    }
  })

  it('worktree 场景：common dir 的 packed-refs 变化能触发 refs-changed', async () => {
    const {main, commonDir} = makeWorktreeLayout()
    try {
      const send = vi.fn()
      startWatcher(gws, send)
      await pump(500)
      writeFileSync(join(commonDir, 'packed-refs'), '# pack-refs\n')
      await pump(1500)
      expect(send).toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
      await stopWatcher(gws)
    } finally {
      rmSync(main, {recursive: true, force: true})
    }
  })

  it('worktree 场景：fetch 写 worktree gitdir 的 FETCH_HEAD 也触发 refs-changed', async () => {
    const {main, gitDir} = makeWorktreeLayout()
    try {
      const send = vi.fn()
      startWatcher(gws, send)
      await pump(500)
      writeFileSync(join(gitDir, 'FETCH_HEAD'), 'abcd\t\tbranch \'main\' of /x\n')
      await pump(1500)
      expect(send).toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
      await stopWatcher(gws)
    } finally {
      rmSync(main, {recursive: true, force: true})
    }
  })

  it('监听面有界：200 个 loose ref 也不会让 chokidar 递归整棵 refs 树', async () => {
    const heads = join(gws, '.git', 'refs', 'heads')
    mkdirSync(heads, {recursive: true})
    for (let i = 0; i < 200; i++) writeFileSync(join(heads, `branch-${i}`), 'x\n')
    writeFileSync(join(gws, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const watchSpy = vi.spyOn(chokidar, 'watch')
    try {
      const send = vi.fn()
      startWatcher(gws, send)
      await pump(500)
      // chokidar 的目标 = 数组参数（工作区 watcher 传的是单个字符串路径）
      const targets = watchSpy.mock.calls
        .map(c => c[0])
        .filter((a): a is string[] => Array.isArray(a))
        .flat()
      // 固定的小枚举：HEAD/index/logs/HEAD/FETCH_HEAD/packed-refs；refs 目录交给 fs.watch，不在这里
      expect(targets).toEqual(getGitWatchPaths(join(gws, '.git'), join(gws, '.git')))
      expect(targets.some(p => /[\\/]refs([\\/]|$)/.test(p))).toBe(false)
      await stopWatcher(gws)
    } finally {
      watchSpy.mockRestore()
    }
  })

  it('非 git 仓库：静默跳过，工作区 watcher 不受影响', async () => {
    gitExecMock.mockImplementation(async () => { throw new Error('not a git repository') })
    const send = vi.fn()
    startWatcher(gws, send)
    await pump(500)
    writeFileSync(join(gws, 'a.txt'), 'x')
    await pump(1500)
    expect(send).toHaveBeenCalledWith('pm:file-changed', gws, {path: 'a.txt', type: 'add'})
    expect(send).not.toHaveBeenCalledWith('pm:refs-changed', gws, undefined)
    await stopWatcher(gws)
  })

  it('stopWatcher 后 gitdir 变化不再推送', async () => {
    const send = vi.fn()
    mkdirSync(join(gws, '.git', 'refs', 'heads'), {recursive: true})
    writeFileSync(join(gws, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    startWatcher(gws, send)
    await pump(500)
    await stopWatcher(gws)
    writeFileSync(join(gws, '.git', 'refs', 'heads', 'late'), 'x\n')
    await pump(1500)
    expect(send).not.toHaveBeenCalled()
  })

  it('start 后立刻 stop：异步落地的 gitdir watcher 被关掉（防泄漏 + 不再推送）', async () => {
    const send = vi.fn()
    mkdirSync(join(gws, '.git', 'refs', 'heads'), {recursive: true})
    writeFileSync(join(gws, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    startWatcher(gws, send)
    await stopWatcher(gws)   // rev-parse 尚未落地，gitdir watcher 还没建起来
    writeFileSync(join(gws, '.git', 'refs', 'heads', 'main'), 'x\n')
    await pump(1500)
    expect(send).not.toHaveBeenCalled()
  })
})

// 真实 fs + 真实定时器（不启 fake timers）：目录消失在 Windows 下是真事件风暴，只能在真实 I/O 下验证。
describe('refs 目录消失 / 重建（真实 fs）', () => {
  it('被删目录不再刷事件，重建目录后监听恢复可用', async () => {
    const commonDir = mkdtempSync(join(tmpdir(), 'pm-refs-'))
    const heads = join(commonDir, 'refs', 'heads')
    mkdirSync(heads, {recursive: true})
    let events = 0
    const handle = watchRefDirs(commonDir, () => { events++ })
    try {
      // 基线：正常目录里的直接子项变化能触发
      writeFileSync(join(heads, 'main'), 'x\n')
      await sleep(300)
      expect(events).toBeGreaterThan(0)

      // 删除被监听目录：旧实现每收一个 rename 都 onChange → 风暴（~19 万 events/s）。
      // 修复后首个事件即 close 止损，onChange 一次都不会被调用。
      events = 0
      rmSync(heads, {recursive: true, force: true})
      await sleep(400)
      expect(events).toBe(0)

      // 重建目录 → 退避轮询（首轮 500ms）后监听重新生效（旧 handle 永久失聪的场景）
      mkdirSync(heads, {recursive: true})
      await sleep(1500)
      events = 0
      writeFileSync(join(heads, 'main2'), 'y\n')
      await sleep(300)
      expect(events).toBeGreaterThan(0)
    } finally {
      handle.close()
      rmSync(commonDir, {recursive: true, force: true})
    }
  })

  it('close 后不再重建、不再有任何事件', async () => {
    const commonDir = mkdtempSync(join(tmpdir(), 'pm-refs-close-'))
    let events = 0
    const handle = watchRefDirs(commonDir, () => { events++ })
    handle.close()   // 目录本就不存在，此时已排了重建定时器：close 必须把它们清掉
    const heads = join(commonDir, 'refs', 'heads')
    mkdirSync(heads, {recursive: true})
    await sleep(1500)
    writeFileSync(join(heads, 'main'), 'x\n')
    await sleep(300)
    expect(events).toBe(0)
    rmSync(commonDir, {recursive: true, force: true})
  })
})
