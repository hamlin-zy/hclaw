/**
 * FileRead 工具 — 读取文件内容
 *
 * 大文件处理：
 * - 小于 10MB：内存中直接读取
 * - 大于 10MB：强制分页读取，避免内存溢出
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as fsStream from 'fs'
import * as readline from 'readline'
import type {Tool, ToolContext, ToolResult} from '../types'
import {resolveAndValidatePath} from '../utils'

const inputSchema = z.object({
  filePath: z.string().describe('要读取的文件路径（相对于工作目录或绝对路径）'),
    offset: z.coerce.number().optional().describe('起始行号（从 1 开始）'),
    limit: z.coerce.number().optional().describe('读取的最大行数'),
})

type FileReadInput = z.infer<typeof inputSchema>

// 大文件阈值：10MB
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024
// 大文件默认分页限制
const LARGE_FILE_DEFAULT_LIMIT = 2000

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
 */
async function streamReadLines(
  filePath: string,
  offset: number = 1,
  limit?: number,
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
      lines.push(`${lineNum + 1}\t${line}`)
    }
    lineNum++
  }

  rl.close()
  return {
    body: lines.join('\n'),
    summary: formatSummary(lineNum, start + 1, lines.length),
  }
}

export const fileReadTool: Tool<FileReadInput, string> = {
  name: 'file_read',
  description:
    '读取指定文件的内容。支持行范围读取（offset + limit，offset 从 1 开始）。' +
    '输出格式为 `行号<TAB>内容`，末尾附总行数摘要。',
  inputSchema,
  requiredPermissions: ['fs:read'],
  isDestructive: false,

  async execute(args: FileReadInput, context: ToolContext): Promise<ToolResult<string>> {
    const { filePath, offset = 1, limit } = args
    const { absPath, error: pathError } = resolveAndValidatePath(context.workingDir, filePath)
    if (pathError) return { success: false, output: '', error: pathError }

    
    try {
      const stat = await fs.stat(absPath)
      const isLargeFile = stat.size > LARGE_FILE_THRESHOLD

      if (isLargeFile) {
        // 大文件：强制流式分页读取
        const effectiveLimit = limit || LARGE_FILE_DEFAULT_LIMIT

        const { body, summary } = await streamReadLines(absPath, offset, effectiveLimit)
        return {
          success: true,
          output: withSummary(body, summary),
        }
      }

      // 小文件：内存处理
      const content = await fs.readFile(absPath, 'utf-8')
      const lines = content === '' ? [] : content.split('\n')
      const total = lines.length
      const start = Math.max(1, offset) - 1
      const end = limit ? start + limit : total
      const selected = lines.slice(start, end)

      // 统一输出：行号 + 内容，末尾附摘要
      const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
      return {
        success: true,
        output: withSummary(numbered, formatSummary(total, start + 1, selected.length)),
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Failed to read file: ${err.message}` }
    }
  },
}
