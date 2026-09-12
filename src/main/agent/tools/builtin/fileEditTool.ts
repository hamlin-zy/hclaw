/**
 * FileEdit 工具 — 精确替换文件中的内容
 *
 * 类似 Claude Code 的 Edit 工具：old_string → new_string
 *
 * 大文件处理：
 * - 小于 10MB：内存中直接处理
 * - 大于 10MB：流式逐行处理，避免内存溢出
 */

import {z} from 'zod'
import * as fs from 'fs/promises'
import * as fsStream from 'fs'
import * as readline from 'readline'
import * as diff from 'diff'
import type {Tool, ToolContext, ToolResult} from '../types'
import {resolveAndValidatePath} from '../utils'

const inputSchema = z.object({
  filePath: z.string().describe('要编辑的文件路径'),
  oldString: z.string().describe('要替换的原始文本'),
  newString: z.string().describe('替换后的新文本'),
  replaceAll: z.boolean().optional().describe('是否替换所有匹配项，默认 false'),
})

type FileEditInput = z.infer<typeof inputSchema>

// 大文件阈值：10MB
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024

/** 转义正则特殊字符 */
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 统一行尾符：CRLF (\r\n) → LF (\n)
 * 解决 Windows 文件与 Unix 字符串的兼容问题
 */
function normalizeLineEndings(str: string): string {
    return str.replace(/\r\n/g, '\n')
}

/** 检测字符串是否包含 CRLF 行尾 */
function detectCRLF(content: string): boolean {
    return content.includes('\r\n')
}

/** 将内容恢复为 CRLF 行尾（如原始文件是 CRLF 格式） */
function toCRLF(content: string, useCRLF: boolean): string {
    return useCRLF ? content.replace(/\n/g, '\r\n') : content
}

// ---------------------------------------------------------------------------
// Diff 窗口化：避免对大文件全文做 Myers diff
// ---------------------------------------------------------------------------

/** diff 窗口：替换点前后各取多少行上下文 */
const DIFF_WINDOW_LINES = 200
/** 超过该大小的文件直接输出简化描述，不做 diff */
const DIFF_MAX_CONTENT_LENGTH = 500 * 1024

/** 从 idx 向前找第 n 个换行之前的行首偏移 */
function lineStartBefore(s: string, idx: number, n: number): number {
    let i = idx
    for (let k = 0; k < n && i > 0; k++) {
        const prev = s.lastIndexOf('\n', i - 1)
        if (prev === -1) return 0
        i = prev
    }
    return i === 0 ? 0 : i + 1
}

/** 从 idx 向后跨 n 个换行的偏移 */
function lineEndAfter(s: string, idx: number, n: number): number {
    let i = idx
    for (let k = 0; k < n; k++) {
        const next = s.indexOf('\n', i)
        if (next === -1) return s.length
        i = next + 1
    }
    return i
}

/**
 * 窗口化 patch：仅对替换点前后各 ~200 行做 diff，
 * hunk 头行号加上窗口前置偏移，保证与全文 patch 行号一致。
 * 文件超过 DIFF_MAX_CONTENT_LENGTH 时输出简化描述。
 */
function createWindowedPatch(oldContent: string, newContent: string, oldString: string): string {
    const matchStart = oldContent.indexOf(oldString)
    if (matchStart === -1) return ''

    if (oldContent.length > DIFF_MAX_CONTENT_LENGTH) {
        const line = oldContent.slice(0, matchStart).split('\n').length
        return `replaced ${oldString.length} chars at line ${line}`
    }

    const lastMatch = oldContent.lastIndexOf(oldString)
    const matchEnd = lastMatch + oldString.length
    // 前缀（matchStart 之前）与后缀（matchEnd 之后）内容未变，可据此推算新内容中的对应位置
    const newMatchEnd = newContent.length - (oldContent.length - matchEnd)

    const wStart = lineStartBefore(oldContent, matchStart, DIFF_WINDOW_LINES)
    const oldWinEnd = Math.min(oldContent.length, lineEndAfter(oldContent, matchEnd, DIFF_WINDOW_LINES))
    const newWinEnd = Math.min(newContent.length, lineEndAfter(newContent, newMatchEnd, DIFF_WINDOW_LINES))

    const oldWin = oldContent.slice(wStart, oldWinEnd)
    const newWin = newContent.slice(wStart, newWinEnd)

    const lineOffset = wStart === 0 ? 0 : oldContent.slice(0, wStart).split('\n').length - 1
    let patch = diff.createPatch('file', oldWin, newWin)
    if (lineOffset > 0) {
        patch = patch.replace(
            /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
            (_m, a, b, c, d) =>
                `@@ -${Number(a) + lineOffset}${b !== undefined ? ',' + b : ''} +${Number(c) + lineOffset}${d !== undefined ? ',' + d : ''} @@`,
        )
    }
    return patch
}

