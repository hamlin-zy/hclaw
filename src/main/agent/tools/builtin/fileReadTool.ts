/**
 * FileRead 工具 — 读取文件内容
 *
 * 大文件处理：
 * - 小于 10MB：内存中直接读取
 * - 大于 10MB：强制分页读取，避免内存溢出
 *
 * 能力：
 * - offset/limit 行范围（offset 从 1 开始）
 * - raw=true：纯文本输出（无行号、无摘要），便于直接作为 file_edit 的 oldString
 * - filePaths：一次读多个文件（最多 10 个），每个文件独立应用 offset/limit
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as fsStream from 'fs'
import * as readline from 'readline'
import type {Tool, ToolContext, ToolResult} from '../types'
import {resolveAndValidatePath} from '../utils'

const inputSchema = z.object({
  filePath: z.string().optional().describe('要读取的文件路径（相对于工作目录或绝对路径）；与 filePaths 二选一'),
    offset: z.coerce.number().optional().describe('起始行号（从 1 开始）'),
    limit: z.coerce.number().optional().describe('读取的最大行数'),
    raw: z.boolean().optional().describe('纯文本输出（不加行号与摘要），默认 false；需要直接复制内容作为 file_edit 的 oldString 时用 true'),
    filePaths: z.array(z.string()).optional().describe('一次读取多个文件（最多 10 个，每个文件独立应用 offset/limit）；与 filePath 二选一'),
})

type FileReadInput = z.infer<typeof inputSchema>

// 大文件阈值：10MB
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024
// 大文件默认分页限制
const LARGE_FILE_DEFAULT_LIMIT = 2000
// 多文件读取上限（防上下文爆炸）
const MAX_MULTI_FILES = 10
// 目录路径的友好提示（避免模型看到 EISDIR 后自己猜）
const DIRECTORY_ERROR = '路径是目录。列出目录内容请用 glob（pattern: "**/*"），不要用 bash Get-ChildItem。'

/**
 * 构造末尾摘要行
 * - 有内容：`(共 {total} 行，已显示全部)` 或 `(共 {total} 行，已显示 {start}-{end})`
 * - 无内容：`(empty range)`
 */
function formatSummary(total: number, startLine: number, shown: number): string {
  if (shown === 0) return '(empty range)'
  const range =
    startLine === 1 && shown === total
      ? '已显示全部'
      : `已显示 ${startLine}-${startLine + shown - 1}`
  return `(共 ${total} 行，${range})`
}

/** 正文与摘要拼接（正文为空时只输出摘要） */
function withSummary(body: string, summary: string): string {
  return body ? `${body}\n${summary}` : summary
}

/**
 * 流式读取大文件指定行范围
 *
 * 返回正文（行号\t内容，换行分隔）与末尾摘要；为统计总行数需扫完整个文件，
 * 但只保留范围内的行，内存占用与 limit 相关。
 * raw=true 时正文不加行号（摘要仍计算，由调用方决定是否拼接）。
 */
async function streamReadLines(
  filePath: string,
  offset: number = 1,
  limit?: number,
  raw: boolean = false,
): Promise<{ body: string; summary: string }> {
  const input = fsStream.createReadStream(filePath, { encoding: 'utf8' })

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  })

  const start = Math.max(1, offset) - 1
  const end = limit ? start + limit : Number.MAX_SAFE_INTEGER
  const lines: string[] = []
  let lineNum = 0

  for await (const line of rl) {
    if (lineNum >= start && lineNum < end) {
      lines.push(raw ? line : `${lineNum + 1}\t${line}`)
    }
    lineNum++
  }

  rl.close()
  return {
    body: lines.join('\n'),
    summary: formatSummary(lineNum, start + 1, lines.length),
  }
}

/**
 * 读取单个文件（含目录检测、大文件分流、raw 分支）
 *
 * 返回 output 或 error；错误不抛出，由调用方决定单文件还是多文件下的呈现方式。
 */
async function readOneFile(
  workingDir: string,
  inputPath: string,
  offset: number,
  limit: number | undefined,
  raw: boolean,
): Promise<{ output: string; error?: string }> {
  const { absPath, error: pathError } = resolveAndValidatePath(workingDir, inputPath)
  if (pathError) return { output: '', error: pathError }

  try {
    const stat = await fs.stat(absPath)
    if (stat.isDirectory()) return { output: '', error: DIRECTORY_ERROR }

    const isLargeFile = stat.size > LARGE_FILE_THRESHOLD

    if (isLargeFile) {
      // 大文件：强制流式分页读取
      const effectiveLimit = limit || LARGE_FILE_DEFAULT_LIMIT

      const { body, summary } = await streamReadLines(absPath, offset, effectiveLimit, raw)
      return { output: raw ? body : withSummary(body, summary) }
    }

    // 小文件：内存处理
    const content = await fs.readFile(absPath, 'utf-8')
    const lines = content === '' ? [] : content.split('\n')
    const total = lines.length
    const start = Math.max(1, offset) - 1
    const end = limit ? start + limit : total
    const selected = lines.slice(start, end)

    if (raw) return { output: selected.join('\n') }

    // 统一输出：行号 + 内容，末尾附摘要
    const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
    return { output: withSummary(numbered, formatSummary(total, start + 1, selected.length)) }
  } catch (err: any) {
    return { output: '', error: `Failed to read file: ${err.message}` }
  }
}

export const fileReadTool: Tool<FileReadInput, string> = {
  name: 'file_read',
  description:
    '读取指定文件的内容。支持行范围读取（offset + limit，offset 从 1 开始）；' +
    'raw=true 输出纯文本（无行号/摘要），需要直接复制内容作为 file_edit 的 oldString 时用；' +
    'filePaths 可一次读多个文件。输出默认格式为 行号<TAB>内容，末尾附总行数摘要。' +
    '超过 10MB 的文件默认只返回前 2000 行，需用 offset 分页。' +
    '读文件优先用它；需要按内容筛选时用 grep，列目录用 glob。',
  inputSchema,
  requiredPermissions: ['fs:read'],
  isDestructive: false,

  async execute(args: FileReadInput, context: ToolContext): Promise<ToolResult<string>> {
    const { filePath, filePaths, offset = 1, limit, raw = false } = args

    const hasSingle = typeof filePath === 'string' && filePath.length > 0
    const hasMulti = Array.isArray(filePaths) && filePaths.length > 0

    if (hasSingle && hasMulti) {
      return { success: false, output: '', error: 'filePath 与 filePaths 只能提供其一' }
    }
    if (!hasSingle && !hasMulti) {
      return { success: false, output: '', error: '必须提供 filePath 或 filePaths' }
    }

    if (hasMulti) {
      if (filePaths!.length > MAX_MULTI_FILES) {
        return { success: false, output: '', error: 'filePaths 最多 10 个文件' }
      }

      const blocks: string[] = []
      for (const p of filePaths!) {
        const result = await readOneFile(context.workingDir, p, offset, limit, raw)
        if (result.error) {
          return { success: false, output: '', error: `${p}: ${result.error}` }
        }
        blocks.push(`=== ${p} ===\n${result.output}`)
      }
      return { success: true, output: blocks.join('\n') }
    }

    const result = await readOneFile(context.workingDir, filePath!, offset, limit, raw)
    if (result.error) return { success: false, output: '', error: result.error }
    return { success: true, output: result.output }
  },
}
