/**
 * 归档卷索引：摘要抽取纯函数 + 索引构建器。
 *
 * 摘要部分输入为归档卷 markdown 的头部片段（不含正文全文），无副作用；
 * 构建器负责扫描归档目录、复用摘要抽取并拼装注入正文与 digest（索引本身不落盘）。
 */

import fs from 'fs'
import {createHash} from 'crypto'
import {join} from 'path'
import {getRefDir, readIndex} from './memoryLoader'

/** 读取归档卷头部时最多读取的字节数 */
export const ARCHIVE_HEAD_BYTES = 2048

/** 摘要行：形如 `> 摘要：xxx`；仅识别「摘要」指引，`> 归档卷：` 不算 */
const SUMMARY_LINE_RE = /^>\s*摘要[：:]\s*(.+?)\s*$/m

/** H1 标题行 */
const H1_LINE_RE = /^#\s+(.+?)\s*$/m

/** 剥掉 H1 开头的「归档卷：」标记 */
const VOLUME_PREFIX_RE = /^归档卷[：:]\s*/

/** 剥掉 H1 开头的日期（yyyy-MM 或 yyyy-MM-dd） */
const DATE_PREFIX_RE = /^\d{4}-\d{2}(-\d{2})?\s*/

/** 剥掉 H1 尾部一层圆括号内容（中/英文括号） */
const TRAILING_PAREN_RE = /[（(][^（()）]*[）)]\s*$/

/** 剥掉 H1 尾部的「专项」字样 */
const TRAILING_SUFFIX_RE = /专项\s*$/

/**
 * 从卷名推导展示用卷名：去掉 .md 扩展名与开头的 yyyy-MM- 前缀，保留连字符。
 */
export function toArchiveVolumeName(fileName: string): string {
  return fileName.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-/, '')
}

/**
 * 抽取归档卷摘要，顺序短路：
 * ① 首个 `> 摘要：` 行；② 首个 H1（依次剥归档卷前缀、日期、尾部括号、尾部「专项」）；
 * ③ 仍为空则回落卷名。最后按码点截断到 maxChars，超长补省略号。
 */
export function extractArchiveSummary(head: string, fileName: string, maxChars: number): string {
  let summary = ''

  const summaryMatch = SUMMARY_LINE_RE.exec(head)
  if (summaryMatch) {
    summary = summaryMatch[1].trim()
  }

  if (!summary) {
    const h1Match = H1_LINE_RE.exec(head)
    if (h1Match) {
      summary = h1Match[1]
        .replace(VOLUME_PREFIX_RE, '')
        .replace(DATE_PREFIX_RE, '')
        .replace(TRAILING_PAREN_RE, '')
        .replace(TRAILING_SUFFIX_RE, '')
        .trim()
    }
  }

  if (!summary) {
    summary = toArchiveVolumeName(fileName)
  }

  // 按码点截断，避免把代理对（如 emoji）切成孤立半字符
  const codePoints = Array.from(summary)
  if (codePoints.length > maxChars) {
    return codePoints.slice(0, maxChars).join('') + '…'
  }
  return summary
}

/** 索引预算默认值（pre-step 消费，用户设置可覆盖） */
export const ARCHIVE_INDEX_DEFAULTS = {
  /** 索引正文总字节上限 */
  maxBytes: 3072,
  /** 单卷摘要最大码点数 */
  summaryMaxChars: 20,
  /** 逐级降级到「仅最近卷」时保留的卷数 */
  recentKeep: 15,
}

/** 索引构建预算 */
export interface ArchiveIndexLimits {
  maxBytes: number
  summaryMaxChars: number
  recentKeep: number
}

/** 单卷索引条目 */
export interface ArchiveEntry {
  /** 展示用卷名（去 .md 与 yyyy-MM- 前缀） */
  name: string
  /** 注入用摘要（已按 summaryMaxChars 截断） */
  summary: string
  /** 文件 mtime（毫秒），用于倒序排列 */
  mtimeMs: number
}

