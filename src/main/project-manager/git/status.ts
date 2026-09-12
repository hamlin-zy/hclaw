// src/main/project-manager/git/status.ts
import type {GitStatus, GitStatusSummary} from '../../../shared/types/project-manager'
import {gitExec} from './gitExec'
import {parseNumstat} from './numstat'

// porcelain v1：XY <path>；rename 为 XY <old> -> <new>
export function parsePorcelain(raw: string): Record<string, GitStatus> {
  const map: Record<string, GitStatus> = {}
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue
    const indexStatus = line[0]
    const worktreeStatus = line[1]
    let rest = line.slice(3)
    if (rest.startsWith('"')) {
      rest = rest.slice(1, -1).replace(/\\(?:["\\n])/g, (m) => (m === '\\n' ? '\n' : m[1]!))
    }
    const renameMatch = rest.match(/^(.*) -> (.*)$/)
    const oldPath = renameMatch?.[1]
    const path = renameMatch ? renameMatch[2]! : rest
    const status: GitStatus['status'] =
      indexStatus === '?' ? '??'
      : indexStatus === 'R' || worktreeStatus === 'R' ? 'R'
      : indexStatus === 'A' ? 'A'
      : indexStatus === 'D' || worktreeStatus === 'D' ? 'D'
      : 'M'
    map[path] = {path, status, indexStatus, worktreeStatus, oldPath}
  }
  return map
}

const statusCache = new Map<string, {data: GitStatusSummary, time: number}>()

export async function getGitStatusCached(workspace: string): Promise<GitStatusSummary> {
  const cached = statusCache.get(workspace)
  if (cached) {
    if (Date.now() - cached.time < 5000) return cached.data
    // 过期即回收：TTL 只在读路径生效，若不显式 delete，过期条目会永久驻留在 Map 中
    // （workspace 一旦关闭便再无读路径经过，条目永不回收）。
    statusCache.delete(workspace)
  }
  let statusMap: Record<string, GitStatus> = {}
  let additions = 0
  let deletions = 0
  try {
    const [raw, numstatRaw] = await Promise.all([
      gitExec(workspace, ['status', '--porcelain=v1', '-uall']),
      // 无 HEAD（刚 git init、尚无 commit）时 `git diff --numstat HEAD` 退出码 128。
      // 只对 numstat 做局部容错：additions/deletions 归 0，statusMap 不受影响（spec §2.3）。
      // 不用 Promise.allSettled —— 那会连 status 的错误一起吞掉，丢掉"非 git 仓库返回空状态"的既有语义。
      gitExec(workspace, ['diff', '--numstat', 'HEAD']).catch(() => ''),
    ])
    statusMap = parsePorcelain(raw)
    // 聚合 numstat：additions/deletions（二进制 '-' 跳过）
    const stat = parseNumstat(numstatRaw)
    additions = stat.additions
    deletions = stat.deletions
    const data: GitStatusSummary = {statusMap, additions, deletions, updatedAt: Date.now()}
    // 仅成功路径写缓存：git 早期失败（工作区索引未就绪、命令短暂报错等）不应污染 5s 窗口，
    // 否则 FileTree 与 Status 面板会因缓存粘滞空态 5 秒，UI 表现为"检测失败"的假死。
    statusCache.set(workspace, {data, time: Date.now()})
    return data
  } catch {
    // 非 git 仓库或命令失败：返回空状态但**不写缓存**，下次调用立即重试。
    // 同时清掉该 key：本路径返回空状态，若 Map 中还留着旧的（可能非空）条目，
    // 一旦窗口/事件序列错位就会把过期数据当作有效状态返回；删除后保证任何路径下 key 都可回收。
    statusCache.delete(workspace)
    return {statusMap: {}, additions: 0, deletions: 0, updatedAt: Date.now()}
  }
}

export function invalidateStatusCache(workspace: string): void {
  statusCache.delete(workspace)
}
