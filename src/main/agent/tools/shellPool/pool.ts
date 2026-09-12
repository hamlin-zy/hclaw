/**
 * 持久化 Shell 会话池 — 模块级单例
 *
 * - key = workingDir + shell 名，同 key 复用同一常驻 shell 会话
 * - 5 分钟空闲自动销毁；池上限 LRU 8 条
 * - disposeAll() 供应用退出钩子调用
 */

import {PersistentShellSession, type PoolShellInfo} from './session'

/** 空闲销毁时间（ms） */
const IDLE_DESTROY_MS = 5 * 60 * 1000
/** 池上限（LRU 淘汰） */
const MAX_SESSIONS = 8
/** 空闲扫描间隔（ms） */
const SWEEP_INTERVAL_MS = 60 * 1000

interface PoolEntry {
  session: PersistentShellSession
  lastUsed: number
}

const entries = new Map<string, PoolEntry>()
let sweeper: NodeJS.Timeout | null = null

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(sweep, SWEEP_INTERVAL_MS)
  sweeper.unref?.()
}

function sweep(): void {
  const now = Date.now()
  for (const [key, entry] of entries) {
    if (!entry.session.alive || now - entry.lastUsed > IDLE_DESTROY_MS) {
      entry.session.dispose()
      entries.delete(key)
    }
  }
}

/** 淘汰最久未使用的条目 */
function evictOldest(): void {
  let oldestKey: string | null = null
  let oldestTime = Infinity
  for (const [key, entry] of entries) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed
      oldestKey = key
    }
  }
  if (oldestKey) {
    entries.get(oldestKey)!.session.dispose()
    entries.delete(oldestKey)
  }
}

export interface AcquireOptions {
  workingDir: string
  shellInfo: PoolShellInfo
  env?: NodeJS.ProcessEnv
}

/**
 * 获取（或创建）指定 key 的持久化 shell 会话
 *
 * 创建失败（如初始化探针超时）时抛出异常，调用方应回退到旧 spawn 路径。
 */
export async function acquireSession(opts: AcquireOptions): Promise<PersistentShellSession> {
  const key = `${opts.workingDir}::${opts.shellInfo.shell}`
  ensureSweeper()

  const existing = entries.get(key)
  if (existing) {
    if (existing.session.alive) {
      existing.lastUsed = Date.now()
      return existing.session
    }
    entries.delete(key)
  }

  while (entries.size >= MAX_SESSIONS) {
    evictOldest()
  }

  const session = new PersistentShellSession(
      key,
      opts.shellInfo,
      opts.env ?? process.env,
      opts.workingDir,
      () => entries.delete(key),
  )
  await session.init()
  entries.set(key, {session, lastUsed: Date.now()})
  return session
}

/** 销毁所有池条目（应用退出钩子调用） */
export function disposeAllShellSessions(): void {
  for (const entry of entries.values()) {
    entry.session.dispose()
  }
  entries.clear()
  if (sweeper) {
    clearInterval(sweeper)
    sweeper = null
  }
}

/**
 * 异步销毁所有池条目并等待进程 close（测试环境使用：
 * 确保 OS 释放工作目录句柄后再 rmSync，避免 EPERM）
 */
export async function disposeAllShellSessionsAsync(): Promise<void> {
  const waiters: Promise<void>[] = []
  for (const entry of entries.values()) {
    waiters.push(entry.session.waitClosed())
  }
  disposeAllShellSessions()
  await Promise.all(waiters)
}

/**
 * 剥离输出中的协议标记行（BEGIN/PWD），只保留用户可见输出
 */
export function stripProtocolMarkers(text: string): string {
  return text
      .split(/\r?\n/)
      .filter((line) => !/^__HCLAW_(BEGIN|PWD)_[0-9A-Za-z-]+__/.test(line))
      .join('\n')
}