/** 索引构建结果 */
export interface ArchiveIndexResult {
  /** 注入正文 */
  body: string
  /** body 的 sha256（十六进制），用于判断索引是否变化 */
  digest: string
  /** 是否发生过降级或截断 */
  truncated: boolean
}

/** 单个归档目录的扫描缓存 */
interface ArchiveDirCacheEntry {
  /** 缓存键：排序后的 `文件名:mtime` 拼接 */
  key: string
  /** 生成摘要时使用的最大码点数（变化即视为未命中） */
  maxChars: number
  entries: ArchiveEntry[]
}

/** 目录级扫描缓存，避免每轮重复读卷头部 */
const archiveIndexCache = new Map<string, ArchiveDirCacheEntry>()

/** 清空扫描缓存（测试与配置变更后使用） */
export function clearArchiveIndexCache(): void {
  archiveIndexCache.clear()
}

/**
 * 规整预算值：非数值 / 非有限数 / 小于 1 一律回落默认值，其余向下取整但不低于 1。
 * 避免出现「预算为 NaN → 所有比较恒 false」这类静默失控。
 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.max(1, Math.floor(value))
}

/** 合并用户预算与默认值 */
function sanitizeLimits(limits?: Partial<ArchiveIndexLimits>): ArchiveIndexLimits {
  return {
    maxBytes: normalizeLimit(limits?.maxBytes, ARCHIVE_INDEX_DEFAULTS.maxBytes),
    summaryMaxChars: normalizeLimit(limits?.summaryMaxChars, ARCHIVE_INDEX_DEFAULTS.summaryMaxChars),
    recentKeep: normalizeLimit(limits?.recentKeep, ARCHIVE_INDEX_DEFAULTS.recentKeep),
  }
}

/** 行数组的字节数：每行 utf8 字节数 + 1（换行），与最终 body 的字节口径一致 */
function linesBytes(lines: string[]): number {
  let total = 0
  for (const line of lines) total += Buffer.byteLength(line, 'utf8') + 1
  return total
}

/** 展示用目录：统一正斜杠并补尾斜杠 */
function toDisplayDir(dir: string): string {
  return `${dir.replace(/\\/g, '/')}/`
}

/** 带摘要的条目行 */
function summaryLine(entry: ArchiveEntry): string {
  return `- ${entry.name}：${entry.summary}`
}

/** 仅卷名的条目行 */
function nameLine(entry: ArchiveEntry): string {
  return `- ${entry.name}`
}

/** 文件名升序（按原始文件名比较，保证同 mtime 时顺序稳定） */
function compareFileName(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 只读卷头部 ARCHIVE_HEAD_BYTES 字节，避免把整卷正文读进内存 */
function readVolumeHead(filePath: string): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(ARCHIVE_HEAD_BYTES)
    const read = fs.readSync(fd, buf, 0, ARCHIVE_HEAD_BYTES, 0)
    // 字节截断可能切出半个多字节字符，末尾的替换符直接丢掉
    return buf.subarray(0, read).toString('utf8').replace(/\uFFFD$/, '')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 扫描单个归档目录：读目录 → 取 mtime 组成缓存键 → 命中直接返回，未命中才逐卷读头部。
 * 目录不存在或读取失败按「无卷」处理，不抛错。
 */
function scanArchiveDir(dir: string, maxChars: number): ArchiveEntry[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.md'))
  } catch {
    files = []
  }

  if (files.length === 0) {
    archiveIndexCache.set(dir, {key: '', maxChars, entries: []})
    return []
  }

  const stats: {file: string; mtimeMs: number}[] = []
  for (const file of files) {
    try {
      stats.push({file, mtimeMs: fs.statSync(join(dir, file)).mtimeMs})
    } catch {
      // 扫描期间卷被删除：忽略该卷
    }
  }

  const key = stats
    .map((item) => `${item.file}:${item.mtimeMs}`)
    .sort()
    .join('|')
  const cached = archiveIndexCache.get(dir)
  if (cached && cached.key === key && cached.maxChars === maxChars) return cached.entries

  // mtime 倒序；同一 mtime 按原始文件名升序
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs || compareFileName(a.file, b.file))
  const entries: ArchiveEntry[] = []
  for (const item of stats) {
    try {
      entries.push({
        name: toArchiveVolumeName(item.file),
        summary: extractArchiveSummary(readVolumeHead(join(dir, item.file)), item.file, maxChars),
        mtimeMs: item.mtimeMs,
      })
    } catch {
      // 取 mtime 与读头部之间卷被删除或不可读：跳过该卷，不影响其余卷
    }
  }

  archiveIndexCache.set(dir, {key, maxChars, entries})
  return entries
}

