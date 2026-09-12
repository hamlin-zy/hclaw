/**
 * Grep 工具 — 文件内容搜索
 *
 * 优先使用 ripgrep（@vscode/ripgrep）子进程搜索，rg 不可用时回退到 JS 遍历实现。
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import {spawn} from 'child_process'
import {rgPath} from '@vscode/ripgrep'
import type {Tool, ToolContext, ToolResult} from '../types'

const inputSchema = z.object({
  pattern: z.string().describe('搜索的正则表达式或字符串'),
  directory: z.string().optional().describe('搜索的目录，默认为工作目录'),
  filePattern: z.string().optional().describe('文件名过滤，如 *.ts'),
    maxResults: z.coerce.number().optional().describe('最大返回结果数，默认 50'),
  caseInsensitive: z.boolean().optional().describe('是否忽略大小写，默认 false'),
  maxDepth: z.coerce.number().optional().describe('最大递归深度，默认无限制'),
})

type GrepInput = z.infer<typeof inputSchema>

/** 大文件跳过阈值：1MB */
const MAX_FILE_SIZE = 1024 * 1024

export const grepTool: Tool<GrepInput, string> = {
  name: 'grep',
  description: '在文件中搜索匹配的文本内容。支持正则表达式。',
  inputSchema,
  requiredPermissions: ['fs:read'],
  isDestructive: false,

  async execute(args: GrepInput, context: ToolContext): Promise<ToolResult<string>> {
    const {
      pattern,
      directory,
      filePattern,
      maxResults = 50,
      caseInsensitive = false,
      maxDepth,
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
      let output = await searchWithRipgrep(args, searchDir, context.workingDir)
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

async function searchWithRipgrep(
  args: GrepInput,
  searchDir: string,
  rootDir: string,
): Promise<string | null> {
  const { pattern, filePattern, maxResults = 50, caseInsensitive = false, maxDepth } = args

  const rgArgs: string[] = ['--json', '--no-messages', '--max-filesize', '1M', '-g', '!node_modules']
  if (caseInsensitive) rgArgs.push('-i')
  if (maxDepth !== undefined) rgArgs.push('--max-depth', String(maxDepth))
  if (filePattern) rgArgs.push('-g', filePattern)
  rgArgs.push('-e', pattern, '.')

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(rgPath, rgArgs, { cwd: searchDir, windowsHide: true })
    } catch {
      resolve(null)
      return
    }

    const results: string[] = []
    let skippedLarge = 0
    let buffer = ''
    let settled = false

    const finish = (fallback: boolean) => {
      if (settled) return
      settled = true
      if (fallback) {
        try { child.kill() } catch { /* ignore */ }
        resolve(null)
        return
      }
      if (skippedLarge > 0) results.push(`[${skippedLarge} files skipped (>1MB)]`)
      resolve(results.join('\n'))
    }

    child.on('error', () => finish(true))
    child.on('spawn-error' as any, () => finish(true))

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue

        let event: RgMatchEvent
        try {
          event = JSON.parse(line)
        } catch { continue }

        if (event.type === 'match') {
          const filePath = event.data?.path?.text
          const text = event.data?.lines?.text ?? ''
          const lineNo = event.data?.line_number ?? 0
          if (filePath && results.length < maxResults) {
            // rg 输出相对于 cwd(searchDir) 的路径，转换为相对 rootDir
            const abs = path.isAbsolute(filePath) ? filePath : path.join(searchDir, filePath)
            const rel = path.relative(rootDir, abs).replace(/\\/g, '/')
            results.push(`${rel}:${lineNo}: ${text.trimEnd()}`)
            if (results.length >= maxResults) {
              try { child.kill() } catch { /* ignore */ }
            }
          }
        }
      }
    })

    child.stderr.on('data', () => { /* ignore stderr（--no-messages 已抑制大部分） */ })

    child.on('close', (code) => {
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

  const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
  const results: string[] = []
  const fileRegex = filePattern ? globToRegex(filePattern) : undefined
  const skipCounter = { value: 0 }

  await walkAndSearch(searchDir, regex, fileRegex, results, maxResults, maxDepth, rootDir, skipCounter)

  if (results.length === 0 && skipCounter.value === 0) {
    return ''
  }
  if (skipCounter.value > 0) results.push(`[${skipCounter.value} files skipped (>1MB)]`)
  return results.join('\n')
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
      // 跳过隐藏目录和 node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      await walkAndSearch(fullPath, regex, fileRegex, results, maxResults, maxDepth, rootDir, skipCounter, depth + 1)
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

        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          // 单实例正则：g flag 匹配前重置 lastIndex
          regex.lastIndex = 0
          if (regex.test(lines[i])) {
            results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`)
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
