/**
 * grepTool 性能/防护补充测试
 *
 - 大文件跳过（>1MB）
 - 内容级二进制嗅探
 - rg 回退路径（rg 不可用时回退 JS 实现）
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

// 模拟 rg 不存在（spawn ENOENT）→ 应回退 JS 实现
vi.mock('@vscode/ripgrep', () => ({rgPath: 'nonexistent-rg-binary-path'}))

import {grepTool, searchWithJs, isBinaryContent} from '@/main/agent/tools/builtin/grepTool'

describe('grepTool — 大文件与二进制防护（JS 回退路径）', () => {
  let tmpRoot: string
  let workingDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-perf-'))
    workingDir = path.join(tmpRoot, 'root')
    await fs.mkdir(workingDir, {recursive: true})
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, {recursive: true, force: true})
  })

  function makeContext() {
    return {
      workingDir,
      abortSignal: new AbortController().signal,
      sendMessage: vi.fn(),
    }
  }

  it('>1MB 文件被跳过并注明跳过数量', async () => {
    await fs.writeFile(path.join(workingDir, 'small.txt'), 'needle here\n')
    // >1MB 但仍是文本的文件，包含同样的搜索词
    const big = 'x'.repeat(600 * 1024) + '\nneedle in big file\n' + 'y'.repeat(600 * 1024)
    await fs.writeFile(path.join(workingDir, 'big.txt'), big)

    const result = await searchWithJs(
      {pattern: 'needle', maxResults: 50},
      workingDir,
      workingDir,
    )

    expect(result).toContain('small.txt')
    expect(result).not.toContain('needle in big file')
    expect(result).toContain('[1 files skipped (>1MB)]')
  })

  it('内容级二进制嗅探：无二进制扩展名但含 NUL 的文件被跳过', async () => {
    await fs.writeFile(path.join(workingDir, 'a.txt'), 'needle\n')
    await fs.writeFile(path.join(workingDir, 'blob.dat'), Buffer.from([0x01, 0x00, 0x02, 0x00]))

    expect(isBinaryContent('plain text\nneedle')).toBe(false)
    expect(isBinaryContent('has\0nul\nneedle')).toBe(true)

    const result = await searchWithJs({pattern: 'needle'}, workingDir, workingDir)
    expect(result).toContain('a.txt')
    expect(result).not.toContain('blob.dat')
  })

  it('rg 不可用时回退 JS 实现且结果正确', async () => {
    await fs.writeFile(path.join(workingDir, 'a.txt'), 'hello world\n')
    await fs.mkdir(path.join(workingDir, 'node_modules'), {recursive: true})
    await fs.writeFile(path.join(workingDir, 'node_modules/skip.txt'), 'hello\n')

    const result = await grepTool.execute(
      {pattern: 'hello', caseInsensitive: false},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('a.txt:1: hello world')
    expect(result.output).not.toContain('skip.txt')
  })
})