/** 单级条目的拟合结果 */
interface FittedEntryLines {
  /** 该级完整行（含标题行与目录行）；硬截断时为单个多行元素 */
  lines: string[]
  truncated: boolean
  /** 是否触发了按码点硬截断（此时该级正文以 … 收尾） */
  hardTruncated: boolean
}

/** 省略号与其 utf8 字节数（3，硬截断时需为其预留） */
const ELLIPSIS = '…'
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8')

/** 按码点硬截断至不超过 maxBytes 字节；预算容得下省略号时补 `…`（绝不切断多字节字符） */
function hardTruncate(text: string, maxBytes: number): string {
  if (maxBytes >= ELLIPSIS_BYTES) return truncateToBytes(text, maxBytes - ELLIPSIS_BYTES) + ELLIPSIS
  return truncateToBytes(text, Math.max(0, maxBytes))
}

/**
 * 在给定预算内为一级归档卷生成完整行（预算含该级标题行与目录行的开销）。
 * 阶段 0 全量 → 阶段 1 最近的 K 卷带摘要、其余仅卷名（K 从 entries.length − 1 递减取满足预算的最大值）
 * → 阶段 2 全部仅卷名 → 阶段 3 仅最近 recentKeep 卷 + 其余卷数提示行（仍超则继续减少保留数，至少留 1 卷）
 * → 阶段 3 之后仍超：按码点硬截断至该级预算并补 `…`（不越权占用整体预算）。
 * 任一阶段降级即 truncated = true。
 */
function fitEntryLines(
  fixedLines: string[],
  entries: ArchiveEntry[],
  budget: number,
  recentKeep: number,
): FittedEntryLines {
  const fixedBytes = linesBytes(fixedLines)
  const fits = (entryLines: string[]): boolean => fixedBytes + linesBytes(entryLines) <= budget

  const full = entries.map(summaryLine)
  if (fits(full)) return {lines: [...fixedLines, ...full], truncated: false, hardTruncated: false}

  for (let keep = entries.length - 1; keep >= 1; keep--) {
    const lines = entries.map((entry, index) => (index < keep ? summaryLine(entry) : nameLine(entry)))
    if (fits(lines)) return {lines: [...fixedLines, ...lines], truncated: true, hardTruncated: false}
  }

  const namesOnly = entries.map(nameLine)
  if (fits(namesOnly)) return {lines: [...fixedLines, ...namesOnly], truncated: true, hardTruncated: false}

  // 阶段 3：仅最近 N 卷 + 「其余 M 卷」注记；仍超则继续减少保留数（至少留 1 卷）
  const initialKeep = Math.min(recentKeep, entries.length)
  for (let keep = initialKeep; keep >= 1; keep--) {
    const lines = entries.slice(0, keep).map(nameLine)
    const rest = entries.length - keep
    if (rest > 0) lines.push(`（其余 ${rest} 卷，可用 bash 列目录查看）`)
    if (fits(lines)) return {lines: [...fixedLines, ...lines], truncated: true, hardTruncated: false}
  }

  // 阶段 3 之后仍超（极端单条超长）：按码点硬截断至该级预算并补 …
  const stage3 = entries.slice(0, initialKeep).map(nameLine)
  const rest = entries.length - initialKeep
  if (rest > 0) stage3.push(`（其余 ${rest} 卷，可用 bash 列目录查看）`)
  const truncatedText = hardTruncate([...fixedLines, ...stage3].join('\n'), budget)
  return {lines: [truncatedText], truncated: true, hardTruncated: true}
}

