// Recent Files 的 MRU 纯逻辑 + localStorage 存储适配（spec §Recent Files）
//
// 设计要点（与 usePaneSize.ts 同构，键按工作区分开）：
// - 只记「file 标签页打开成功」这一件事，**不保存文件内容**（只存相对路径 + 时间戳）；
// - MRU：同路径去重后上移到队头，超过上限按 MRU 截断；
// - 读取时**不做存在性校验**：打开浮层不应产生上百次文件系统调用，失效条目在
//   用户真正打开失败时就地标灰并从记录里剔除（由 useQuickOpen 承接）；
// - localStorage 不可用 / 数据损坏一律静默回落空表，绝不抛错。

/** Recent Files 单条记录 */
export interface RecentFileEntry {
  /** 工作区相对路径（统一 '/'，与 FileTree / statusMap 的路径域一致） */
  path: string
  /** 最近一次打开的时刻（毫秒时间戳） */
  openedAt: number
}

/** 记录条数上限（spec：上限 100 条，超出按 MRU 截断） */
export const RECENT_FILES_LIMIT = 100

const STORAGE_PREFIX = 'pm:recentFiles:'

/** localStorage 键：按工作区划分，避免不同仓库互相串味 */
export function recentFilesKey(workspacePath: string): string {
  return STORAGE_PREFIX + workspacePath
}

/**
 * 是否值得记录。
 * 虚拟路径（`__show__<hash>`，见 GitCommitDetail 的「显示完整提交」）不对应磁盘文件，不记。
 */
export function shouldRecordRecent(path: string): boolean {
  return typeof path === 'string' && path !== '' && !path.startsWith('__show__')
}

/** 单条记录是否结构合法（读盘时的逐项校验；容忍非字符串 / 非有限时间戳） */
function isValidEntry(raw: unknown): raw is RecentFileEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const e = raw as Partial<RecentFileEntry>
  return shouldRecordRecent(e.path ?? '') && typeof e.openedAt === 'number' && Number.isFinite(e.openedAt)
}

/**
 * 归一化：丢弃非法项 → 按时间倒序 → 同路径只留最近一次 → 按上限截断。
 * 顺序上「排序」先于「去重」，因此即便存储被外部改写乱序，结果仍是确定的 MRU 序。
 */
export function normalizeRecent(raw: unknown, limit = RECENT_FILES_LIMIT): RecentFileEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: RecentFileEntry[] = []
  for (const entry of [...raw].filter(isValidEntry).sort((a, b) => b.openedAt - a.openedAt)) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    out.push({path: entry.path, openedAt: entry.openedAt})
    if (out.length >= limit) break
  }
  return out
}

/** MRU 合并（纯函数）：同路径去重后上移到队头，超出上限按 MRU 截断 */
export function mergeRecent(
  entries: readonly RecentFileEntry[],
  path: string,
  openedAt: number,
  limit = RECENT_FILES_LIMIT,
): RecentFileEntry[] {
  const next = [{path, openedAt}, ...entries.filter(e => e.path !== path)]
  return next.length > limit ? next.slice(0, limit) : next
}

/** 删除单条（纯函数） */
export function dropRecent(entries: readonly RecentFileEntry[], path: string): RecentFileEntry[] {
  return entries.filter(e => e.path !== path)
}

/** 读取；不可用 / 损坏一律空表 */
export function readRecentFiles(workspacePath: string): RecentFileEntry[] {
  if (!workspacePath) return []
  let raw: string | null
  try {
    raw = localStorage.getItem(recentFilesKey(workspacePath))
  } catch {
    return []   // 隐私模式 / 存储被禁用
  }
  if (!raw) return []
  try {
    return normalizeRecent(JSON.parse(raw))
  } catch {
    return []   // JSON 损坏：静默回落，不打断浮层
  }
}

function writeRecentFiles(workspacePath: string, entries: RecentFileEntry[]): void {
  if (!workspacePath) return
  try {
    localStorage.setItem(recentFilesKey(workspacePath), JSON.stringify(entries))
  } catch {
    /* 配额溢出 / 隐私模式：静默放弃持久化，不影响本次会话 */
  }
}

/** 记录一次打开；返回写入后的列表（调用方可直接拿去渲染） */
export function recordRecentFile(
  workspacePath: string,
  path: string,
  openedAt = Date.now(),
): RecentFileEntry[] {
  if (!workspacePath || !shouldRecordRecent(path)) return readRecentFiles(workspacePath)
  const next = mergeRecent(readRecentFiles(workspacePath), path, openedAt)
  writeRecentFiles(workspacePath, next)
  return next
}

/** 删除单条；返回删除后的列表 */
export function removeRecentFile(workspacePath: string, path: string): RecentFileEntry[] {
  const next = dropRecent(readRecentFiles(workspacePath), path)
  writeRecentFiles(workspacePath, next)
  return next
}

/** 清空当前工作区的记录 */
export function clearRecentFiles(workspacePath: string): void {
  if (!workspacePath) return
  try {
    localStorage.removeItem(recentFilesKey(workspacePath))
  } catch {
    /* 静默放弃 */
  }
}
