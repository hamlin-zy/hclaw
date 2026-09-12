/**
 * fileEditTool 性能路径补充测试
 *
 - LF-only 文件编辑后保持 LF（跳过 CRLF 规范化路径）
 - 窗口化 diff：替换点位于长文件中部时 hunk 行号仍为绝对行号
 - 超大文件（>500KB）diff 输出简化描述
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {fileEditTool} from '@/main/agent/tools/builtin/fileEditTool'

describe('fileEditTool — LF 保持与 diff 窗口化', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-perf-'))
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, {recursive: true, force: true})
  })

  function makeContext() {
    return {
      workingDir: tmpRoot,
      abortSignal: new AbortController().signal,
      sendMessage: vi.fn(),
    }
  }

  it('LF-only 文件编辑后内容保持 LF，不含 \\r', async () => {
    const filePath = path.join(tmpRoot, 'lf.txt')
    await fs.writeFile(filePath, 'line1\nline2\nline3\n')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line-two'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nline-two\nline3\n')
    expect(content).not.toContain('\r')
  })

  it('CRLF 文件编辑后保持 CRLF（现有行为不变）', async () => {
    const filePath = path.join(tmpRoot, 'crlf.txt')
    await fs.writeFile(filePath, 'line1\r\nline2\r\nline3\r\n')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line-two'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\r\nline-two\r\nline3\r\n')
  })

  it('窗口化 diff：长文件中部替换，hunk 行号为绝对行号且内容正确', async () => {
    const filePath = path.join(tmpRoot, 'big.txt')
    const lines: string[] = []
    for (let i = 1; i <= 1000; i++) lines.push(`line ${i}`)
    await fs.writeFile(filePath, lines.join('\n') + '\n')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line 900', newString: 'line NINE-HUNDRED'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const diffText = result.diff as string
    // hunk 头应指向 ~900 行附近（绝对行号），而非窗口内相对行号
    const hunk = diffText.match(/@@ -(\d+)/)
    expect(hunk).not.toBeNull()
    const startLine = Number(hunk![1])
    expect(startLine).toBeGreaterThan(850)
    expect(startLine).toBeLessThan(900)
    expect(diffText).toContain('-line 900')
    expect(diffText).toContain('+line NINE-HUNDRED')
  })

  it('>500KB 文件 diff 输出简化描述', async () => {
    const filePath = path.join(tmpRoot, 'huge.txt')
    const lines: string[] = []
    for (let i = 1; i <= 50000; i++) lines.push(`line ${i} padding padding padding`)
    await fs.writeFile(filePath, lines.join('\n') + '\n')
    const stat = await fs.stat(filePath)
    expect(stat.size).toBeGreaterThan(500 * 1024)

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line 39000', newString: 'line 39K'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.diff).toMatch(/^replaced \d+ chars at line \d+$/)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toContain('line 39K')
  })
})
