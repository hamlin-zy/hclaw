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
import {grepTool, searchWithJs} from '@/main/agent/tools/builtin/grepTool'

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

describe('grepTool — includeIgnored（被忽略文件与隐藏目录）', () => {
  let tmpRoot: string
  let workingDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-ignored-'))
    workingDir = path.join(tmpRoot, 'root')
    await fs.mkdir(path.join(workingDir, '.hidden'), {recursive: true})
    await fs.mkdir(path.join(workingDir, '.git'), {recursive: true})
    await fs.mkdir(path.join(workingDir, 'node_modules'), {recursive: true})

    await fs.writeFile(path.join(workingDir, '.hidden/target.txt'), 'needle-hidden line\n')
    await fs.writeFile(path.join(workingDir, '.hidden/real.txt'), 'needle-excl in hidden\n')
    await fs.writeFile(path.join(workingDir, '.git/config.txt'), 'needle-excl in git\n')
    await fs.writeFile(path.join(workingDir, 'node_modules/x.txt'), 'needle-excl in node_modules\n')
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

  it('不传 includeIgnored 时隐藏目录被跳过（0 命中）', async () => {
    const result = await grepTool.execute({pattern: 'needle-hidden'}, makeContext() as any)

    expect(result.success).toBe(true)
    expect(result.output).toBe('No matching results found')
  })

  it('includeIgnored: true 时命中隐藏目录内文件且输出为 相对路径:行号: 内容', async () => {
    const result = await grepTool.execute(
      {pattern: 'needle-hidden', includeIgnored: true},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('.hidden/target.txt:1: needle-hidden line')
  })

  it('includeIgnored: true 仍排除 .git 与 node_modules（含正向对照）', async () => {
    const result = await grepTool.execute(
      {pattern: 'needle-excl', includeIgnored: true},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const output = result.output as string
    // 正向对照：搜索确实在跑（隐藏目录内的普通文件被命中）
    expect(output).toContain('.hidden/real.txt')
    // 排除项：.git 与 node_modules 始终不进入结果
    expect(output).not.toContain('.git/config.txt')
    expect(output).not.toContain('node_modules/x.txt')
  })

  it('searchWithJs 直调：默认 0 命中，includeIgnored: true 命中隐藏文件', async () => {
    const withoutIgnored = await searchWithJs({pattern: 'needle-hidden'}, workingDir, workingDir)
    expect(withoutIgnored).toBe('')

    const withIgnored = await searchWithJs(
      {pattern: 'needle-hidden', includeIgnored: true},
      workingDir,
      workingDir,
    )
    expect(withIgnored).toMatch(/\.hidden[\\/]target\.txt/)

    // 恒排除判据（walkAndSearch 的 .git / node_modules 跳过）回归守卫：
    // 这两个目录即使 includeIgnored: true 也必须被排除
    await fs.writeFile(path.join(workingDir, '.git/marker.txt'), 'needle-hidden in git\n')
    await fs.writeFile(path.join(workingDir, 'node_modules/marker.txt'), 'needle-hidden in node_modules\n')

    const excluded = await searchWithJs(
      {pattern: 'needle-hidden', includeIgnored: true},
      workingDir,
      workingDir,
    )
    // 正向对照：搜索确实在跑（隐藏目录内的普通文件被命中）
    expect(excluded).toMatch(/\.hidden[\\/]target\.txt/)
    // 排除项：.git 与 node_modules 始终不进入结果
    expect(excluded).not.toMatch(/\.git[\\/]marker\.txt/)
    expect(excluded).not.toMatch(/node_modules[\\/]marker\.txt/)
  })
})
