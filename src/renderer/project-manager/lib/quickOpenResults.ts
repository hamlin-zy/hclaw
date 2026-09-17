// QuickOpen 结果列表的纯逻辑：条目形状、主进程命中项映射、选中项移动、高亮区间切片、时间格式化。
//
// 与 React 无关，故可单独测试（spec §Testing Decisions：renderer 纯逻辑落成无状态纯函数后测试）。
// **匹配与排序在主进程做**，这里只做「把主进程给的下标切成前后三段」这种机械切片，不重算匹配。
import type {FileSearchHit} from '@shared/types/project-manager'
import type {RecentFileEntry} from './recentFiles'

/** File Search 的输入防抖（spec §File Search：输入后 120ms 防抖） */
export const FILE_SEARCH_DEBOUNCE_MS = 120
/** 单次请求上限（spec：返回前 50 条） */
export const FILE_SEARCH_LIMIT = 50

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 列表条目（三种模式共用一种形状）。
 * 只有 File Search 带命中区间；Recent Files 带打开时间；Find in Files（工单 05）
 * 复用 `line` / `matchText` 两个可选字段，无需改动列表渲染。
 */
export interface QuickOpenItem {
  /** 工作区相对路径（统一 '/'） */
  path: string
  /** 命中区间在 `path` 内的 0-based 下标（[start, end)），由主进程给出；无高亮时为 null */
  matchStart: number | null
  matchEnd: number | null
  /** Recent Files：最近打开时间（毫秒时间戳） */
  openedAt?: number
  /** Find in Files（工单 05 接缝）：命中行号（1-based） */
  line?: number
  /** Find in Files（工单 05 接缝）：命中行文本 */
  matchText?: string
}

/** 主进程命中项 → 列表条目 */
export function hitToItem(hit: FileSearchHit): QuickOpenItem {
  return {path: hit.path, matchStart: hit.matchStart, matchEnd: hit.matchEnd}
}

/** Recent Files 记录 → 列表条目（记录本身已是 MRU 序） */
export function recentToItems(entries: readonly RecentFileEntry[]): QuickOpenItem[] {
  return entries.map(e => ({path: e.path, matchStart: null, matchEnd: null, openedAt: e.openedAt}))
}

/** 相对路径拆成「目录（含尾斜杠）+ 文件名」；无名文件（无 '/'）时目录为空串 */
export function splitRelPath(path: string): {dir: string; name: string} {
  const at = path.lastIndexOf('/')
  return at < 0 ? {dir: '', name: path} : {dir: path.slice(0, at + 1), name: path.slice(at + 1)}
}

/** 高亮切片结果：命中区间前 / 命中段 / 命中区间后 */
export interface HighlightSlice {
  before: string
  hit: string
  after: string
}

/**
 * 把整条路径上的命中区间切给某一段文本。
 * `offset` = 该段文本在整条 `path` 中的起始下标（目录段为 0，文件名段为目录长度）。
 * 区间与本节无交集时 hit 为空串，调用方据此决定是否渲染 `<mark>`。
 */
export function splitHighlight(
  text: string,
  offset: number,
  matchStart: number | null,
  matchEnd: number | null,
): HighlightSlice {
  if (matchStart === null || matchEnd === null || matchEnd <= matchStart) {
    return {before: text, hit: '', after: ''}
  }
  const start = Math.max(0, Math.min(text.length, matchStart - offset))
  const end = Math.max(start, Math.min(text.length, matchEnd - offset))
  return {before: text.slice(0, start), hit: text.slice(start, end), after: text.slice(end)}
}

/** 选中项下移（delta 为 ±1）；夹紧到 [0, length-1]，空列表恒 0 */
export function moveActiveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index + delta))
}

/** 结果集变化后把选中项夹回合法范围（越界回落末项，空列表为 0） */
export function clampActiveIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

/**
 * 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。调用方负责空值/非法值守卫。
 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 打开时间的展示文案：近 1 分钟「刚刚」→ 分钟 → 小时 → 超过一天给出日期时间 */
export function formatOpenedAt(openedAt: number, now = Date.now()): string {
  const diff = now - openedAt
  if (!Number.isFinite(openedAt)) return ''
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  return formatDateTime(openedAt)
}
