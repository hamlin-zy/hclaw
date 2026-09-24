// src/main/project-manager/watcher.ts
import {utilityProcess} from 'electron'
import chokidar from 'chokidar'
import {existsSync, statSync, watch as fsWatch} from 'fs'
import {isAbsolute, join, relative, resolve} from 'path'
import {createLogger} from '../agent/logger'
import {getGitStatusCached, invalidateStatusCache} from './git/status'
import {gitExec} from './git/gitExec'
import type {WatcherInMessage, WatcherOutMessage} from './watcherCore'

/**
 * 本模块是**主进程壳**：工作区文件 watcher 的 chokidar 全量递归扫描已移入 utilityProcess
 * （见 watcherCore.ts / watcherWorker.ts 与 docs/superpowers/specs/2026-09-23-pm-watcher-perf-design.md）。
 * 壳的职责：fork / 消息路由 / refcount 镜像 / 崩溃恢复 / app 退出清理；对外签名保持不变。
 *
 * 留在主进程的部分：**git 内部 watcher**（startGitWatcher / watchRefDirs / getGitWatchPaths）。
 * 它是常数句柄、无扫描，本就不是重活；且它触发的 pm:status-changed / pm:refs-changed 依赖主进程的
 * git status 缓存（invalidateStatusCache 由各写操作 handler 调用），迁进 worker 会造成缓存分裂
 * 与失效不可达。同理，工作区 watcher 事件 500 ms 去抖后的 status 推送也留在壳里（见 scheduleStatusRefresh）。
 */

const logger = createLogger('PMWatcher')

/** 主进程 → 渲染进程的推送回调（window.ts 里绑定到具体窗口） */
type SendToWindow = (channel: string, workspace: string, data: unknown) => void

/** utilityProcess 里我们用到的部分（便于测试注入假实现，不必 import 整个 electron 类型） */
export interface WorkerProcessLike {
  postMessage(message: unknown): void
  on(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): void
  kill(): boolean
}

export type WatcherForkImpl = (modulePath: string) => WorkerProcessLike

/** worker 产物：由 vite.main.config.mjs 的 bundle-watcher-worker 插件输出到 .vite/main/（__dirname 即该目录） */
const WORKER_ENTRY = join(__dirname, 'watcherWorker.cjs')

/** 连续崩溃重建的次数上限：fork 完立刻崩溃时不至于无限重启（收到 ready 即清零） */
const MAX_CRASH_RESTARTS = 5

/** 崩溃重建的退避：500 ms 起、每次翻倍、封顶 8 s（收到 ready 即清零） */
const RESTART_BACKOFF_BASE_MS = 500
const RESTART_BACKOFF_MAX_MS = 8000

/**
 * 默认 fork 实现。
 *
 * **产物存在性检查放在默认实现内部，而不是注入点外层**：测试注入的假 fork 不需要真实产物，
 * 外层前置检查会把它一起挡掉。产物缺失（漏跑 main 构建 / asar 路径异常 / 运行目录不对）时
 * fork 会得到一个永不 ready 的子进程——所有 watch 被静默丢弃、UI 无任何提示，因此这里直接以
 * error 级日志写明期望路径并抛错，由 ensureWorker 的 catch 记 worker-fork-failed（不上抛）。
 */
const defaultFork: WatcherForkImpl = (modulePath) => {
  if (!existsSync(modulePath)) {
    logger.error('worker-entry-missing', {
      entry: modulePath,
      hint: 'worker 产物缺失：文件变更推送已禁用（需先构建 main 产物 .vite/main/watcherWorker.cjs）',
    })
    throw new Error(`watcher worker entry not found: ${modulePath}`)
  }
  return utilityProcess.fork(modulePath) as unknown as WorkerProcessLike
}

/** 注入点：vitest 环境没有 Electron，测试用 __setWatcherForkForTest 注入假实现 */
let forkImpl: WatcherForkImpl = defaultFork