/** 按码点前缀截断到不超过 maxBytes 字节，绝不产出半个字符（U+FFFD） */
function truncateToBytes(text: string, maxBytes: number): string {
  let used = 0
  let out = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    out += char
  }
  return out
}

/**
 * 构建归档卷索引正文：
 * - 跨项目卷：`mem/ref/_user/archive/*.md`
 * - 项目卷：`mem/ref/<dir>/archive/*.md`（dir 取自 index.json 中当前 workspace 的登记项）
 *
 * 预算：跨项目级 = min(自然长度, floor(maxBytes × 0.5))，余额让渡给项目级。
 * 两级都无卷时返回 null；正文总字节始终不超过 maxBytes。
 */
export function buildArchiveIndex(opts: {
  hclawDir: string
  workspacePath: string | null
  limits?: Partial<ArchiveIndexLimits>
}): ArchiveIndexResult | null {
  const limits = sanitizeLimits(opts.limits)
  const refDir = getRefDir(opts.hclawDir)

  const crossDir = join(refDir, '_user', 'archive')
  const crossEntries = scanArchiveDir(crossDir, limits.summaryMaxChars)

  const indexEntry = opts.workspacePath ? readIndex(opts.hclawDir)?.[opts.workspacePath] : undefined
  const projectDir = indexEntry ? join(refDir, indexEntry.dir, 'archive') : null
  const projectEntries = projectDir ? scanArchiveDir(projectDir, limits.summaryMaxChars) : []

  if (crossEntries.length === 0 && projectEntries.length === 0) return null

  let truncated = false
  const crossLines: string[] = []
  let crossHard = false

  if (crossEntries.length > 0) {
    const title = '## 跨项目归档卷（跨项目通用经验）'
    const dirLine = `目录：${toDisplayDir(crossDir)}`
    const fixedLines = [title, dirLine]
    const naturalBytes = linesBytes(fixedLines) + linesBytes(crossEntries.map(summaryLine))
    const crossBudget = Math.min(naturalBytes, Math.floor(limits.maxBytes * 0.5))
    const fitted = fitEntryLines(fixedLines, crossEntries, crossBudget, limits.recentKeep)
    crossLines.push(...fitted.lines)
    truncated = truncated || fitted.truncated
    crossHard = fitted.hardTruncated
  }

  const projectLines: string[] = []
  let projectHard = false

  if (projectDir && projectEntries.length > 0) {
    const title = `## 本项目归档卷（${indexEntry?.projectName ?? ''}）`
    const dirLine = `目录：${toDisplayDir(projectDir)}`
    // 项目级预算 = maxBytes − 跨项目级实际占用（含两级之间的分隔空行）
    const crossUsage = crossLines.length > 0 ? linesBytes(crossLines) + 1 : 0
    const projectBudget = limits.maxBytes - crossUsage
    const fitted = fitEntryLines([title, dirLine], projectEntries, projectBudget, limits.recentKeep)
    projectLines.push(...fitted.lines)
    truncated = truncated || fitted.truncated
    projectHard = fitted.hardTruncated
  }

  const blocks = [crossLines.join('\n'), projectLines.join('\n')].filter((text) => text.length > 0)
  let body = blocks.join('\n\n') + '\n'

  // 末级若已硬截断，其正文以 … 收尾：去掉尾部换行，避免 … 之后还跟空行
  const lastHard = projectLines.length > 0 ? projectHard : crossHard
  if (lastHard && body.endsWith('\n')) body = body.slice(0, -1)

  // 第二道防线：整体仍超预算时按码点硬截断并补 …（不切断多字节字符）
  if (Buffer.byteLength(body, 'utf8') > limits.maxBytes) {
    body = hardTruncate(body, limits.maxBytes)
    truncated = true
  }

  return {body, digest: createHash('sha256').update(body).digest('hex'), truncated}
}
