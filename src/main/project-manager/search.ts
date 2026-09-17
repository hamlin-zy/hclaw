// src/main/project-manager/search.ts
/**
 * PM 快速导航（QuickOpen）主进程检索服务。
 *
 * 契约见 .scratch/pm-quickopen/spec.md「数据来源」段：文件清单 / 全文检索 / 按行读取
 * 三项能力全部落在这一层，做成 `(workspace, 参数) → 数据` 的**无状态函数面**，
 * IPC handler（window.ts）只当薄壳。忽略规则、上限护栏、截断标注、EOF 短路等规则
 * 都在此处验证（tests/main/project-manager/search.test.ts）。
 *
 * 三个对外能力：
 * - searchFiles        —— 文件清单 + File Search 匹配（大小写不敏感子串，主进程排序）
 * - readLines          —— 按行范围流式读取（不整体载入文件）
 * - startFindInFiles / getFindInFilesPage / stopFindInFiles —— 长驻 rg 子进程会话，按页取命中项
 */

import {spawn, type ChildProcess} from 'child_process'
import {createHash} from 'crypto'
import {createReadStream} from 'fs'
import {readdir, stat} from 'fs/promises'
import {join, relative, resolve} from 'path'
import {StringDecoder} from 'string_decoder'
// 注意：必须用改写后的真实磁盘路径。@vscode/ripgrep 的 rgPath 在打包后指向 app.asar 内的
// 虚拟路径，Electron 只对 fs 透明化（existsSync 为 true）、对 child_process 不透明化 → spawn ENOENT。
import {rgBinPath} from '../utils/ripgrepPath'
import type {
  FileSearchHit,
  FileSliceResult,
  FindInFilesMatch,
  FindInFilesPage,
} from '../../shared/types/project-manager'
import {assertInWorkspace} from './fileSystem'

// ─── 常量 ─────────────────────────────────────────────────────────────────

/** 排除目录：与 fileSystem.ts 的 BLACKLIST 对齐（.git 同时是隐藏目录，rg 默认亦跳过） */
const EXCLUDED_DIRS = ['.git', 'node_modules', '.vite', '.cache', '.trash']
const EXCLUDED_DIR_SET = new Set(EXCLUDED_DIRS)

/** 文件清单缓存 TTL：30 秒（spec「数据来源」段） */
const FILE_LIST_TTL_MS = 30_000

/** 缓存护栏：路径条数上限 20 万条、清单字节数上限 8MB；超限则**不缓存**，只走一次性流式过滤 */
const FILE_LIST_MAX_PATHS = 200_000
const FILE_LIST_MAX_BYTES = 8 * 1024 * 1024

/** File Search 单次返回上限 */
const DEFAULT_SEARCH_LIMIT = 50

/** Find in Files 缓冲上限：5000 个命中项或 4MB，达到即终止进程并标注截断 */
const FIND_MAX_MATCHES = 5000
const FIND_MAX_BYTES = 4 * 1024 * 1024

/**
 * 按行读取的文件大小阈值：**自定义**为 100MB。
 * 按行读不受全量读（fileSystem.ts 的 5MB）约束——大文件只读请求范围那几行；
 * 但连 stat 都超过 100MB 的文件通常是日志/数据转储，预览无意义且读取代价不可控，直接给明确文案。
 */
const MAX_SLICE_FILE_SIZE = 100 * 1024 * 1024

/**
 * EOF 短路阈值：请求范围已抵达文件尾且文件不超过 256KB 时，一并返回 fullContent + hash，
 * 供编辑器标签页直接使用（口径对齐 fileSystem.ts:readFileForViewer 的 sha256 前 16 位）。
 */
const EOF_FULL_CONTENT_LIMIT = 256 * 1024

/** JS 遍历回退的递归深度上限（防符号链接环） */
const WALK_MAX_DEPTH = 40

// ─── 测试 seam ─────────────────────────────────────────────────────────────

type SpawnFn = typeof spawn
let spawnFn: SpawnFn = spawn

/** 测试用：注入 spawn（或传 null 还原）。生产路径永不调用，测试不得真起 rg 进程。 */
export function __setSpawnForTest(fn: SpawnFn | null): void {
  spawnFn = fn ?? spawn
}