let worker: WorkerProcessLike | null = null
let workerReady = false
let crashRestarts = 0
/** 崩溃重建的退避定时器（pending 期间 worker 为 null；ready / shutdown / 测试隔离时取消） */
let restartTimer: NodeJS.Timeout | null = null

interface ShellEntry {
  /** 创建 watcher 时的**原始** workspace 串：worker 侧 chokidar 的 root 与相对路径基准都用它 */
  workspace: string
  /**
   * 引用计数镜像：语义与迁移前一致（同一 workspace 重复 startWatcher 只 +1）。
   * 只镜像「是否活跃」，真正的 chokidar refcount 在 worker 侧；两者重合，因为下发给 worker 的
   * watch / unwatch 严格由这里的 0→1 / 1→0 边沿驱动。
   */
  refs: number
  /** 500 ms 去抖定时器（迁移前 debounced 的第二段：失效 status 缓存并推送最新 status） */
  timer: NodeJS.Timeout | null
  /** 主进程内的 git 内部 watcher 句柄（gitdir 解析是异步的，落地后回填） */
  gitWatcher: {close: () => Promise<void>} | null
  /** 推送回调（window.ts 传入） */
  send: SendToWindow
  /** 已停止：异步落地与消息转发都要先看它 */
  disposed: boolean
}

// key 一律用 resolve(workspace)（见 startWatcher 注释）：同一目录的两种写法（`E:\ws` / `E:\ws\`）
// 必须落到同一条目，否则 refs 永不归零 → 句柄与 Map key 永久残留。
const watchers = new Map<string, ShellEntry>()

/**
 * 解析 git 内部目录的绝对路径。
 * 不硬编码 <workspace>/.git：worktree / submodule 场景下 .git 是文件，真正的目录在别处。
 * git 有两套目录，必须分开解析（这是 worktree 下 refs 事件的根因）：
 * - `--git-dir`：per-worktree 私有目录，HEAD / index / logs/HEAD / FETCH_HEAD 在此。
 *   worktree 下是 `<主仓库>/.git/worktrees/<name>`，其下的 `refs/` 是**空的**、没有 packed-refs。
 * - `--git-common-dir`：仓库共享目录，`refs/*`、`packed-refs` 在此。worktree 下是 `<主仓库>/.git`。
 * rev-parse 对相对路径（普通仓库输出 `.git`）需绝对化——相对路径交给 chokidar 会以进程 cwd 为基准，
 * watcher 监听不到任何东西。非 git 仓库（rev-parse 失败）返回 null，由调用方静默跳过。
 */
async function resolveGitDir(workspace: string, flag: '--git-dir' | '--git-common-dir'): Promise<string | null> {
  try {
    const out = (await gitExec(workspace, ['rev-parse', flag], 5000)).trim()
    if (!out) return null
    return isAbsolute(out) ? out : join(workspace, out)
  } catch {
    return null
  }
}

/**
 * git 内部待监听路径——**有界枚举**，全部是单文件（三个 refs 目录另行用非递归 fs.watch，见 watchRefDirs），
 * 绝不让 chokidar 递归整棵 refs 树。
 *
 * 背景（实测）：chokidar v5 会为被监听目录里的每个条目各建一个 OS watcher，`depth` 也拦不住；
 * 监听 `refs` 整棵树时，500 个 loose ref → 多占约 508 个句柄，且随 ref 数量线性增长
 * （Linux 下还可能撞 fs.inotify.max_user_watches）。改成下面这些单文件目标后，句柄增量恒为常数。
 *
 * 语义覆盖：
 * - `logs/HEAD`（reflog）覆盖所有「移动 HEAD / 当前分支」的操作——git commit / checkout /
 *   merge / reset / rebase / commit --amend 都会追加写 reflog（已用真实仓库逐一验证）。
 * - `HEAD` 覆盖切分支 / detached HEAD（HEAD 文件内容变化）。
 * - `FETCH_HEAD` 覆盖 git fetch / pull（只改远端跟踪 ref、不动 HEAD 的场景）。
 * - `packed-refs` 覆盖 git pack-refs / gc 对引用库的重写。
 * - `refs/heads`、`refs/remotes`、`refs/tags` 三个目录由 fs.watch 非递归监听，覆盖其中
 *   **直接子项**的增删改（如 git branch <name>、git tag <name>）。
 * 明确不覆盖：
 * - 嵌套分支名（`feature/x`）的 reflog 之外的改动：非递归目录监听看不到二级以下；但这类操作
 *   基本都会移动 HEAD（checkout/commit）而写 logs/HEAD，故实际影响很小。
 * - `git fetch --all` 更新 `refs/remotes/origin/*`（二级路径）——靠 FETCH_HEAD 兜底刷新；
 *   仅当 fetch 完全无事发生（无新对象、FETCH_HEAD 不变）时才不推送，此时也确无新内容可刷。
 * - 直接改 refs 目录但既不写 reflog 也不动直接子项的极端操作；用户仍可用变更列表的刷新按钮兜底。
 */
