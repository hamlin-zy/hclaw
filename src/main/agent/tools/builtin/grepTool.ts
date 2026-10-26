/**
 * Grep 工具 — 文件内容搜索
 *
 * 优先使用 ripgrep（@vscode/ripgrep）子进程搜索，rg 不可用时回退到 JS 遍历实现。
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import {spawn} from 'child_process'
import {StringDecoder} from 'string_decoder'
// 打包后 rgPath 指向 app.asar 内的虚拟路径，spawn 必 ENOENT；此处取改写后的真实路径
import {rgBinPath} from '../../../utils/ripgrepPath'
import type {Tool, ToolContext, ToolResult} from '../types'

const inputSchema = z.object({
  pattern: z.string().describe('搜索的正则表达式或字符串'),
  directory: z.string().optional().describe('搜索的目录，默认为工作目录'),
  filePattern: z.string().optional().describe('文件名过滤，如 *.ts'),
    maxResults: z.coerce.number().optional().describe('最大返回结果数，默认 50'),
  caseInsensitive: z.boolean().optional().describe('是否忽略大小写，默认 false'),
  includeIgnored: z.boolean().optional().describe('是否搜索被 .gitignore 忽略的文件与隐藏目录，默认 false'),
  maxDepth: z.coerce.number().optional().describe('最大递归深度，默认无限制'),
  context: z.coerce.number().optional().describe('匹配行前后各显示 N 行，默认 0'),
  outputMode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('输出模式，默认 content'),
})

type GrepInput = z.infer<typeof inputSchema>

/** 大文件跳过阈值：1MB */
const MAX_FILE_SIZE = 1024 * 1024

