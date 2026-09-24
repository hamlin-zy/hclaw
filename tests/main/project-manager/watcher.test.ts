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
// 主进程壳 import {utilityProcess} from 'electron'（vitest 环境无 Electron）：这里只保证模块能加载；
// 真正的 fork 一律由 __setWatcherForkForTest 注入的假实现接管（见 FakeWorkerProcess）
vi.mock('electron', () => ({
  utilityProcess: {fork: vi.fn(() => { throw new Error('fork must be injected in tests') })},
}))
import chokidar from 'chokidar'
import {
  startWatcher,
  stopWatcher,
  getWatcherCount,
  getGitWatchPaths,
  watchRefDirs,
  shutdownWatcherProcess,
  __setWatcherForkForTest,
  __resetWatcherForTest,
  type WorkerProcessLike,
} from '../../../src/main/project-manager/watcher'
import {createWatcherCore, type WatcherOutMessage, type WatchEventType} from '../../../src/main/project-manager/watcherCore'
import {getGitStatusCached, invalidateStatusCache} from '../../../src/main/project-manager/git/status'

/**
 * 假 utilityProcess：记录主进程下发的消息，并允许手动触发 ready / 崩溃 / 伪造 worker → 主进程的消息。
 * 迁移后工作区 watcher 在 worker 进程里，主进程壳的行为（refcount 镜像、消息转发、去抖、崩溃恢复）
 * 只能在假 worker 上验证；worker 侧的真实 chokidar 行为由下面的 watcherCore 用例覆盖。
 */
class FakeWorkerProcess implements WorkerProcessLike {
  sent: unknown[] = []
  killed = false
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>()

  postMessage(message: unknown): void { this.sent.push(message) }

  on(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
  }

  kill(): boolean { this.killed = true; return true }

  emit(event: 'message' | 'exit' | 'error', ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args)
  }

  /** 模拟 worker 启动完成 */
  ready(): void { this.emit('message', {type: 'ready'}) }

  /** 模拟 worker 上报的工作区文件事件（变更类型字段为 changeType，见 WatcherOutMessage 注释） */
  fileChanged(workspace: string, path: string, type: WatchEventType): void {
    this.emit('message', {type: 'file-changed', workspace, path, changeType: type})
  }

  /** 模拟 worker 进程退出（code !== 0 视为崩溃） */
  exit(code = 1): void { this.emit('exit', code) }

  get messages(): {type?: string, workspace?: string}[] { return this.sent as {type?: string, workspace?: string}[] }

  /** 主进程下发的 watch 目标（原始 workspace 串） */
  watchTargets(): string[] {
    return this.messages.filter(m => m.type === 'watch').map(m => m.workspace ?? '')
  }
}

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