export function getGitWatchPaths(gitDir: string, commonDir: string): string[] {
  return [
    join(gitDir, 'HEAD'),
    join(gitDir, 'index'),
    join(gitDir, 'logs', 'HEAD'),
    join(gitDir, 'FETCH_HEAD'),
    join(commonDir, 'packed-refs'),
  ]
}

/**
 * 目录「身份签名」：目录不存在（statSync 抛错）时返回 null。
 *
 * 为什么不能只用 existsSync：Windows 上把被监听目录**删掉再立刻重建**时，旧 fs.watch handle 仍绑在
 * 已删除的目录对象上（永久失聪，重建后收不到任何事件），但同名新目录让 existsSync 立刻恢复 true。
 * 用 ino（NTFS 文件索引）+ 诞生时间比对，才能识别出「同名但换了对象」，从而重建 handle。
 * 目录内容增删改不会改变它自身这两个属性，故正常事件不会误判。
 */
function dirSignature(dir: string): string | null {
  try {
    const st = statSync(dir)
    return `${st.ino}:${st.birthtimeMs}`
  } catch {
    return null
  }
}

/**
 * 非递归目录监听（raw fs.watch）：每个 refs 目录只占 1 个 OS 句柄，覆盖其全部**直接子项**。
 * 之所以不用 chokidar：它会给目录里每个 loose ref 各建一个 watcher（见 getGitWatchPaths 注释），
 * 句柄数 O(refs)。这里用 3 个句柄换掉线性增长；嵌套 ref 由 logs/HEAD reflog 兜底。
 *
 * **目录消失语义**（Windows 实测）：删掉被监听的 refs 目录后，fs.watch 会触发**无界** rename 事件风暴
 * （约 19 万 events/秒且不衰减），旧 handle 也永久失聪。因此事件回调里必须先判断目录是否还在：
 * 不在（或已被同名新目录替换）→ 立刻 close 旧 handle 止损，并带退避地轮询重建；目录恢复后重新生效。
 * 若无此判断，每次事件都会走 schedule(true) → 重建防抖定时器，主进程 CPU 空转。
 */