/** 测试用：覆盖缓存护栏阈值（传 null 还原生产值；生产不调用） */
export function __setFileListLimitsForTest(limits: {maxPaths?: number; maxBytes?: number} | null): void {
  fileListMaxPaths = limits?.maxPaths ?? FILE_LIST_MAX_PATHS
  fileListMaxBytes = limits?.maxBytes ?? FILE_LIST_MAX_BYTES
}

/** 测试用：覆盖 Find in Files 缓冲上限（传 null 还原生产值；生产不调用） */
export function __setFindBufferLimitsForTest(limits: {maxMatches?: number; maxBytes?: number} | null): void {
  findMaxMatches = limits?.maxMatches ?? FIND_MAX_MATCHES
  findMaxBytes = limits?.maxBytes ?? FIND_MAX_BYTES
}

let fileListMaxPaths = FILE_LIST_MAX_PATHS
let fileListMaxBytes = FILE_LIST_MAX_BYTES
let findMaxMatches = FIND_MAX_MATCHES
let findMaxBytes = FIND_MAX_BYTES

// ─── 纯函数（可直接单测，无 I/O） ──────────────────────────────────────────

/** Windows 分隔符统一为 '/ '（'/' 在 Windows 与 POSIX 上都是合法分隔符） */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 大小写不敏感子串匹配：返回 path 中的 0-based 区间 [matchStart, matchEnd)；未命中返回 null */
export function matchPath(relPath: string, query: string): {matchStart: number; matchEnd: number} | null {
  if (!query) return null
  const idx = relPath.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return null
  return {matchStart: idx, matchEnd: idx + query.length}
}

/**
 * 命中项排序 + 截断：
 * 1. 路径更浅优先（'/' 段数少者优先）
 * 2. 匹配位置更靠前者优先
 * 3. path 升序（末位保证结果稳定，不依赖扫描顺序）
 */
export function rankFileHits(hits: FileSearchHit[], limit: number): FileSearchHit[] {
  const take = Math.max(0, Math.floor(limit))
  return hits
    .map(hit => ({hit, depth: toPosixPath(hit.path).split('/').length}))
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      if (a.hit.matchStart !== b.hit.matchStart) return a.hit.matchStart - b.hit.matchStart
      return a.hit.path < b.hit.path ? -1 : a.hit.path > b.hit.path ? 1 : 0
    })
    .slice(0, take)
    .map(e => e.hit)
}

interface RgJsonEvent {
  type?: string
  data?: {
    path?: {text?: string}
    lines?: {text?: string}
    line_number?: number
    submatches?: Array<{start?: number; end?: number}>
  }
}

/** rg byte offset（相对行文本的 UTF-8 字节数）→ JS 字符串下标 */
function byteOffsetToCharIndex(text: string, byteOffset: number): number {
  if (!(byteOffset > 0)) return 0
  const buf = Buffer.from(text, 'utf8')
  if (byteOffset >= buf.length) return text.length
  return buf.subarray(0, byteOffset).toString('utf8').length
}

/**
 * 解析一条 rg `--json` 事件为命中项列表（纯函数，可单测）。
 * 非 match 事件（begin/end/summary/context）返回 []。
 *
 * **命中项的单位是行**（CONTEXT.md「命中项（Match）：一处命中 = 一个文件 + 一个行号 + 该行文本」）：
 * 同一行的多个 submatch 只产**一条**命中项，区间取该行**第一个** submatch，其余丢弃。
 * 否则 `needle needle needle` 这种行会在列表里出现 3 条 path:line 与行文本完全相同的行，
 * 键盘要多按 3 次，`foldFindItems` 的「还有 M 处」计数也被放大。
 */
export function parseRgMatchEvent(event: unknown, workspace: string): FindInFilesMatch[] {
  if (!event || typeof event !== 'object') return []
  const e = event as RgJsonEvent
  if (e.type !== 'match' || !e.data) return []
  const rawPath = e.data.path?.text
  const lineNo = e.data.line_number
  if (!rawPath || typeof lineNo !== 'number') return []

  const path = toRelativePosix(workspace, rawPath)
  // rg 的 lines.text 含行尾换行符；命中区间以不含换行符的行文本为基准
  const text = stripTrailingNewline(e.data.lines?.text ?? '')
  const first = (e.data.submatches ?? [])[0]
  return [{
    path,
    line: lineNo,
    text,
    matchStart: byteOffsetToCharIndex(text, first?.start ?? 0),
    matchEnd: byteOffsetToCharIndex(text, first?.end ?? 0),
  }]
}

