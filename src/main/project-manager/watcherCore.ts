// src/main/project-manager/watcherCore.ts
import chokidar, {type FSWatcher} from 'chokidar'
import {relative, resolve} from 'path'

/**
 * 项目管理窗口「工作区文件 watcher」的 worker 侧核心逻辑。
 *
 * 存在的理由：主进程里跑 chokidar 的全量递归扫描（本机实测 2319 目录 / 20995 文件 → 5.6 s）
 * 会打满**进程级共享**的 libuv fs 线程池（UV_THREADPOOL_SIZE，默认 4）与事件循环，同一时间
 * 排队的 pm:list-directory 要等 5.5 s、主进程事件循环 max lag 1.3 s。放在独立进程（Electron
 * utilityProcess）里才能把这两层都隔离出去（worker_threads 共享线程池，只解决后一层）。
 * 详见 docs/superpowers/specs/2026-09-23-pm-watcher-perf-design.md 第 3 节。
 *
 * ⚠️ 本模块**禁止 import electron**：vitest 环境没有 Electron，且这里的逻辑与宿主无关——
 * 对外只通过注入的 post 回调通信，因此可以直接被单测驱动（真实 chokidar + tmpdir）。
 */

/** chokidar 事件类型（协议冻结，见 brief 第 3.2 节） */
export type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

/** 主进程壳 → worker 的消息（协议冻结） */
export type WatcherInMessage =
  | {type: 'watch', workspace: string}
  | {type: 'unwatch', workspace: string}
  | {type: 'shutdown'}

/**
 * worker → 主进程壳的消息（协议冻结）。
 * 注：变更类型字段名为 `changeType` 而非 brief 里写的 `type` —— 消息判别字段已占用 `type`
 * （`{type: 'file-changed', ...}`），同一对象里再放一个 `type` 会被后者覆盖、判别字段失效。
 * 对外的载荷结构不受影响：主进程壳仍按 `{path, type}` 发 pm:file-changed（渲染层契约不变）。
 */
export type WatcherOutMessage =
  | {type: 'ready'}
  | {type: 'file-changed', workspace: string, path: string, changeType: WatchEventType}
  | {type: 'error', message: string}

/**
 * 与迁移前 watcher.ts 完全相同的忽略规则（正则按路径段匹配，跨平台分隔符均已覆盖）。
 * 迁移前实测 2319 个目录里绝大多数来自 node_modules / .git；这里的语义一字未动。
 */
const IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.vite([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])\.trash([\\/]|$)/,
]

interface CoreEntry {
  watcher: FSWatcher
  /** 引用计数：语义照搬迁移前主进程侧的 refs（同一 workspace 重复 watch 只 +1） */
  refs: number
  /** 已关闭：close 是异步的，期间到达的事件（回调已在 EventEmitter 队列里）不得再上报 */
  closed: boolean
}

export interface WatcherCore {
  /** 处理一条来自主进程壳的消息（同步，不抛） */
  handleMessage(message: WatcherInMessage): void
  /** 关闭全部 chokidar 实例 */
  dispose(): Promise<void>
}

/**
 * 创建 worker 侧核心。`post` 由入口注入（worker 里接 process.parentPort.postMessage，
 * 测试里接假端口）。
 */
export function createWatcherCore(post: (message: WatcherOutMessage) => void): WatcherCore {
  // key 一律用 resolve(workspace)（与主进程壳同一约定）：同一目录的两种写法（`E:\ws` / `E:\ws\`）
  // 必须落到同一条目，否则 refs 永不归零 → chokidar 实例与 OS 句柄成倍、Map key 永久残留。
  const entries = new Map<string, CoreEntry>()

  const watch = (workspace: string): void => {
    const key = resolve(workspace)
    const existing = entries.get(key)
    if (existing) {
      existing.refs += 1
      return
    }
    const entry: CoreEntry = {refs: 1, closed: false, watcher: chokidar.watch(workspace, {
      // 选项与迁移前一字不差：ignored / depth / ignoreInitial / awaitWriteFinish
      ignored: IGNORED,
      depth: 15,
      ignoreInitial: true,
      awaitWriteFinish: {stabilityThreshold: 500},
    })}
    entries.set(key, entry)
    // 规范化为 workspace 相对路径 + 正斜杠：渲染端 fileTreeStore/editorTab 均以相对正斜杠路径为 key
    const emit = (path: string, type: WatchEventType): void => {
      if (entry.closed) return
      post({type: 'file-changed', workspace, path: relative(workspace, path).replace(/\\/g, '/'), changeType: type})
    }
    // 事件语义不变：仍只在 chokidar ready 之后挂 add/change/unlink/addDir/unlinkDir 监听
    entry.watcher.on('ready', () => {
      entry.watcher.on('add', (p) => emit(p, 'add'))
        .on('change', (p) => emit(p, 'change'))
        .on('unlink', (p) => emit(p, 'unlink'))
        .on('addDir', (p) => emit(p, 'addDir'))
        .on('unlinkDir', (p) => emit(p, 'unlinkDir'))
    })
    // chokidar 的 'error' 若无人监听会变成 uncaught exception —— 在 worker 里等于整个进程被杀
    // （迁移前是拖垮主进程）。这里兜底上报给主进程记日志；不影响渲染层语义。
    entry.watcher.on('error', (err: unknown) => {
      post({type: 'error', message: err instanceof Error ? err.message : String(err)})
    })
  }

  /** 关闭一个条目：先关上报闸门（close 是异步的，期间到达的事件不得再上报），再关 chokidar */
  const closeEntry = (entry: CoreEntry): Promise<void> => {
    entry.closed = true
    return entry.watcher.close()
  }

  const unwatch = (workspace: string): void => {
    // 与 watch 用同一归一化 key，否则递减落到不存在的条目上 → refcount 失衡、句柄不释放
    const key = resolve(workspace)
    const entry = entries.get(key)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    entries.delete(key)
    void closeEntry(entry).catch(() => { /* 关闭失败：进程退出时会一并释放，忽略 */ })
  }

  const dispose = async (): Promise<void> => {
    const closing = [...entries.values()]
    entries.clear()
    await Promise.all(closing.map(closeEntry))
  }

  return {
    handleMessage(message) {
      switch (message.type) {
        case 'watch': watch(message.workspace); return
        case 'unwatch': unwatch(message.workspace); return
        case 'shutdown': void dispose(); return
      }
    },
    dispose,
  }
}