export const grepTool: Tool<GrepInput, string> = {
  name: 'grep',
  description: '在文件中搜索匹配的文本内容。支持正则表达式。默认跳过被 .gitignore 忽略的文件与隐藏目录；需要在其中搜索时传 includeIgnored: true（会包含 .env、密钥配置等被忽略文件，谨慎开启）。',
  inputSchema,
  requiredPermissions: ['fs:read'],
  isDestructive: false,

  async execute(args: GrepInput, context: ToolContext): Promise<ToolResult<string>> {
    const {
      pattern,
      directory,
      caseInsensitive = false,
    } = args

    const searchDir = directory
      ? path.resolve(context.workingDir, directory)
      : context.workingDir

    // 预校验正则（非法正则统一报 Search failed）
    try {
      new RegExp(pattern, caseInsensitive ? 'i' : '')
    } catch (err: any) {
      return { success: false, output: '', error: `Search failed: ${err.message}` }
    }

    try {
      let output = await searchWithRipgrep(args, searchDir, context.workingDir, context.abortSignal)
      if (output === null) {
        // rg 不可用：回退到 JS 遍历实现
        output = await searchWithJs(args, searchDir, context.workingDir)
      }

      if (output.length === 0) {
        return { success: true, output: 'No matching results found' }
      }
      return { success: true, output }
    } catch (err: any) {
      return { success: false, output: '', error: `Search failed: ${err.message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// ripgrep 子进程路径
// ---------------------------------------------------------------------------

interface RgMatchEvent {
  type: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
  }
}

/** rg 输出的路径（相对 searchDir）→ 相对 rootDir 的正斜杠路径 */
function toRootRelative(rawPath: string, searchDir: string, rootDir: string): string {
  const cleaned = rawPath.replace(/^\.\//, '').replace(/^\.\\/, '')
  const abs = path.isAbsolute(cleaned) ? cleaned : path.join(searchDir, cleaned)
  return path.relative(rootDir, abs).replace(/\\/g, '/')
}

/**
 * 按文件路径稳定排序输出行。
 *
 * rg 多线程搜索时事件到达顺序不稳定，同一文件的行可能被其它文件交错，
 * 导致同一查询两次输出不一致（JS 回退路径同样受 readdir 顺序影响）。
 * 排序后：文件按路径升序、同文件内保持原有行序（行号顺序），尾部提示行恒排最后。
 */
function orderLines(lines: string[], outputMode: NonNullable<GrepInput['outputMode']>): string[] {
  const keyOf = (line: string): string => {
    if (line.startsWith('[')) return '\uffff'
    if (outputMode === 'files_with_matches') return line
    // content: `path:行号: 内容`；context: `path-行号- 内容`
    const matched = /^(.*?):\d+: /.exec(line) ?? /^(.*?)-\d+- /.exec(line)
    if (matched) return matched[1]
    const sep = line.lastIndexOf(':') // count: `path:命中数`
    return sep > 0 ? line.slice(0, sep) : line
  }
  return lines
    .map((text, index) => ({text, key: keyOf(text), index}))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.text)
}

async function searchWithRipgrep(
  args: GrepInput,
  searchDir: string,
  rootDir: string,
  abortSignal?: AbortSignal | null,
): Promise<string | null> {
  const { pattern, filePattern, maxResults = 50, caseInsensitive = false, maxDepth, includeIgnored } = args
  const outputMode = args.outputMode ?? 'content'
  // context 仅对 content 模式有意义：-l / -c 与 -C 组合会互相干扰
  const contextLines = outputMode === 'content' && typeof args.context === 'number' && args.context > 0
    ? args.context
    : 0

  const rgArgs: string[] = ['--json', '--no-messages', '--max-filesize', '1M', '-g', '!node_modules']
  if (caseInsensitive) rgArgs.push('-i')
  if (maxDepth !== undefined) rgArgs.push('--max-depth', String(maxDepth))
  if (filePattern) rgArgs.push('-g', filePattern)
  // includeIgnored 开启时才放开忽略规则：--no-ignore 让 rg 不再读 .gitignore，--hidden 让它进入隐藏目录。
  // .git 必须始终排除——其内部是版本库对象/引用（松散对象为压缩二进制），搜之既无意义又极慢；
  // 同理 node_modules 由上方恒定的 -g '!node_modules' 兜底，因为 --no-ignore 后 .gitignore 不再拦它。
  if (includeIgnored === true) rgArgs.push('--no-ignore', '--hidden', '-g', '!.git')
  if (contextLines > 0) rgArgs.push('-C', String(contextLines))
  // 注：rg 在 -l / -c 下忽略 --json，改输出纯文本行（路径 / 路径:计数），下方按模式分别解析。
  if (outputMode === 'files_with_matches') rgArgs.push('-l')
  else if (outputMode === 'count') rgArgs.push('-c')
  rgArgs.push('-e', pattern, '.')

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(rgBinPath, rgArgs, { cwd: searchDir, windowsHide: true })
    } catch {
      resolve(null)
      return
    }

    const results: string[] = []
    let skippedLarge = 0
    let matchCount = 0
    let buffer = ''
    let settled = false

    const killChild = () => {
      try { child.kill() } catch { /* ignore */ }
    }

    // 统一收尾：移除 abort 监听（正常 / 异常 / 取消均经此）
    const cleanup = () => {
      if (abortSignal) abortSignal.removeEventListener('abort', killChild)
    }

    const finish = (fallback: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      if (fallback) {
        killChild()
        resolve(null)
        return
      }
      if (skippedLarge > 0) results.push(`[${skippedLarge} files skipped (>1MB)]`)
      resolve(orderLines(results, outputMode).join('\n'))
    }

    child.on('error', () => finish(true))

    // 取消信号：用户中止 / worker 终止时回收子进程，避免 rg 在后台继续扫描占用资源。
    // 注：不在此处自设超时——工具超时由 executor 的 withToolTimeout 统一裁定（DB 可配，
    // 超时返回 ToolTimeoutError）；内设定时器会与之竞态并把超时降级为「部分结果成功」。
    if (abortSignal) {
      if (abortSignal.aborted) {
        killChild()
      } else {
        abortSignal.addEventListener('abort', killChild, {once: true})
      }
    }

    // chunk 边界可能落在多字节字符中间，逐 chunk toString 会产生 U+FFFD
    const decoder = new StringDecoder('utf8')
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue

        // -l / -c 下 rg 输出纯文本行（--json 被忽略）：路径，或 路径:计数
        if (outputMode !== 'content') {
          const plain = line.trimEnd() // Windows 下纯文本行带 CRLF
          if (!plain) continue
          if (results.length >= maxResults) continue
          if (outputMode === 'files_with_matches') {
            const rel = toRootRelative(plain, searchDir, rootDir)
            if (rel) results.push(rel)
          } else {
            const sep = plain.lastIndexOf(':')
            const countText = sep > 0 ? plain.slice(sep + 1) : ''
            if (sep > 0 && /^\d+$/.test(countText)) {
              const rel = toRootRelative(plain.slice(0, sep), searchDir, rootDir)
              if (rel) results.push(`${rel}:${countText}`)
            }
          }
          if (results.length >= maxResults) killChild()
          continue
        }

        let event: RgMatchEvent
        try {
          event = JSON.parse(line)
        } catch { continue }

        if (event.type === 'match' || event.type === 'context') {
          const filePath = event.data?.path?.text
          const text = event.data?.lines?.text ?? ''
          const lineNo = event.data?.line_number ?? 0
          if (!filePath) continue
          // rg 输出相对于 cwd(searchDir) 的路径，转换为相对 rootDir
          const rel = toRootRelative(filePath, searchDir, rootDir)

          if (event.type === 'match') {
            if (matchCount >= maxResults) continue
            matchCount++
            results.push(`${rel}:${lineNo}: ${text.trimEnd()}`)
            if (matchCount >= maxResults) {
              killChild()
            }
          } else {
            // 上下文行沿用 grep 约定分隔符 `-`，与匹配行 `:` 区分，便于阅读文件分组
            if (matchCount >= maxResults) continue
            results.push(`${rel}-${lineNo}- ${text.trimEnd()}`)
          }
        }
      }
    })

    child.stderr.on('data', () => { /* ignore stderr（--no-messages 已抑制大部分） */ })

    child.on('close', (code) => {
      // flush 解码器残留的半个多字节字符
      buffer += decoder.end()
      // rg 退出码：0=有匹配，1=无匹配，2=错误
      if (code !== null && code > 1 && results.length === 0) {
        finish(true)
        return
      }
      finish(false)
    })
  })
}

// ---------------------------------------------------------------------------
// JS 遍历回退路径
// ---------------------------------------------------------------------------

export async function searchWithJs(
  args: GrepInput,
  searchDir: string,
  rootDir: string,
): Promise<string> {
  const { pattern, filePattern, maxResults = 50, caseInsensitive = false, maxDepth } = args
  const outputMode = args.outputMode ?? 'content'

  const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
  const results: string[] = []
  const fileRegex = filePattern ? globToRegex(filePattern) : undefined
  const skipCounter = { value: 0 }

  // context 在 JS 回退路径首版忽略（保持现有逐行输出行为）
  await walkAndSearch(searchDir, regex, fileRegex, results, maxResults, maxDepth, rootDir, skipCounter, args.includeIgnored === true, outputMode)

  if (results.length === 0 && skipCounter.value === 0) {
    return ''
  }
  if (skipCounter.value > 0) results.push(`[${skipCounter.value} files skipped (>1MB)]`)
  return orderLines(results, outputMode).join('\n')
}

async function walkAndSearch(
  dir: string,
  regex: RegExp,
  fileRegex: RegExp | undefined,
  results: string[],
  maxResults: number,
  maxDepth: number | undefined,
  rootDir: string,
  skipCounter: { value: number },
  includeIgnored: boolean,
  outputMode: 'content' | 'files_with_matches' | 'count' = 'content',
  depth = 0,
): Promise<void> {
  if (results.length >= maxResults) return
  if (maxDepth !== undefined && depth > maxDepth) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch { return }

  for (const entry of entries) {
    if (results.length >= maxResults) return
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // node_modules 与 .git 始终跳过：前者是体积巨大的依赖树（非用户代码），
      // 后者是版本库内部数据（对象/引用，多为二进制），即使 includeIgnored 也不应进入。
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      // 隐藏目录（. 开头）仅在未开启 includeIgnored 时跳过，开启后纳入搜索
      if (!includeIgnored && entry.name.startsWith('.')) continue
      await walkAndSearch(fullPath, regex, fileRegex, results, maxResults, maxDepth, rootDir, skipCounter, includeIgnored, outputMode, depth + 1)
    } else {
      // 文件名过滤
      if (fileRegex && !fileRegex.test(entry.name)) continue

      // 跳过二进制文件名
      if (isBinaryFilename(entry.name)) continue

      try {
        // 大文件防护：>1MB 跳过
        const stat = await fs.stat(fullPath)
        if (stat.size > MAX_FILE_SIZE) {
          skipCounter.value++
          continue
        }

        const content = await fs.readFile(fullPath, 'utf-8')

        // 内容级二进制嗅探：含 NUL 或高比例不可打印字符则跳过
        if (isBinaryContent(content)) continue

        const lines = content.split('\n')
        const relPath = path.relative(rootDir, fullPath)

        if (outputMode === 'content') {
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            // 单实例正则：g flag 匹配前重置 lastIndex
            regex.lastIndex = 0
            if (regex.test(lines[i])) {
              results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`)
            }
          }
        } else {
          // 文件级模式：逐文件统计命中，结果按文件聚合（新路径统一正斜杠）
          let count = 0
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0
            if (regex.test(lines[i])) count++
          }
          if (count > 0) {
            const rel = relPath.replace(/\\/g, '/')
            results.push(outputMode === 'count' ? `${rel}:${count}` : rel)
          }
        }
      } catch { /* 跳过无法读取的文件 */ }
    }
  }
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.sqlite', '.db',
])

function isBinaryFilename(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * 内容级二进制嗅探：
 * - 含 NUL 字节判定为二进制
 * - 不可打印字符（控制字符，排除 \t\r\n）占比 > 10% 判定为二进制
 */
export function isBinaryContent(content: string, sampleSize = 8000): boolean {
  const sample = content.slice(0, sampleSize)
  if (sample.includes('\u0000')) return true

  let nonPrintable = 0
  const limit = Math.min(sample.length, 8000)
  for (let i = 0; i < limit; i++) {
    const code = sample.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++
  }
  return limit > 0 && nonPrintable / limit > 0.1
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
