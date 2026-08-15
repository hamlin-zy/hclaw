/**
 * grepTool 单元测试
 *
 * 覆盖内容匹配、大小写敏感/不敏感、文件名过滤、maxResults、
 * 无匹配、非法正则、输出格式、directory 子目录搜索、二进制/目录跳过。
 * 使用真实 fs 临时目录（beforeEach mkdtemp / afterEach rm）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {grepTool} from '@/main/agent/tools/builtin/grepTool'

describe('grepTool — 文件内容搜索工具', () => {
  let tmpRoot: string
  let workingDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-test-'))
    workingDir = path.join(tmpRoot, 'root')
    await fs.mkdir(path.join(workingDir, 'node_modules'), {recursive: true})

    await fs.writeFile(path.join(workingDir, 'a.txt'), 'hello world\nfoo bar\n')
    await fs.writeFile(path.join(workingDir, 'b.txt'), 'HELLO again\n')
    await fs.writeFile(path.join(workingDir, 'c.ts'), 'hello from ts\n')
    // 假二进制：PNG 魔数字节开头
    await fs.writeFile(path.join(workingDir, 'binary.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    await fs.writeFile(path.join(workingDir, 'node_modules/skip.txt'), 'hello\n')
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

  it('pattern hello 匹配 a.txt、b.txt、c.ts（跳过 node_modules 与二进制）', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', caseInsensitive: true},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const lines = (result.output as string).split('\n')
    const fileSet = new Set(lines.map((l) => l.split(':')[0]))
    expect(fileSet).toEqual(new Set(['a.txt', 'b.txt', 'c.ts']))
    expect(lines.join('\n')).not.toContain('skip.txt')
    expect(lines.join('\n')).not.toContain('binary.png')
  })

  it('filePattern *.txt 只匹配 txt 文件', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', filePattern: '*.txt', caseInsensitive: true},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const lines = (result.output as string).split('\n')
    const fileSet = new Set(lines.map((l) => l.split(':')[0]))
    expect(fileSet).toEqual(new Set(['a.txt', 'b.txt']))
  })

  it('caseInsensitive: true + hello 匹配 b.txt 的 HELLO', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', caseInsensitive: true},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect((result.output as string).split('\n').some((l) => l.startsWith('b.txt'))).toBe(true)
  })

  it('caseInsensitive: false + hello 时 b.txt 不匹配', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', caseInsensitive: false},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const lines = (result.output as string).split('\n')
    const fileSet = new Set(lines.map((l) => l.split(':')[0]))
    expect(fileSet).toEqual(new Set(['a.txt', 'c.ts']))
    expect(fileSet.has('b.txt')).toBe(false)
  })

  it('maxResults: 1 最多返回 1 行结果', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', maxResults: 1},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect((result.output as string).split('\n')).toHaveLength(1)
  })

  it('无匹配时 success=true 且 output 含 No matching results', async () => {
    const result = await grepTool.execute(
      {pattern: 'zzz-no-such-text'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('No matching results')
  })

  it('非法正则 success=false 且 error 含 Search failed', async () => {
    const result = await grepTool.execute({pattern: '('}, makeContext() as any)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Search failed')
  })

  it('输出格式为 相对路径:行号: 内容', async () => {
    const result = await grepTool.execute(
      {pattern: '^hello world$'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('a.txt:1: hello world')
  })

  it('directory 参数指定子目录搜索', async () => {
    await fs.mkdir(path.join(workingDir, 'sub'))
    await fs.writeFile(path.join(workingDir, 'sub/d.txt'), 'hello from sub\n')

    const result = await grepTool.execute(
      {pattern: 'hello', directory: 'sub'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('d.txt:1: hello from sub')
  })
})