describe('watcher 主进程壳（refcount / 消息路由 / 去抖 / 崩溃恢复）', () => {
  let ws: string
  let procs: FakeWorkerProcess[]
  const latest = () => procs[procs.length - 1]

  beforeEach(() => {
    vi.useFakeTimers()
    ws = mkdtempSync(join(tmpdir(), 'pm-watch-'))
    procs = []
    __resetWatcherForTest()
    __setWatcherForkForTest(() => {
      const proc = new FakeWorkerProcess()
      procs.push(proc)
      return proc
    })
  })

  afterEach(() => {
    __resetWatcherForTest()
    gitExecMock.mockReset()
    gitExecMock.mockImplementation(async () => { throw new Error('not a git repository') })
    vi.useRealTimers()
    rmSync(ws, {recursive: true, force: true})
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

  it('refcount 归零才向 worker 下发 unwatch', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    startWatcher(ws, send)                // 2：不重复下发 watch
    expect(latest().watchTargets()).toEqual([ws])

    await stopWatcher(ws)                 // 2 -> 1
    expect(latest().messages.filter(m => m.type === 'unwatch')).toHaveLength(0)
    await stopWatcher(ws)                 // 1 -> 0
    expect(latest().messages.filter(m => m.type === 'unwatch')).toEqual([{type: 'unwatch', workspace: ws}])
  })

  it('worker 未 ready 时不丢登记：ready 后按活跃集合补发 watch', () => {
    const send = vi.fn()
    startWatcher(ws, send)
    // 未就绪：消息先不发（避开 fork 后立刻 postMessage 的时序竞态），寄存器只记状态
    expect(latest().sent).toEqual([])
    latest().ready()
    expect(latest().watchTargets()).toEqual([ws])   // 补发时用原始 workspace 串（相对路径基准不变）
  })

  it('file-changed 转发为 pm:file-changed，并 500ms 去抖后推送 status', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    vi.mocked(getGitStatusCached).mockClear()
    vi.mocked(invalidateStatusCache).mockClear()

    latest().fileChanged(ws, 'x.txt', 'add')
    expect(send).toHaveBeenCalledWith('pm:file-changed', ws, {path: 'x.txt', type: 'add'})
    expect(send).not.toHaveBeenCalledWith('pm:status-changed', ws, expect.anything())   // 去抖窗口内不推 status

    await vi.advanceTimersByTimeAsync(500)
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

  it('去抖窗口内的连续变更只推一次 status（每次重置计时）', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    latest().fileChanged(ws, 'a.txt', 'add')
    await vi.advanceTimersByTimeAsync(400)
    latest().fileChanged(ws, 'b.txt', 'add')
    await vi.advanceTimersByTimeAsync(400)   // 距第二次仅 400ms：不应触发
    expect(send.mock.calls.filter(c => c[0] === 'pm:status-changed')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(send.mock.calls.filter(c => c[0] === 'pm:status-changed')).toHaveLength(1)
    await stopWatcher(ws)
  })

  it('stopWatcher 后不再转发该 workspace 的事件', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    await stopWatcher(ws)
    send.mockClear()
    vi.mocked(getGitStatusCached).mockClear()
    latest().fileChanged(ws, 'late.txt', 'add')
    await vi.advanceTimersByTimeAsync(1500)
    expect(send).not.toHaveBeenCalled()
    expect(getGitStatusCached).not.toHaveBeenCalled()
  })

  it('close 后防抖定时器被清除，不再 notify', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    latest().fileChanged(ws, 'x.txt', 'add')
    await stopWatcher(ws)   // 在 500ms 窗口内停止：clearTimeout + disposed 标记
    send.mockClear()
    vi.mocked(getGitStatusCached).mockClear()
    vi.mocked(invalidateStatusCache).mockClear()
    await vi.advanceTimersByTimeAsync(1500)
    expect(send).not.toHaveBeenCalled()
    expect(getGitStatusCached).not.toHaveBeenCalled()
    expect(invalidateStatusCache).not.toHaveBeenCalled()
  })

  it('worker 崩溃后按活跃集合重建并重新下发 watch（退避 500ms 后）', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    const dead = latest()
    dead.exit(1)

    expect(procs).toHaveLength(1)          // 退避窗口内不立刻 fork：把连打变成可观测的退避序列
    await vi.advanceTimersByTimeAsync(600)
    expect(procs).toHaveLength(2)          // 已重建
    expect(latest()).not.toBe(dead)
    latest().ready()                       // 新 worker 就绪后补发
    expect(latest().watchTargets()).toEqual([ws])
  })

  it('崩溃重建达上限后，同 workspace 再次 startWatcher 能重新 fork 并补发 watch', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    // 连崩到上限：每次崩溃退避 500ms * 2^(n-1) 后重建
    for (let i = 0; i < 5; i++) {
      latest().exit(1)
      await vi.advanceTimersByTimeAsync(16_000)
    }
    expect(procs).toHaveLength(6)
    latest().exit(1)                       // 第 6 次：达上限，放弃自动重建
    await vi.advanceTimersByTimeAsync(16_000)
    expect(procs).toHaveLength(6)
    expect(getWatcherCount(ws)).toBe(1)    // 镜像仍认为活跃：此前 worker 为 null，推送静默失效

    startWatcher(ws, send)                 // 同一 workspace 再 start（refs 1 -> 2）
    expect(procs).toHaveLength(7)          // 必须重新 fork
    latest().ready()
    expect(latest().watchTargets()).toEqual([ws])   // 并补发该 workspace 的 watch
  })

  it('worker 未 ready 期间 stopWatcher：之后 ready 到达也不补发该 workspace', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    await stopWatcher(ws)                  // 未 ready：unwatch 被丢弃，壳侧条目已删除
    expect(latest().messages.filter(m => m.type === 'unwatch')).toHaveLength(0)

    latest().ready()
    // 补发只按壳侧活跃集合：已归零的 workspace 不得被重新 watch（否则 worker 侧残留无人关闭的实例）
    expect(latest().watchTargets()).toEqual([])
    expect(getWatcherCount(ws)).toBe(0)
  })

  it('崩溃（exit）与 unwatch 交错：refcount 不失衡、无幽灵补发', async () => {
    const send = vi.fn()
    const wsB = mkdtempSync(join(tmpdir(), 'pm-watch-b-'))
    try {
      // 顺序 A：unwatch 先于崩溃
      startWatcher(ws, send)
      startWatcher(wsB, send)
      latest().ready()
      await stopWatcher(ws)                          // ws 归零 → 下发 unwatch
      latest().exit(1)
      await vi.advanceTimersByTimeAsync(16_000)      // 退避后重建
      expect(procs).toHaveLength(2)
      latest().ready()
      expect(latest().watchTargets()).toEqual([wsB]) // 不为已归零的 ws 补发
      expect(latest().messages.filter(m => m.type === 'unwatch')).toEqual([])
      expect(getWatcherCount(ws)).toBe(0)
      expect(getWatcherCount(wsB)).toBe(1)

      // 顺序 B：崩溃先于 unwatch（退避窗口内归零 → 到点不得重建）
      latest().exit(1)                               // wsB 仍活跃 → 排退避
      expect(procs).toHaveLength(2)
      await stopWatcher(wsB)                         // 退避窗口内归零
      await vi.advanceTimersByTimeAsync(16_000)
      expect(procs).toHaveLength(2)                  // 无活跃 workspace：不重建、不产生幽灵进程
      expect(getWatcherCount(wsB)).toBe(0)
    } finally {
      await stopWatcher(ws).catch(() => {})
      await stopWatcher(wsB).catch(() => {})
      rmSync(wsB, {recursive: true, force: true})
    }
  })

  it('worker 崩溃时若已无活跃 watcher 则不重建', async () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    await stopWatcher(ws)
    latest().exit(1)
    expect(procs).toHaveLength(1)
  })

  it('shutdownWatcherProcess 终止 worker，其 exit 不触发重建', () => {
    const send = vi.fn()
    startWatcher(ws, send)
    latest().ready()
    const proc = latest()
    shutdownWatcherProcess()
    expect(proc.killed).toBe(true)
    proc.exit(0)                           // 主动 kill 带来的 exit
    expect(procs).toHaveLength(1)
  })

  it('回归守卫：主进程壳不再对工作区直接 chokidar.watch（扫描只在 worker 侧）', async () => {
    // 让 git watcher 真的建起来（否则应断言的目标集合为空，判别力不足）
    gitExecMock.mockImplementation(async (_ws: string, args: string[]) => args[0] === 'rev-parse' ? '.git\n' : '')
    const watchSpy = vi.spyOn(chokidar, 'watch')
    try {
      const send = vi.fn()
      startWatcher(ws, send)
      await vi.advanceTimersByTimeAsync(500)   // 等 gitdir 的 rev-parse 落地
      const targets = watchSpy.mock.calls.map(c => c[0])
      // 工作区 watcher 的目标是单个字符串路径；主进程只允许出现 git watcher 的单文件数组
      expect(targets.some(t => typeof t === 'string')).toBe(false)
      expect(targets.every(t => Array.isArray(t))).toBe(true)
      await stopWatcher(ws)
    } finally {
      watchSpy.mockRestore()
    }
  })
})