/** 相对 workspace 的 '/' 分隔路径（rg 输出可能带 './'、绝对路径或 Windows 反斜杠） */
function toRelativePosix(workspace: string, p: string): string {
  return toPosixPath(relative(resolve(workspace), resolve(workspace, p)))
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1).replace(/\r$/, '') : text
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

// ─── 文件清单 ──────────────────────────────────────────────────────────────

interface FileListCacheEntry {
  paths: string[]
  at: number
}

const fileListCache = new Map<string, FileListCacheEntry>()

/** 测试用：清空文件清单缓存 */
export function resetFileListCache(): void {
  fileListCache.clear()
}

/** 按 workspace 回收文件清单缓存（PM 窗口关闭 / 工作区卸载时调用，对齐 deleteGitRepoCache 范式） */
export function deleteFileListCache(workspace: string): void {
  fileListCache.delete(resolve(workspace))
}

/**
 * rg `--files` 参数：
 * - 默认即尊重 .gitignore、跳过隐藏文件（未传 --hidden）；
 * - **`--no-require-git` 必传**：rg 默认 `require_git(true)`，即不在 git 仓库内时**完全不解析
 *   `.gitignore`**。PM 的工作区可以是任意目录（非 git 仓库同样要能打开），
 *   此时目录里的 `.gitignore` 会被无视、被忽略的文件照旧列出。显式关掉该要求后，
 *   非 git 工作区也尊重 `.gitignore`（仓库内行为不变）。
 * - 逐个排除依赖 / 构建目录，口径对齐 fileSystem.ts 的 BLACKLIST。
 */
function rgFileListArgs(): string[] {
  const args = ['--files', '--no-messages', '--no-require-git']
  for (const dir of EXCLUDED_DIRS) args.push('-g', `!${dir}`)
  args.push('.')
  return args
}

type PathSink = (relPath: string) => void

/**
 * 遍历工作区路径清单（流式：回调逐条给出，不在中间层累积）。
 * 优先 rg --files；rg 不可用（未安装 / spawn 失败 / 立即 error）时回退 JS 遍历。
 */
async function streamWorkspacePaths(workspace: string, sink: PathSink): Promise<void> {
  const ok = await streamRgPaths(workspace, sink)
  if (!ok) await walkWorkspacePaths(workspace, sink)
}

function streamRgPaths(workspace: string, sink: PathSink): Promise<boolean> {
  return new Promise<boolean>(resolvePromise => {
    let child: ChildProcess
    try {
      child = spawnFn(rgBinPath, rgFileListArgs(), {cwd: workspace, windowsHide: true})
    } catch {
      resolvePromise(false)
      return
    }

    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolvePromise(ok)
    }

    child.on('error', () => finish(false))

    let rest = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf-8')
      let idx: number
      while ((idx = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, idx)
        rest = rest.slice(idx + 1)
        const rel = line.trim() ? toRelativePosix(workspace, line.replace(/\r$/, '')) : ''
        if (rel) sink(rel)
      }
    })
    child.stderr?.on('data', () => { /* --no-messages 已抑制大部分；此处不参与判定 */ })
    child.on('close', () => {
      const tail = rest.replace(/\r$/, '')
      if (tail.trim()) sink(toRelativePosix(workspace, tail))
      finish(true)
    })
  })
}

/**
 * JS 遍历回退：跳过隐藏文件 / 隐藏目录 + 排除目录（对齐 rg 的默认行为）。
 * 注：回退路径不解析 .gitignore —— rg 缺失本就是降级场景，此处只保证隐藏与排除规则。
 */
async function walkWorkspacePaths(workspace: string, sink: PathSink, dir = '', depth = 0): Promise<void> {
  if (depth > WALK_MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(join(workspace, dir), {withFileTypes: true})
  } catch {
    return // 无权限 / 目录消失：跳过该子树
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory() && EXCLUDED_DIR_SET.has(entry.name)) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) await walkWorkspacePaths(workspace, sink, rel, depth + 1)
    else sink(rel)
  }
}