export function watchRefDirs(commonDir: string, onChange: () => void): {close: () => void} {
  const dirs = [
    join(commonDir, 'refs', 'heads'),
    join(commonDir, 'refs', 'remotes'),
    join(commonDir, 'refs', 'tags'),
  ]
  const watchers = new Map<string, ReturnType<typeof fsWatch>>()
  const rebuildTimers = new Map<string, NodeJS.Timeout>()
  const attempts = new Map<string, number>()
  let closed = false

  const closeOne = (dir: string): void => {
    const w = watchers.get(dir)
    if (!w) return
    watchers.delete(dir)
    try { w.close() } catch { /* 已关闭：忽略 */ }
  }

  /** 带指数退避的重建调度（上限 5s）。已有的 pending 定时器不重复创建——避免风暴下定时器churn */
  const scheduleRebuild = (dir: string): void => {
    if (closed || rebuildTimers.has(dir)) return
    const n = attempts.get(dir) ?? 0
    attempts.set(dir, n + 1)
    const delay = Math.min(500 * 2 ** n, 5000)
    const t = setTimeout(() => {
      rebuildTimers.delete(dir)
      watchOne(dir)
    }, delay)
    // 轮询不应单独阻止进程退出
    t.unref()
    rebuildTimers.set(dir, t)
  }

  const watchOne = (dir: string): void => {
    if (closed || watchers.has(dir)) return
    const sig = dirSignature(dir)
    if (sig === null) {
      // 目录不存在（空仓库 / 无 tag / 刚被删）：稍后重试；首次 commit 会写 logs/HEAD，仍能触发 refs-changed
      scheduleRebuild(dir)
      return
    }
    try {
      const w = fsWatch(dir, {persistent: true}, () => {
        // 目录消失（被删除 / 被重命名 / 被同名新目录替换）：立即 close 止损，见函数头注释
        if (dirSignature(dir) !== sig) {
          closeOne(dir)
          scheduleRebuild(dir)
          return
        }
        onChange()
      })
      // 目录被删除等异步错误：必须吞掉，否则 'error' 事件会变成 uncaught exception；同样安排重建
      w.on('error', () => {
        closeOne(dir)
        scheduleRebuild(dir)
      })
      watchers.set(dir, w)
      attempts.delete(dir)   // 监听成功 → 退避计数清零
    } catch {
      // Windows 下 fs.watch 对不存在的目录会同步抛 ENOENT：稍后重试
      scheduleRebuild(dir)
    }
  }

  for (const dir of dirs) watchOne(dir)

  return {
    close: () => {
      closed = true
      for (const t of rebuildTimers.values()) clearTimeout(t)
      rebuildTimers.clear()
      attempts.clear()
      for (const dir of [...watchers.keys()]) closeOne(dir)
    },
  }
}

/** HEAD / reflog / FETCH_HEAD / packed-refs 才是「commit 列表与分支树」的失效源；index（暂存区）不算 */
function isRefsPath(gitDir: string, commonDir: string, p: string): boolean {
  const relGit = relative(gitDir, p).replace(/\\/g, '/')
  if (relGit === 'HEAD' || relGit === 'logs/HEAD' || relGit === 'FETCH_HEAD') return true
  return relative(commonDir, p).replace(/\\/g, '/') === 'packed-refs'
}

/**
 * 监听 git 仓库内部的少量关键路径。
 * 存在的理由：`git add / commit / push` 只改 .git、不动工作区文件，工作区 watcher 一个事件都收不到，
 * 于是 LLM / 终端里发起的提交不会推送到渲染端（变更列表与 commit 列表陈旧，用户体感"等很久也不刷新"）。
 * 只挑 getGitWatchPaths 里那几个单文件入口 + 三个 refs 目录（非递归），绝不递归 .git —— objects 目录
 * 在 gc / fetch 时会写入成千上万个松散对象，递归监听会直接把 chokidar 打爆。
 */
