// src/main/project-manager/watcher.ts
import chokidar, {type FSWatcher} from 'chokidar'
import {statSync, watch as fsWatch} from 'fs'
import {isAbsolute, join, relative} from 'path'
import {getGitStatusCached, invalidateStatusCache} from './git/status'
import {gitExec} from './git/gitExec'

/** 主进程 → 渲染进程的推送回调（window.ts 里绑定到具体窗口） */
type SendToWindow = (channel: string, workspace: string, data: unknown) => void

const watchers = new Map<string, {watcher: FSWatcher, refs: number, dispose?: () => void}>()

const IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.vite([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])\.trash([\\/]|$)/,
]

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
    t.unref?.()
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

export function startWatcher(workspace: string, sendToWindow: SendToWindow): void {
  const existing = watchers.get(workspace)
  if (existing) {
    existing.refs += 1
    return
  }
  const watcher = chokidar.watch(workspace, {
    ignored: IGNORED,
    depth: 15,
    ignoreInitial: true,
    awaitWriteFinish: {stabilityThreshold: 500},
  })
  let timer: NodeJS.Timeout | null = null
  let closed = false
  const notify = () => {
    if (closed) return
    invalidateStatusCache(workspace)   // 写操作后强制刷新，避免推送 5s TTL 内的陈旧 status
    getGitStatusCached(workspace).then(summary => {
      sendToWindow('pm:status-changed', workspace, summary)
    }).catch(() => {})   // 防 unhandled rejection
  }
  // 规范化为 workspace 相对路径 + 正斜杠：渲染端 fileTreeStore/editorTab 均以相对正斜杠路径为 key
  const normalize = (p: string) => relative(workspace, p).replace(/\\/g, '/')
  const debounced = (path: string, type: string) => {
    if (closed) return
    sendToWindow('pm:file-changed', workspace, {path: normalize(path), type})
    if (timer) clearTimeout(timer)
    timer = setTimeout(notify, 500)
  }
  watcher.on('ready', () => {
    watcher.on('add', (p) => debounced(p, 'add')).on('change', (p) => debounced(p, 'change')).on('unlink', (p) => debounced(p, 'unlink'))
      .on('addDir', (p) => debounced(p, 'addDir')).on('unlinkDir', (p) => debounced(p, 'unlinkDir'))
  })
  // gitdir 解析是异步的：落地时窗口可能已被关闭（stopWatcher 已置 closed），
  // 此时必须把刚建好的 watcher 立刻关掉，否则会漏一个无人引用、也无人关闭的 chokidar 实例
  let gitWatcher: {close: () => Promise<void>} | null = null
  void startGitWatcher(workspace, sendToWindow, () => closed).then(gw => {
    if (!gw) return
    if (closed) { void gw.close(); return }
    gitWatcher = gw
  }).catch(() => {})   // 非 git 仓库已在内部返回 null，这里只是兜底
  watchers.set(workspace, {watcher, refs: 1, dispose: () => {
    closed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (gitWatcher) {
      void gitWatcher.close()
      gitWatcher = null
    }
  }})
}

export async function stopWatcher(workspace: string): Promise<void> {
  const entry = watchers.get(workspace)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    entry.dispose?.()   // 内部同时关闭 git 内部 watcher
    await entry.watcher.close()
    watchers.delete(workspace)
  }
}

export function getWatcherCount(workspace: string): number {
  return watchers.has(workspace) ? 1 : 0
}