// ─── File Search ───────────────────────────────────────────────────────────

/**
 * File Search：工作区文件清单里做大小写不敏感子串匹配，主进程排序并截断。
 *
 * 缓存策略：命中 30 秒内的清单缓存则直接复用；否则一次扫描同时完成
 * 「收集可缓存清单」与「边扫边匹配」——若收集过程中越过大护栏，
 * 立即丢弃已收集的部分（不留存清单、不写缓存），但仍继续流式匹配，行为保持正确。
 */
export async function searchFiles(workspace: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<FileSearchHit[]> {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return [] // 空查询不发请求、不扫描

  const key = resolve(workspace)
  const cached = fileListCache.get(key)
  if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) {
    const hits: FileSearchHit[] = []
    for (const p of cached.paths) {
      const m = matchPath(p, q)
      if (m) hits.push({path: p, ...m})
    }
    return rankFileHits(hits, limit)
  }

  const hits: FileSearchHit[] = []
  let paths: string[] | null = []
  let bytes = 0

  await streamWorkspacePaths(workspace, rel => {
    if (paths) {
      bytes += Buffer.byteLength(rel, 'utf8') + 1
      if (paths.length >= fileListMaxPaths || bytes > fileListMaxBytes) {
        paths = null // 超限：降级为不缓存（丢弃已收集的清单，不留存）
      } else {
        paths.push(rel)
      }
    }
    const m = matchPath(rel, q)
    if (m) hits.push({path: rel, ...m})
  })

  if (paths) fileListCache.set(key, {paths, at: Date.now()})
  return rankFileHits(hits, limit)
}

// ─── 按行读取 ──────────────────────────────────────────────────────────────

function sliceError(relPath: string, startLine: number, endLine: number, message: string): FileSliceResult {
  return {path: relPath, startLine, endLine, totalLines: 0, lines: [], error: message}
}

function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return '文件不存在或已被移动'
  if (code === 'EACCES' || code === 'EPERM') return '没有读取该文件的权限'
  return '读取文件失败'
}

function toLineNumber(value: number, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? n : fallback
}

/**
 * 按行范围读取（QuickOpen 预览取数）。
 *
 * - **流式**：只在内存里保留请求范围内的行文本，读到 endLine 即停（最多再多读一个 chunk 用于判定 EOF），
 *   因此大文件不会整体载入，也不受全量读 5MB 上限约束。
 * - 行号越界一律夹到合法范围；空文件 totalLines=0。
 * - **EOF 短路**：请求范围抵达文件尾且文件 ≤256KB 时一并返回 fullContent + hash（sha256 前 16 位）。
 * - 失败（二进制 / 过大 / 无权限 / 已消失）返回单行中文 error 且 lines 为 []。
 * - `totalLines`：读到文件尾时为精确总行数；因 endLine 提前停止（未到 EOF）时为 -1（未知）。
 */
