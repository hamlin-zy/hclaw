/**
 * Glob 工具 — 文件搜索
 *
 * 支持两种模式：
 * - glob 模式：使用通配符匹配路径
 * - 正则模式：使用 regex 参数按文件名正则匹配
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {Tool, ToolContext, ToolResult} from '../types'

const inputSchema = z.object({
  pattern: z.string().optional().describe('glob 模式，例如 "**/*.ts" 匹配所有 TypeScript 文件'),
  regex: z.string().optional().describe('文件名正则表达式，例如 "test-\\d+\\.ts"'),
  directory: z.string().optional().describe('搜索的根目录，默认为工作目录'),
    maxDepth: z.coerce.number().optional().describe('最大递归深度，默认无限制'),
    maxResults: z.coerce.number().optional().describe('最大返回结果数，默认 100'),
})

type GlobInput = z.infer<typeof inputSchema>

export const globTool: Tool<GlobInput, string[]> = {
  name: 'glob',
  description: `搜索文件。支持两种模式：
1. glob 模式：pattern 参数，如 **/*.ts
2. 正则模式：regex 参数，按文件名正则匹配

必须提供 pattern 或 regex 其中之一。`,
  inputSchema,
  requiredPermissions: ['fs:read'],
  isDestructive: false,

  async execute(args: GlobInput, context: ToolContext): Promise<ToolResult<string[]>> {
      const {pattern, regex, directory, maxDepth, maxResults = 100} = args

    if (!pattern && !regex) {
      return { success: false, output: [], error: '必须提供 pattern 或 regex 参数' }
    }

    const searchDir = directory
      ? path.resolve(context.workingDir, directory)
      : context.workingDir

    try {
      let matches: string[]

      if (regex) {
        // 正则模式：递归搜索匹配文件名
          matches = await regexSearch(regex, searchDir, maxDepth, maxResults)
      } else {
        // glob 模式
          matches = await globSearch(pattern!, searchDir, maxResults)
      }

      // 返回相对路径
      const relPaths = matches.map((p) => path.relative(context.workingDir, p))
      return { success: true, output: relPaths }
    } catch (err: any) {
      return { success: false, output: [], error: `Search failed: ${err.message}` }
    }
  },
}

/** 正则模式搜索 */
async function regexSearch(
  regexPattern: string,
  rootDir: string,
  maxDepth?: number,
  maxResults?: number,
): Promise<string[]> {
  const results: string[] = []
  const regex = new RegExp(regexPattern, 'i') // 忽略大小写

  async function walk(dir: string, depth: number): Promise<void> {
      if (maxResults !== undefined && results.length >= maxResults) return
    if (maxDepth !== undefined && depth > maxDepth) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
        if (maxResults !== undefined && results.length >= maxResults) return
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(dir, entry.name)

      if (entry.isFile() && regex.test(entry.name)) {
        results.push(fullPath)
      }

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
      }
    }
  }

  await walk(rootDir, 0)
  return results.sort()
}

/** 简易 glob 实现（递归匹配） */
async function globSearch(
    pattern: string,
    rootDir: string,
    maxResults?: number,
): Promise<string[]> {
  const results: string[] = []

  // 分割 pattern：**/ 之前的前缀和之后的 glob 部分
  const parts = pattern.split('/')

  async function walk(dir: string, patternParts: string[]): Promise<void> {
      if (maxResults !== undefined && results.length >= maxResults) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }

    const [current, ...rest] = patternParts

    if (!current) return

    if (current === '**') {
      // ** 匹配零或多层目录
      // 尝试剩余 pattern 在当前目录匹配
      if (rest.length > 0) {
        await walk(dir, rest)
      }
      // 递归所有子目录
      for (const entry of entries) {
          if (maxResults !== undefined && results.length >= maxResults) return
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await walk(path.join(dir, entry.name), patternParts)
        }
      }
    } else {
      // 普通匹配
      const matcher = globToRegex(current)
      for (const entry of entries) {
          if (maxResults !== undefined && results.length >= maxResults) return
        if (!matcher.test(entry.name)) continue

        const fullPath = path.join(dir, entry.name)
        if (rest.length === 0) {
          // pattern 末尾：匹配文件/目录
          results.push(fullPath)
        } else if (entry.isDirectory()) {
          await walk(fullPath, rest)
        }
      }
    }
  }

  await walk(rootDir, parts)
  return results.sort()
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