async function startGitWatcher(
  workspace: string,
  sendToWindow: SendToWindow,
  isClosed: () => boolean,
): Promise<{close: () => Promise<void>} | null> {
  const [gitDir, commonDir] = await Promise.all([
    resolveGitDir(workspace, '--git-dir'),
    resolveGitDir(workspace, '--git-common-dir'),
  ])
  if (!gitDir || !commonDir) return null
  const watcher = chokidar.watch(getGitWatchPaths(gitDir, commonDir), {
    ignoreInitial: true,
    awaitWriteFinish: {stabilityThreshold: 300},
  })
  let timer: NodeJS.Timeout | null = null
  // 本防抖窗口内是否动过 refs：只有 refs 动过才推 pm:refs-changed
  let refsDirty = false
  const notify = () => {
    timer = null
    if (isClosed()) return
    const refsMoved = refsDirty
    refsDirty = false
    invalidateStatusCache(workspace)   // 外部写操作后强制刷新，避免推送 5s TTL 内的陈旧 status
    getGitStatusCached(workspace).then(summary => {
      if (isClosed()) return
      sendToWindow('pm:status-changed', workspace, summary)
      // index 变化（git add / rm --cached）不影响 commit 列表与分支树，无差别推送会让它们白刷一次
      if (refsMoved) sendToWindow('pm:refs-changed', workspace, undefined)
    }).catch(() => {})   // 防 unhandled rejection
  }
  const schedule = (isRefs: boolean) => {
    if (isClosed()) return
    if (isRefs) refsDirty = true
    // 已有 pending 定时器就直接返回：不 clear + 重建。事件风暴下（见 watchRefDirs 注释）
    // 反复创建/销毁定时器才是烧 CPU 的元凶；此处把「重置式防抖」放宽成「窗口内只调度一次」，
    // notify 落地时读取的都是最新状态，语义不受影响。
    if (timer) return
    timer = setTimeout(notify, 300)
  }
  watcher.on('all', (_event, p) => schedule(isRefsPath(gitDir, commonDir, p)))
  // refs 目录走非递归 fs.watch：任何直接子项变化都算 refs 动了（不区分文件名，避免依赖具体布局）
  const refWatchers = watchRefDirs(commonDir, () => schedule(true))
  return {
    close: async () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      refWatchers.close()
      await watcher.close()
    },
  }
}

// ─── worker 壳：fork / 消息路由 / 崩溃恢复 ───────────────────────────

/**
 * 下发消息给 worker。未就绪时直接丢弃：就绪（或崩溃重建）后由 handleWorkerMessage 按活跃集合补发。
 *
 * 丢弃语义是正确的（见下面不变式），但「消息发了却没有刷新」必须在日志里留痕，否则只剩 worker-exit 可反推。
 * 不变式：`unwatch` 同样可以安全丢弃 —— 补发只按壳侧活跃集合下发，被丢弃的 unwatch 对应的 workspace
 * 不在其中，因此 worker 侧不会残留「已归零却仍在监听」的实例。
 */
function postToWorker(message: WatcherInMessage): void {
  if (!worker || !workerReady) {
    logger.warn('worker-message-dropped', {
      type: message.type,
      workspace: message.type === 'shutdown' ? undefined : message.workspace,
      hasWorker: worker !== null,
      ready: workerReady,
      active: watchers.size,
    })
    return
  }
  worker.postMessage(message)
}

/** 取消失效的退避重建（ready 到达 / 显式 shutdown / 测试隔离时调用） */
function cancelScheduledRestart(): void {
  if (!restartTimer) return
  clearTimeout(restartTimer)
  restartTimer = null
}

/** 丢弃 worker 引用并清空重建状态（shutdown / 测试隔离共用；不触碰已 fork 出去的进程本身） */
function resetWorkerState(): void {
  worker = null
  workerReady = false
  crashRestarts = 0
  cancelScheduledRestart()
}

/** 崩溃重建的退避时长：第 n 次重建 = 500ms * 2^(n-1)，封顶 8s */
function restartBackoffMs(attempt: number): number {
  return Math.min(RESTART_BACKOFF_BASE_MS * 2 ** (attempt - 1), RESTART_BACKOFF_MAX_MS)
}

/**
 * 安排一次退避后的崩溃重建。退避窗口内若 refcount 已归零则不再重建（否则会在无活跃 workspace 时
 * 白起一个进程）；窗口内出现显式 startWatcher 时由 ensureWorker 取消本定时器。
 */
function scheduleWorkerRestart(): void {
  if (restartTimer) return
  const attempt = crashRestarts
  const delayMs = restartBackoffMs(attempt)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (worker || watchers.size === 0) return
    ensureWorker()
  }, delayMs)
  // 退避轮询不应单独阻止进程退出（app 退出走 before-quit 的 shutdownWatcherProcess）
  restartTimer.unref()
  logger.info('worker-restart-scheduled', {attempt, delayMs})
}