/**
 * 流式处理大文件替换
 * 逐行读取，避免内存溢出
 * 跨行 oldString 会回退到全文件读取
 */
async function streamEditLargeFile(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<{ replaced: number; error?: string }> {
  const tempPath = filePath + '.tmp.' + Date.now()

    if (oldString.includes('\n')) {
                try {
            const content = await fs.readFile(filePath, 'utf-8')
            // 统一行尾符：文件可能是 CRLF，oldString 可能是 LF
            const normalizedContent = normalizeLineEndings(content)
            const normalizedOldString = normalizeLineEndings(oldString)
            const matchCount = normalizedContent.split(normalizedOldString).length - 1

            if (matchCount === 0) {
                return {replaced: 0, error: 'No matching text found'}
            }
            if (matchCount > 1 && !replaceAll) {
                return {
                    replaced: 0,
                    error: `Found ${matchCount} matches, use more specific text or set replaceAll: true`,
                }
            }

            // 替换时需要基于原始内容，但使用规范化的 oldString 进行 split
            // 注意：如果文件是 CRLF，替换后仍保持 CRLF（因为 newString 可能也用 LF）
            const newContent = replaceAll
                ? normalizedContent.split(normalizedOldString).join(normalizeLineEndings(newString))
                : normalizedContent.replace(normalizedOldString, normalizeLineEndings(newString))

                    // 恢复原始行尾风格：Windows CRLF 文件不应被静默转为 LF
                    const finalContent = toCRLF(newContent, detectCRLF(content))

                    await fs.writeFile(tempPath, finalContent, 'utf-8')
            await fs.rename(tempPath, filePath)

            return {replaced: replaceAll ? matchCount : 1}
        } catch (err: any) {
            try {
                await fs.unlink(tempPath)
            } catch { /* ignore */
            }
            return {replaced: 0, error: err.message}
        }
    }

    // 单行 oldString：使用流式处理
  try {
    const input = fsStream.createReadStream(filePath, { encoding: 'utf8' })
    const output = fsStream.createWriteStream(tempPath, { encoding: 'utf8' })

    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
    })

      // 规范化 oldString（去掉可能的尾部 \r）
      const normalizedOldString = normalizeLineEndings(oldString)
      const normalizedNewString = normalizeLineEndings(newString)

      // 检测原始文件换行风格，保持 CRLF 不丢失
      const sampleBuffer = Buffer.alloc(4096)
      const detectFd = fsStream.openSync(filePath, 'r')
      const bytesRead = fsStream.readSync(detectFd, sampleBuffer, 0, 4096, 0)
      fsStream.closeSync(detectFd)
      const lineEnding = detectCRLF(sampleBuffer.toString('utf-8', 0, bytesRead)) ? '\r\n' : '\n'

    let replaced = 0

    for await (const line of rl) {
      if (replaceAll) {
          const newLine = line.split(normalizedOldString).join(normalizedNewString)
        if (newLine !== line) replaced++
          output.write(newLine + lineEnding)
      } else if (replaced === 0 && line.includes(normalizedOldString)) {
        // 只替换第一个匹配
          output.write(line.replace(normalizedOldString, normalizedNewString) + lineEnding)
        replaced++
      } else {
          output.write(line + lineEnding)
      }
    }

    rl.close()
    output.end()

    // 等待写入完成
    await new Promise<void>((resolve, reject) => {
      output.on('finish', resolve)
      output.on('error', reject)
    })

    // 原子替换
    await fs.rename(tempPath, filePath)

    return { replaced }
  } catch (err: any) {
    // 清理临时文件
    try {
      await fs.unlink(tempPath)
    } catch { /* ignore */ }
    return { replaced: 0, error: err.message }
  }
}