export async function readLines(
  workspace: string,
  relPath: string,
  startLine: number,
  endLine: number,
): Promise<FileSliceResult> {
  const start = Math.max(1, toLineNumber(startLine, 1))
  const end = Math.max(start, toLineNumber(endLine, start))

  let abs: string
  try {
    abs = assertInWorkspace(workspace, relPath)
  } catch {
    return sliceError(relPath, start, end, '路径超出工作目录')
  }

  let size: number
  let mtime: number
  try {
    const st = await stat(abs)
    if (st.isDirectory()) return sliceError(relPath, start, end, '目标不是文件')
    size = st.size
    mtime = st.mtimeMs
  } catch (err) {
    return sliceError(relPath, start, end, describeFsError(err))
  }
  if (size > MAX_SLICE_FILE_SIZE) {
    return sliceError(relPath, start, end, `文件过大（超过 ${MAX_SLICE_FILE_SIZE / 1024 / 1024}MB），无法预览`)
  }

  // 只有可能触发 EOF 短路的文件才需要留存原始字节（≤256KB）
  const captureFull = size <= EOF_FULL_CONTENT_LIMIT
  const chunks: Buffer[] = []
  const decoder = new StringDecoder('utf8')

  let rest = ''
  let lineNo = 0
  const lines: string[] = []
  let binary = false
  let finishedRange = false // 已读满请求范围，之后只用于判定 EOF
  let sawMoreData = false // 结束前仍读到数据 → 未到文件尾

  const stream = createReadStream(abs)
  try {
    let first = true
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      if (finishedRange) {
        // 上一步恰好停在 endLine 的行尾：再拿到一个 chunk 即说明后面还有内容
        sawMoreData = true
        break
      }
      if (first) {
        first = false
        // 二进制嗅探：首个 chunk 含 NUL 即判定二进制（无需读全文件）
        if (buf.includes(0)) {
          binary = true
          break
        }
      }
      if (captureFull) chunks.push(buf)
      rest += decoder.write(buf)

      let idx: number
      while ((idx = rest.indexOf('\n')) !== -1) {
        const raw = rest.slice(0, idx)
        rest = rest.slice(idx + 1)
        lineNo++
        if (lineNo >= start && lineNo <= end) lines.push(stripCr(raw))
        if (lineNo >= end) {
          finishedRange = true
          break
        }
      }
      if (finishedRange && rest.length > 0) {
        sawMoreData = true
        break
      }
    }
  } catch (err) {
    return sliceError(relPath, start, end, describeFsError(err))
  } finally {
    stream.destroy()
  }

  if (binary) return sliceError(relPath, start, end, '二进制文件，无法预览')

  const eof = !sawMoreData
  if (eof) rest += decoder.end()
  // 文件末尾没有换行符时，残余即最后一行
  if (!finishedRange && rest.length > 0) {
    lineNo++
    if (lineNo >= start && lineNo <= end) lines.push(stripCr(rest))
  }

  const result: FileSliceResult = {
    path: relPath,
    startLine: eof ? Math.min(start, lineNo) : start,
    endLine: eof ? Math.min(end, lineNo) : end,
    totalLines: eof ? lineNo : -1,
    lines,
    // 元信息行（预览用）：取数成功才带上，失败路径没有意义
    size,
    mtime,
  }
  if (eof && captureFull) {
    const full = Buffer.concat(chunks)
    result.fullContent = full.toString('utf-8')
    result.hash = createHash('sha256').update(full).digest('hex').slice(0, 16)
  }
  return result
}

// ─── Find in Files 会话 ────────────────────────────────────────────────────

interface FindSession {
  id: string
  workspace: string
  matches: FindInFilesMatch[]
  bytes: number
  /** 进程已结束（自然结束或截断终止） */
  done: boolean
  /** 缓冲达到上限被截断：结果不完整 */
  truncated: boolean
  /** 检索不可用的原因（ripgrep 起不来 / 异常退出）；有值 = 这次检索根本没跑起来 */
  error: string | null
  child: ChildProcess | null
}

/**
 * 检索进程起不来时的统一文案。
 * 打包产物里 rg 起不来已踩过两次坑，这条路径当时只会返回「0 个命中项」，
 * 在 UI 上与「确实没有匹配」无法区分——所以这里必须给出可读原因：
 *   1) afterPack 剪裁误删 rg.exe（已修：无平台标识的二进制一律保留）；
 *   2) rgPath 指向 app.asar 内的虚拟路径，spawn 必 ENOENT（已修：见 utils/ripgrepPath.ts）。
 */
const RG_UNAVAILABLE = '未找到可用的 ripgrep，无法检索文件内容'

const findSessions = new Map<string, FindSession>()
let findSessionSeq = 0

/**
 * rg 全文检索参数（spec「数据来源」段）：
 * `--json` 流式事件、`-F` 固定字符串（不做正则解释）、`--max-filesize 1M`、
 * 排除依赖目录；cwd = workspace，未传 --no-ignore 故尊重 .gitignore，未传 --hidden 故跳过隐藏文件。
 *
 * **`--no-require-git` 必传**：同 `rgFileListArgs`——rg 默认只在 git 仓库内解析 `.gitignore`，
 * 非 git 工作区必须显式关掉该要求，否则 `.gitignore` 形同虚设、被忽略的文件也会被检索到。
 */
function rgFindArgs(query: string): string[] {
  const args = ['--json', '--no-messages', '-F', '--max-filesize', '1M', '--no-require-git']
  for (const dir of EXCLUDED_DIRS) args.push('-g', `!${dir}`)
  args.push('-e', query, '.')
  return args
}

