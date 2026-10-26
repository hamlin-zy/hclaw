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

describe('grepTool — context / outputMode', () => {
  let tmpRoot: string
  let workingDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-context-'))
    workingDir = path.join(tmpRoot, 'root')
    await fs.mkdir(workingDir, {recursive: true})

    // 行号固定：l1 l2 MATCH l4 l5
    await fs.writeFile(path.join(workingDir, 'ctx.txt'), 'l1\nl2\nMATCH\nl4\nl5\n')
    // 命中计数用：multi 2 次、single 1 次
    await fs.writeFile(path.join(workingDir, 'multi.txt'), 'hello\nhello\n')
    await fs.writeFile(path.join(workingDir, 'single.txt'), 'hello\n')
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

  it('context: 2 输出匹配行前后各 2 行（rg 路径，文件内按行序分组）', async () => {
    const result = await grepTool.execute(
      {pattern: 'MATCH', context: 2},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe([
      'ctx.txt-1- l1',
      'ctx.txt-2- l2',
      'ctx.txt:3: MATCH',
      'ctx.txt-4- l4',
      'ctx.txt-5- l5',
    ].join('\n'))
  })

  it('context: 0 与不传 context 的输出逐字节一致', async () => {
    const plain = await grepTool.execute({pattern: 'MATCH'}, makeContext() as any)
    const explicitZero = await grepTool.execute(
      {pattern: 'MATCH', context: 0},
      makeContext() as any,
    )

    expect(plain.output).toBe('ctx.txt:3: MATCH')
    expect(explicitZero.output).toBe(plain.output)
  })

  it('outputMode: files_with_matches 只返回文件路径且去重', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', outputMode: 'files_with_matches'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect((result.output as string).split('\n').sort()).toEqual(['multi.txt', 'single.txt'])
  })

  it('outputMode: count 返回 文件:命中数', async () => {
    const result = await grepTool.execute(
      {pattern: 'hello', outputMode: 'count'},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect((result.output as string).split('\n').sort()).toEqual(['multi.txt:2', 'single.txt:1'])
  })

  it('outputMode: content 显式传入与默认输出一致，且文件顺序确定', async () => {
    const plain = await grepTool.execute({pattern: 'hello'}, makeContext() as any)
    const explicit = await grepTool.execute(
      {pattern: 'hello', outputMode: 'content'},
      makeContext() as any,
    )

    expect(explicit.output).toBe(plain.output)
    // 顺序必须确定：文件按路径升序（rg 多线程事件到达顺序不稳定）
    expect(plain.output).toBe('multi.txt:1: hello\nmulti.txt:2: hello\nsingle.txt:1: hello')
  })

  it('非法 outputMode 由 zod 拒绝', () => {
    expect(grepTool.inputSchema.safeParse({pattern: 'x', outputMode: 'bogus'}).success).toBe(false)
    expect(grepTool.inputSchema.safeParse({pattern: 'x', outputMode: 'count'}).success).toBe(true)
  })

  it('searchWithJs 回退路径：files_with_matches / count 生效，context 首版忽略', async () => {
    const files = await searchWithJs(
      {pattern: 'hello', outputMode: 'files_with_matches'},
      workingDir,
      workingDir,
    )
    expect(files.split('\n').sort()).toEqual(['multi.txt', 'single.txt'])

    const counts = await searchWithJs(
      {pattern: 'hello', outputMode: 'count'},
      workingDir,
      workingDir,
    )
    expect(counts.split('\n').sort()).toEqual(['multi.txt:2', 'single.txt:1'])

    // context 在 JS 回退路径首版忽略：输出与不传 context 完全一致
    const plainCtx = await searchWithJs({pattern: 'MATCH'}, workingDir, workingDir)
    const withCtx = await searchWithJs({pattern: 'MATCH', context: 2}, workingDir, workingDir)
    expect(withCtx).toBe(plainCtx)
    expect(withCtx).toContain('ctx.txt:3: MATCH')
  })

  it('rg 不可用时回退 JS 路径且新参数不崩', async () => {
    vi.resetModules()
    vi.doMock('@/main/utils/ripgrepPath', () => ({rgBinPath: 'hclaw-no-such-rg-binary'}))
    try {
      const mod = await import('@/main/agent/tools/builtin/grepTool')
      const files = await mod.grepTool.execute(
        {pattern: 'hello', context: 2, outputMode: 'files_with_matches'},
        makeContext() as any,
      )
      expect(files.success).toBe(true)
      expect((files.output as string).split('\n').sort()).toEqual(['multi.txt', 'single.txt'])

      const counts = await mod.grepTool.execute(
        {pattern: 'hello', outputMode: 'count'},
        makeContext() as any,
      )
      expect(counts.success).toBe(true)
      expect((counts.output as string).split('\n').sort()).toEqual(['multi.txt:2', 'single.txt:1'])
    } finally {
      vi.doUnmock('@/main/utils/ripgrepPath')
      vi.resetModules()
    }
  })
})