export const fileEditTool: Tool<FileEditInput, string> = {
  name: 'file_edit',
  description: `精确替换文件中的文本片段。oldString 必须在文件中唯一匹配（除非设置 replaceAll）。

【使用规范】执行前必须：
1. 先用 grep 确认 oldString 存在且唯一
2. 用 file_read 查看真实空白符（tab vs 空格）和行尾符（CRLF vs LF）
3. 包含周围上下文作为锚点，提升匹配成功率
4. 确认文件未被其他操作修改

【失败排查清单】
- 空白符不匹配（70%+ 失败原因）：oldString 和文件实际缩进不一致
- CRLF/LF 差异：Windows 文件使用 \\r\\n，oldString 使用 \\n
- 文件已被修改：重新读取确认当前内容
- 内容不够独特：增加上下文锚点（周围 1-2 行代码）

【禁用行为】
- 禁止凭记忆写 oldString，必须先读取确认
- 禁止连续失败 3 次以上不切换方案
- 禁止用极短文本（如单个变量名）作为 oldString`,
  inputSchema,
  requiredPermissions: ['fs:write'],
  isDestructive: true,

  async execute(args: FileEditInput, context: ToolContext): Promise<ToolResult<string>> {
    const { filePath, oldString, newString, replaceAll = false } = args
    const { absPath, error: pathError } = resolveAndValidatePath(context.workingDir, filePath)
    if (pathError) return { success: false, output: '', error: pathError }

    try {
      // 检查文件大小
      const stat = await fs.stat(absPath)
      const isLargeFile = stat.size > LARGE_FILE_THRESHOLD

      if (isLargeFile) {
        // 大文件：流式处理
        const result = await streamEditLargeFile(absPath, oldString, newString, replaceAll)

        if (result.error) {
          return { success: false, output: '', error: result.error }
        }
        if (result.replaced === 0) {
          return { success: false, output: '', error: `No matching text found` }
        }

        return {
          success: true,
          output: `Replaced ${result.replaced} match(es) (stream mode)`,
          artifacts: [{ filePath: absPath, action: 'modified' }],
        }
      }

      // 小文件：内存处理
      const rawBuffer = await fs.readFile(absPath)

      // Buffer 头部 4KB 探测行尾风格（复用流式分支思路）
      // LF-only 文件可跳过全文 normalizeLineEndings/toCRLF 及 diff 前后的全文 replace
      const hasCRLF = rawBuffer.subarray(0, 4096).includes('\r\n', 'latin1')
      const content = rawBuffer.toString('utf-8')

      const normalizedContent = hasCRLF ? normalizeLineEndings(content) : content
      const normalizedOldString = normalizeLineEndings(oldString)
      const normalizedNewString = normalizeLineEndings(newString)

      // 单次遍历完成匹配检查和替换
      let matchCount = 0
      const newContent = normalizedContent.replace(new RegExp(escapeRegExp(normalizedOldString), replaceAll ? 'g' : ''), () => {
        matchCount++
        return normalizedNewString
      })

      if (matchCount === 0) {
        return { success: false, output: '', error: `No matching text found` }
      }
      if (matchCount > 1 && !replaceAll) {
        return {
          success: false,
          output: '',
          error: `Found ${matchCount} matches, use more specific text or set replaceAll: true`,
        }
      }

      // 恢复原始行尾风格：保持 CRLF 文件不被静默转为 LF（LF-only 文件跳过全文 replace）
      const finalContent = hasCRLF ? toCRLF(newContent, true) : newContent

      // 生成 Diff（基于原始内容比较，diff 统一用 LF 对比；LF-only 文件免全文 replace）
      const oldForDiff = hasCRLF ? content.replace(/\r\n/g, '\n') : content
      const newForDiff = hasCRLF ? finalContent.replace(/\r\n/g, '\n') : finalContent
      const patch = createWindowedPatch(oldForDiff, newForDiff, normalizedOldString)

      // 简化输出：省略文件头（Index/===/---/+++），从第一个 hunk 头 @@ 开始
      // 文件路径已由 file_edit 参数区展示；indexOf('\n@@')+1 精确指向首个 hunk
      // （首个 hunk 前必有换行；找不到时返回 -1+1=0，slice(0) 天然回退为完整 patch）
      const simplifiedPatch = patch.slice(patch.indexOf('\n@@') + 1)

      await fs.writeFile(absPath, finalContent, 'utf-8')

      return {
        success: true,
        output: `Replaced ${replaceAll ? matchCount : 1} match(es)`,
        diff: simplifiedPatch, // 返回补丁数据（已简化，省略文件头）
        artifacts: [{ filePath: absPath, action: 'modified' }],
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Failed to edit file: ${err.message}` }
    }
  },
}