describe('watcherCore（worker 侧核心：真实 chokidar + tmpdir）', () => {
  let ws: string
  let messages: WatcherOutMessage[]
  let core: ReturnType<typeof createWatcherCore>

  beforeEach(() => {
    vi.useFakeTimers()
    ws = mkdtempSync(join(tmpdir(), 'pm-core-'))
    messages = []
    core = createWatcherCore(m => messages.push(m))
  })

  afterEach(async () => {
    await core.dispose()
    vi.useRealTimers()
    rmSync(ws, {recursive: true, force: true})
  })

  it('文件变更上报 file-changed（相对正斜杠路径）', async () => {
    core.handleMessage({type: 'watch', workspace: ws})
    await pump(300)   // 等 chokidar ready
    writeFileSync(join(ws, 'x.txt'), 'change')
    await pump(1500)  // awaitWriteFinish 500ms + I/O 轮转
    expect(messages).toContainEqual({type: 'file-changed', workspace: ws, path: 'x.txt', changeType: 'add'})
  })

  it('子目录变更推送相对正斜杠路径（Windows 反斜杠规范化）', async () => {
    core.handleMessage({type: 'watch', workspace: ws})
    await pump(300)
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub', 'y.txt'), 'new')
    await pump(1500)
    expect(messages).toContainEqual({type: 'file-changed', workspace: ws, path: 'sub/y.txt', changeType: 'add'})
  })

  it('chokidar 选项与迁移前一字不差（ignored / depth / ignoreInitial / awaitWriteFinish）', () => {
    const watchSpy = vi.spyOn(chokidar, 'watch')
    try {
      core.handleMessage({type: 'watch', workspace: ws})
      expect(watchSpy).toHaveBeenCalledWith(ws, {
        ignored: expect.any(Array),
        depth: 15,
        ignoreInitial: true,
        awaitWriteFinish: {stabilityThreshold: 500},
      })
    } finally {
      watchSpy.mockRestore()
    }
  })

  it('ignored 规则沿用：node_modules 下的变更不上报', async () => {
    core.handleMessage({type: 'watch', workspace: ws})
    await pump(300)
    mkdirSync(join(ws, 'node_modules'))
    writeFileSync(join(ws, 'node_modules', 'pkg.js'), 'x')
    await pump(1500)
    expect(messages).toEqual([])
  })

  it('同一 workspace 的两种写法归一到同一条目（只建一个 chokidar 实例）', () => {
    const watchSpy = vi.spyOn(chokidar, 'watch')
    try {
      core.handleMessage({type: 'watch', workspace: ws})
      core.handleMessage({type: 'watch', workspace: `${ws}\\`})   // 尾斜杠写法
      expect(watchSpy).toHaveBeenCalledTimes(1)
    } finally {
      watchSpy.mockRestore()
    }
  })

  it('refcount 归零才关闭 chokidar，归零后不再上报事件', async () => {
    core.handleMessage({type: 'watch', workspace: ws})
    core.handleMessage({type: 'watch', workspace: ws})
    core.handleMessage({type: 'unwatch', workspace: ws})   // 2 -> 1：仍活跃
    await pump(300)
    writeFileSync(join(ws, 'a.txt'), 'x')
    await pump(1500)
    expect(messages).toHaveLength(1)

    core.handleMessage({type: 'unwatch', workspace: ws})   // 归零
    await pump(300)                                        // 等 close 落地
    messages.length = 0
    writeFileSync(join(ws, 'b.txt'), 'y')
    await pump(1500)
    expect(messages).toEqual([])
  })

  it('shutdown 关闭全部 watcher', async () => {
    core.handleMessage({type: 'watch', workspace: ws})
    await pump(300)
    core.handleMessage({type: 'shutdown'})
    await pump(300)
    messages.length = 0
    writeFileSync(join(ws, 'z.txt'), 'z')
    await pump(1500)
    expect(messages).toEqual([])
  })
})

