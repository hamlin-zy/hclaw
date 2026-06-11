/**
 * FileWrite 工具 — 创建或覆盖文件
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {Artifact, Tool, ToolContext, ToolResult} from '../types'
import {resolveAndValidatePath} from '../utils'

const inputSchema = z.object({
  filePath: z.string().describe('要写入的文件路径（相对于工作目录或绝对路径）'),
  content: z.string().describe('要写入的内容'),
  createDirs: z.boolean().optional().describe('是否自动创建目录，默认 true'),
})

type FileWriteInput = z.infer<typeof inputSchema>

export const fileWriteTool: Tool<FileWriteInput, string> = {
  name: 'file_write',
  description: '将内容写入指定文件。如果文件已存在则覆盖。',
  inputSchema,
  requiredPermissions: ['fs:write'],
  isDestructive: true,

  async execute(args: FileWriteInput, context: ToolContext): Promise<ToolResult<string>> {
    const { filePath, content, createDirs = true } = args
    const { absPath, error: pathError } = resolveAndValidatePath(context.workingDir, filePath)
    if (pathError) return { success: false, output: '', error: pathError }

    try {
      if (createDirs) {
        // 修复 P2-6: 检查 mkdir 是否成功
        try {
          await fs.mkdir(path.dirname(absPath), { recursive: true })
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException).code !== 'EEXIST') {
            return {
              success: false,
              output: '',
              error: `创建目录失败: ${mkdirErr instanceof Error ? mkdirErr.message : '未知错误'}`,
            }
          }
        }
      }

      // 检查文件是否存在以确定 action 类型
      let action: Artifact['action'] = 'created'
      try {
        await fs.access(absPath)
        action = 'modified'
      } catch { /* 文件不存在 */ }

      await fs.writeFile(absPath, content, 'utf-8')

      return {
        success: true,
        output: `File written: ${filePath} (${content.length} chars)`,
        artifacts: [{ filePath: absPath, action, content }],
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Failed to write file: ${err.message}` }
    }
  },
}