function ensureWorker(): void {
  if (worker) return
  cancelScheduledRestart()
  workerReady = false
  let proc: WorkerProcessLike
  try {
    proc = forkImpl(WORKER_ENTRY)
  } catch (err) {
    // fork 失败不上抛：最坏结果是收不到文件变更推送，不应把开窗流程带崩
    logger.error('worker-fork-failed', {entry: WORKER_ENTRY, error: err instanceof Error ? err.message : String(err)})
    return
  }
  worker = proc
  proc.on('message', (message) => handleWorkerMessage(message as WatcherOutMessage))
  // 'error' 不是单一 Error：Electron UtilityProcess 的签名是 (type, location, report)，
  // location 是 V8 出错位置、report 是 Node diagnostic report（含崩溃栈），是崩溃现场的唯一证据
  proc.on('error', (type, location, report) => {
    logger.error('worker-error', {
      type: String(type),
      location: String(location ?? ''),
      report: String(report ?? '').slice(0, 4000),
    })
  })
  proc.on('exit', (code) => {
    // 主动 kill（shutdownWatcherProcess）或已被替换的旧进程：签名不符，忽略
    if (worker !== proc) return
    worker = null
    workerReady = false
    const active = watchers.size
    logger.warn('worker-exit', {code, active})
    if (active === 0) return
    if (crashRestarts >= MAX_CRASH_RESTARTS) {
      // 达上限后不再自动重建：但 worker 引用已清空，下次 startWatcher（含同 workspace 的 refs += 1）
      // 会补一次 ensureWorker 立刻重新 fork，即这里是「放弃自动恢复」而非「永久放弃」
      logger.error('worker-restart-abandoned', {attempts: crashRestarts, active})
      return
    }
    crashRestarts += 1
    // 崩溃恢复：退避后按当前活跃集合重建 worker 并重新下发 watch（ready 时统一补发）。
    // 退避把「产物损坏 / 环境性崩溃」下的立刻连打 5 次 fork 变成可观测的退避序列。
    // 恢复期间丢事件由渲染层刷新兜底，可接受。
    scheduleWorkerRestart()
  })
  logger.info('worker-forked', {entry: WORKER_ENTRY})
}

function handleWorkerMessage(message: WatcherOutMessage): void {
  switch (message.type) {
    case 'ready':
      workerReady = true
      crashRestarts = 0          // 就绪即清零：退避预算随之重置
      cancelScheduledRestart()
      // 补发积压：worker 启动（或崩溃重建）之前登记的活跃 workspace 在这里统一下发
      for (const entry of watchers.values()) worker?.postMessage({type: 'watch', workspace: entry.workspace})
      return
    case 'file-changed': {
      const entry = watchers.get(resolve(message.workspace))
      if (!entry || entry.disposed) return
      // ① 与迁移前 debounced 的第一段一致：立即推送（载荷结构 {path, type} 与渲染层契约一致）
      entry.send('pm:file-changed', entry.workspace, {path: message.path, type: message.changeType})
      // ② 与迁移前 debounced 的第二段一致：去抖后刷新 status 缓存并推送
      scheduleStatusRefresh(entry)
      return
    }
    case 'error':
      // worker 侧 chokidar 的 error（迁移前会变成主进程的 uncaught exception）
      logger.error('worker-watch-error', {message: message.message})
      return
  }
}

/**
 * 迁移前 debounced 的第二段：500 ms 去抖后失效 status 缓存并推送最新 status。
 * 留在主进程壳的原因：git status 缓存在主进程，且 invalidateStatusCache 由各写操作 handler
 * 调用，迁进 worker 会造成缓存分裂与失效不可达。
 */
function scheduleStatusRefresh(entry: ShellEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (entry.disposed) return
    const {workspace, send} = entry
    invalidateStatusCache(workspace)   // 写操作后强制刷新，避免推送 5s TTL 内的陈旧 status
    getGitStatusCached(workspace).then(summary => {
      if (entry.disposed) return
      send('pm:status-changed', workspace, summary)
    }).catch(() => {})   // 防 unhandled rejection
  }, 500)
}