describe('gitdir 内部监听（外部 add / commit / push 只改 .git）', () => {
  let gws: string
  let procs: FakeWorkerProcess[]
  const latest = () => procs[procs.length - 1]

  beforeEach(() => {
    vi.useFakeTimers()
    gws = mkdtempSync(join(tmpdir(), 'pm-watch-git-'))
    procs = []
    __resetWatcherForTest()
    __setWatcherForkForTest(() => {
      const proc = new FakeWorkerProcess()
      procs.push(proc)
      return proc
    })
    gitExecMock.mockReset()
    // 普通仓库：rev-parse --git-dir 输出相对 cwd 的 '.git'
    gitExecMock.mockImplementation(async (_ws: string, args: string[]) =>
      args[0] === 'rev-parse' ? '.git\n' : '')
  })
  afterEach(async () => {
    await stopWatcher(gws).catch(() => {})
    __resetWatcherForTest()
    gitExecMock.mockReset()
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
      // chokidar 的目标 = 数组参数（工作区 watcher 已移出主进程；此处的数组只可能来自 git watcher）
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

  it('非 git 仓库：静默跳过，工作区事件链路不受影响', async () => {
    gitExecMock.mockImplementation(async () => { throw new Error('not a git repository') })
    const send = vi.fn()
    startWatcher(gws, send)
    await pump(500)
    latest().ready()
    latest().fileChanged(gws, 'a.txt', 'add')   // 工作区变更由 worker 侧上报
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