function killChild(session: FindSession): void {
  const child = session.child
  session.child = null
  if (!child) return
  try {
    child.kill()
  } catch {
    // 进程可能已退出
  }
}

function truncateSession(session: FindSession): void {
  session.truncated = true
  session.done = true
  killChild(session)
}

function spawnRgFind(session: FindSession, query: string): void {
  let child: ChildProcess
  try {
    child = spawnFn(rgBinPath, rgFindArgs(query), {cwd: session.workspace, windowsHide: true})
  } catch {
    session.done = true
    session.error = RG_UNAVAILABLE
    return
  }
  session.child = child

  const ingest = (line: string): void => {
    if (!line) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    for (const m of parseRgMatchEvent(event, session.workspace)) {
      if (session.matches.length >= findMaxMatches || session.bytes >= findMaxBytes) {
        truncateSession(session)
        return
      }
      session.matches.push(m)
      session.bytes += Buffer.byteLength(m.path, 'utf8') + Buffer.byteLength(m.text, 'utf8') + 16
    }
  }

  let rest = ''
  // spawn 本身成功但二进制起不来（ENOENT / EACCES，例如打包产物缺少 rg.exe）会走这里
  child.on('error', () => {
    session.done = true
    if (session.matches.length === 0) session.error = RG_UNAVAILABLE
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    rest += chunk.toString('utf-8')
    let idx: number
    while ((idx = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, idx)
      rest = rest.slice(idx + 1)
      ingest(line)
    }
  })
  child.stderr?.on('data', () => { /* rg 非匹配行不参与解析 */ })
  child.on('close', (code) => {
    if (rest) ingest(rest)
    session.done = true
    // rg 退出码：0 = 有匹配，1 = 无匹配，2 = 出错（参数不支持 / 权限等）。
    // 未截断、也没拿到任何命中时的 2 说明这次检索没真正跑成，必须报出来而不是伪装成「无匹配」。
    if (code === 2 && session.matches.length === 0 && !session.truncated && session.error === null) {
      session.error = '检索进程异常退出，未能执行本次内容检索'
    }
  })
}

/**
 * 开启一次 Find in Files 会话（同一 workspace 的旧会话先终止并清空缓冲）。
 * 空查询不启动进程，直接给一个已结束的空会话。
 */
export function startFindInFiles(workspace: string, query: string): {sessionId: string} {
  disposeSearchSessions(workspace)
  const session: FindSession = {
    id: `fif-${++findSessionSeq}`,
    workspace,
    matches: [],
    bytes: 0,
    done: false,
    truncated: false,
    error: null,
    child: null,
  }
  findSessions.set(session.id, session)

  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) {
    session.done = true
    return {sessionId: session.id}
  }
  spawnRgFind(session, q)
  return {sessionId: session.id}
}

/** 按页取命中项（页大小由 renderer 传；offset 越界返回空页） */
export function getFindInFilesPage(sessionId: string, offset: number, limit: number): FindInFilesPage {
  const session = findSessions.get(sessionId)
  if (!session) return {matches: [], truncated: false, done: true}
  const from = Math.max(0, Math.floor(Number(offset)) || 0)
  const size = Math.max(1, Math.floor(Number(limit)) || 20)
  return {
    matches: session.matches.slice(from, from + size),
    truncated: session.truncated,
    done: session.done,
    ...(session.error ? {error: session.error} : {}),
  }
}

/** 终止会话并释放缓冲 */
export function stopFindInFiles(sessionId: string): void {
  const session = findSessions.get(sessionId)
  if (!session) return
  killChild(session)
  findSessions.delete(sessionId)
}

/** 回收某 workspace 的全部检索会话（PM 窗口关闭时调用，对齐 deleteGitRepoCache 的回收范式） */
export function disposeSearchSessions(workspace: string): void {
  const key = resolve(workspace)
  for (const [id, session] of findSessions) {
    if (resolve(session.workspace) === key) {
      killChild(session)
      findSessions.delete(id)
    }
  }
}

/** 测试用：清空全部检索会话 */
export function resetSearchSessions(): void {
  for (const session of findSessions.values()) killChild(session)
  findSessions.clear()
}