/** 释放单个条目在主进程侧持有的资源：标记 disposed、清去抖定时器、关闭 git 内部 watcher */
function releaseEntry(entry: ShellEntry): void {
  entry.disposed = true
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (entry.gitWatcher) {
    void entry.gitWatcher.close()   // 内部同时关闭 refs 目录的 fs.watch
    entry.gitWatcher = null
  }
}

export function startWatcher(workspace: string, sendToWindow: SendToWindow): void {
  // key 归一化（与 fileSystem.ts 的 gitRepoCache 同一约定）。只归一化壳的 key：
  // worker 侧 chokidar 的 root 与 relative() 基准仍用原始 workspace，推送路径/行为保持不变。
  const key = resolve(workspace)
  const existing = watchers.get(key)
  if (existing) {
    existing.refs += 1
    // 这里必须补一次 ensureWorker（幂等：worker 已存在时是 no-op）：refcount 0→1 边沿不是唯一
    // 需要拉起 worker 的时机。已有条目但 worker 为空有三种状态——崩溃重建达上限后、
    // shutdownWatcherProcess() 之后、fork 抛错之后——此时只 refs += 1 会让该 workspace 永远收不到
    // 文件变更推送（getWatcherCount 仍返回 1，静默失效）。补这一次后「下次 startWatcher 仍可重新拉起」
    // 对**同一** workspace 也真正成立。
    ensureWorker()
    return
  }
  const entry: ShellEntry = {workspace, refs: 1, timer: null, gitWatcher: null, send: sendToWindow, disposed: false}
  watchers.set(key, entry)
  // 工作区文件 watcher 在 utilityProcess 内：全量递归扫描不得占用主进程的 fs 线程池与事件循环。
  // worker 未就绪时这条 watch 会被丢弃，ready 后由 handleWorkerMessage 按活跃集合补发。
  ensureWorker()
  postToWorker({type: 'watch', workspace})
  // git 内部 watcher 留在主进程（见文件头）。gitdir 解析是异步的：落地时窗口可能已被关闭
  // （stopWatcher 已置 disposed），此时必须把刚建好的 watcher 立刻关掉，否则会漏一个
  // 无人引用、也无人关闭的 chokidar 实例
  void startGitWatcher(workspace, sendToWindow, () => entry.disposed).then(gw => {
    if (!gw) return
    if (entry.disposed) { void gw.close(); return }
    entry.gitWatcher = gw
  }).catch(() => {})   // 非 git 仓库已在内部返回 null，这里只是兜底
}

export async function stopWatcher(workspace: string): Promise<void> {
  // 与 startWatcher 用同一归一化 key，否则递减落到不存在的条目上 → refcount 失衡、句柄不释放
  const key = resolve(workspace)
  const entry = watchers.get(key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  watchers.delete(key)
  releaseEntry(entry)
  // refcount 归零才真正关闭 worker 侧的 chokidar（与迁移前的 Map 语义一致）
  postToWorker({type: 'unwatch', workspace: entry.workspace})
}

export function getWatcherCount(workspace: string): number {
  return watchers.has(resolve(workspace)) ? 1 : 0
}

/** app 退出时终止 worker 进程（before-quit 调用；幂等，不抛） */
export function shutdownWatcherProcess(): void {
  const proc = worker
  resetWorkerState()
  if (!proc) return
  try { proc.postMessage({type: 'shutdown'}) } catch { /* 进程可能已退出：忽略 */ }
  try { proc.kill() } catch { /* 同上 */ }
}

/** 测试注入点：替换 utilityProcess.fork（vitest 环境没有 Electron） */
export function __setWatcherForkForTest(fn: WatcherForkImpl | null): void {
  forkImpl = fn ?? defaultFork
}

/** 测试隔离：丢弃 worker 引用并清空 refcount 镜像（不触碰注入的假进程） */
export function __resetWatcherForTest(): void {
  for (const entry of watchers.values()) releaseEntry(entry)
  watchers.clear()
  resetWorkerState()
}
