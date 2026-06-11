/**
 * Grep 工具 — 文件内容搜索
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {Tool, ToolContext, ToolResult} from '../types'

const inputSchema = z.object({
  pattern: z.string().describe('搜索的正则表达式或字符串'),
  directory: z.string().optional().describe('搜索的目录，默认为工作目录'),
  filePattern: z.string().optional().describe('文件名过滤，如 *.ts'),
    maxResults: z.coerce.number().optional().describe('最大返回结果数，默认 50'),
  caseInsensitive: z.boolean().optional().describe('是否忽略大小写，默认 false'),
})

type GrepInput = z.infer<typeof inputSchema>

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
    } = args

    const searchDir = directory
      ? path.resolve(context.workingDir, directory)
      : context.workingDir

    try {
      const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
      const results: string[] = []
      const fileRegex = filePattern ? globToRegex(filePattern) : null

      await walkAndSearch(searchDir, regex, fileRegex, results, maxResults, context.workingDir)

      if (results.length === 0) {
        return { success: true, output: 'No matching results found' }
      }

      return { success: true, output: results.join('\n') }
    } catch (err: any) {
      return { success: false, output: '', error: `Search failed: ${err.message}` }
    }
  },
}

async function walkAndSearch(
  dir: string,
  regex: RegExp,
  fileRegex: RegExp | null,
  results: string[],
  maxResults: number,
  rootDir: string,
): Promise<void> {
  if (results.length >= maxResults) return

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
      await walkAndSearch(fullPath, regex, fileRegex, results, maxResults, rootDir)
    } else {
      // 文件名过滤
      if (fileRegex && !fileRegex.test(entry.name)) continue

      // 跳过二进制文件
      if (isBinaryFilename(entry.name)) continue

      try {
        const content = await fs.readFile(fullPath, 'utf-8')
        const lines = content.split('\n')
        const relPath = path.relative(rootDir, fullPath)

        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          // 重新创建 regex（因为 g flag 有 lastIndex 问题）
          const testRegex = new RegExp(regex.source, regex.flags)
          if (testRegex.test(lines[i])) {
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

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
