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
 * 流式读取大文件指定行范围
 */
async function streamReadLines(
  filePath: string,
  offset: number = 1,
  limit: number,
): Promise<string> {
  const input = fsStream.createReadStream(filePath, { encoding: 'utf8' })

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  })

  const start = Math.max(1, offset) - 1
  const end = start + limit
  const lines: string[] = []
  let lineNum = 0

  for await (const line of rl) {
    if (lineNum >= start && lineNum < end) {
      lines.push(`${lineNum + 1}\t${line}`)
    }
    lineNum++
    if (lineNum >= end) break
  }

  rl.close()
  return lines.join('\n')
}

export const fileReadTool: Tool<FileReadInput, string> = {
  name: 'file_read',
  description: '读取指定文件的内容。支持行范围读取（offset + limit）。',
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
        
        const output = await streamReadLines(absPath, offset, effectiveLimit)
        return {
          success: true,
          output: output || '(empty range)',
        }
      }

      // 小文件：内存处理
      const content = await fs.readFile(absPath, 'utf-8')

      if (offset > 1 || limit) {
        const lines = content.split('\n')
        const start = (offset || 1) - 1
        const end = limit ? start + limit : lines.length
        const selected = lines.slice(start, end)

        // 添加行号
        const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
        return { success: true, output: numbered }
      }

      return { success: true, output: content }
    } catch (err: any) {
      return { success: false, output: '', error: `Failed to read file: ${err.message}` }
    }
  },
}
