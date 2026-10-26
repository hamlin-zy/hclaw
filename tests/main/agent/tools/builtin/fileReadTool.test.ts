/**
 * fileReadTool 单元测试
 *
 * 覆盖：
 * - 全量读（无 offset/limit）→ 行号前缀 + 末尾摘要
 * - offset+limit 行范围（行号为绝对行号 N\t）
 * - offset>1 不带 limit（到文件尾）
 * - offset 超出文件行数 → (empty range)
 * - 空文件 → (empty range)
 * - 大文件（>10MB）流式分页读取（默认 limit 2000）+ 摘要一致性
 * - 文件不存在
 * - 路径穿越（当前 resolveAndValidatePath 越界检查已注释，按实际行为固化）
 *
 * 输出格式统一为：正文「行号\t内容」+ 末尾一行摘要
 * `(共 {total} 行，已显示全部|已显示 {start}-{end})`；无内容时为 `(empty range)`。
 *
 * fileReadTool 内部直接使用 fs（不 mock），测试在系统临时目录创建真实文件。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {fileReadTool} from '@/main/agent/tools/builtin/fileReadTool'

/** 构造最小 ToolContext */
function makeContext(workingDir: string): any {
  return {
    workingDir,
    abortSignal: new AbortController().signal,
    sendMessage: vi.fn(),
  }
}

describe('fileReadTool — 基本读取', () => {
  let tmpDir: string
  let filePath: string
  const CONTENT = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n'

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-read-test-'))
    filePath = path.join(tmpDir, 'demo.txt')
    await fs.writeFile(filePath, CONTENT, 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('全量读（无 offset/limit）→ 行号前缀 + 末尾摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    // 文件以 \n 结尾，split 后末尾含空串，作为第 8 行输出
    expect(result.output).toBe(
      '1\tline1\n2\tline2\n3\tline3\n4\tline4\n5\tline5\n6\tline6\n7\tline7\n8\t\n(共 8 行，已显示全部)',
    )
  })

  it('offset+limit 行范围 → 只返回指定行，行号为绝对行号 N\t 格式 + 摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath, offset: 2, limit: 3},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('2\tline2\n3\tline3\n4\tline4\n(共 8 行，已显示 2-4)')
  })

  it('offset>1 不带 limit → 从 offset 到文件尾 + 摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath, offset: 5},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    // 源码行为：文件以 \n 结尾，split 后末尾含空串，也会作为一行输出
    expect(result.output).toBe('5\tline5\n6\tline6\n7\tline7\n8\t\n(共 8 行，已显示 5-8)')
  })

  it('offset 超出文件行数 → (empty range)', async () => {
    const result = await fileReadTool.execute(
      {filePath, offset: 100},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('(empty range)')
  })

  it('空文件 → (empty range)', async () => {
    const emptyPath = path.join(tmpDir, 'empty.txt')
    await fs.writeFile(emptyPath, '', 'utf-8')

    const result = await fileReadTool.execute(
      {filePath: emptyPath},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('(empty range)')
  })

  it('文件不存在 → success=false', async () => {
    const missing = path.join(tmpDir, 'not-exists.txt')
    const result = await fileReadTool.execute(
      {filePath: missing},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to read file')
  })
})

describe('fileReadTool — 大文件（>10MB）流式分页', () => {
  let tmpDir: string
  let largePath: string

  const ROW_SIZE = 60 // 每行固定 60 字节（含末尾 \n）
  const TOTAL_BYTES = 11 * 1024 * 1024 // 11MB > 10MB 阈值
  const TOTAL_ROWS = Math.ceil(TOTAL_BYTES / ROW_SIZE)

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-read-large-'))
    largePath = path.join(tmpDir, 'large.txt')

    // 用 Buffer 快速生成 11MB：每行 "i\taaaa...a\n"（i 为写入时行号，内容有区分度）
    const buf = Buffer.alloc(TOTAL_ROWS * ROW_SIZE, 0x61) // 全部 'a'
    for (let i = 0; i < TOTAL_ROWS; i++) {
      const idx = i * ROW_SIZE
      buf.write(`${i}\t`, idx, 'utf8')
      buf[idx + ROW_SIZE - 1] = 0x0a // '\n'
    }
    await fs.writeFile(largePath, buf)
  }, 20000)

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  }, 20000)

  it('大文件 offset+limit 读取 → 行号为绝对行号，末尾摘要与内存路径格式一致', async () => {
    const result = await fileReadTool.execute(
      {filePath: largePath, offset: 3, limit: 5},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    const lines = result.output.split('\n')

    // 返回 5 行正文 + 1 行摘要
    expect(lines).toHaveLength(6)
    // 每行固定 60 字节：行号 "i\t"（2 字节） + 'a' + '\n'（1 字节）→ 中间 57 个 'a'
    const rowContent = (i: number) => `${i}\t${'a'.repeat(57)}`
    expect(lines[0]).toBe(`3\t${rowContent(2)}`)
    expect(lines[4]).toBe(`7\t${rowContent(6)}`)
    expect(lines[5]).toBe(`(共 ${TOTAL_ROWS} 行，已显示 3-7)`)
    // 未包含第 1 行
    expect(result.output).not.toContain('\n1\t')
  })

  it('大文件 offset 不带 limit → 使用默认分页 limit 2000 + 摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath: largePath, offset: 1},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    const lines = result.output.split('\n')
    // 2000 行正文 + 1 行摘要
    expect(lines).toHaveLength(2001)
    expect(lines[0].startsWith('1\t')).toBe(true)
    expect(lines[1999].startsWith('2000\t')).toBe(true)
    expect(lines[2000]).toBe(`(共 ${TOTAL_ROWS} 行，已显示 1-2000)`)
    // 未包含超过 limit 的行
    expect(result.output).not.toContain('\n2001\t')
  })

  it('大文件 offset 超出总行数 → (empty range)', async () => {
    const result = await fileReadTool.execute(
      {filePath: largePath, offset: TOTAL_ROWS + 10},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('(empty range)')
  })

  it('大文件 raw=true + offset/limit → 纯文本，无行号无摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath: largePath, raw: true, offset: 3, limit: 2},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    const rowContent = (i: number) => `${i}\t${'a'.repeat(57)}`
    expect(result.output).toBe(`${rowContent(2)}\n${rowContent(3)}`)
    expect(result.output).not.toContain('共 ')
  })
})

describe('fileReadTool — 路径穿越（resolveAndValidatePath 越界检查当前已注释）', () => {
  let root: string
  let workDir: string
  let targetDir: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-read-travel-'))
    workDir = path.join(root, 'work')
    targetDir = path.join(root, 'target')
    await fs.mkdir(workDir)
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, 'secret.txt'), 'secret-data\n', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true})
  })

  it('filePath 含 ../ 逃出工作目录 → 当前实现不拦截（按实际行为固化）', async () => {
    const result = await fileReadTool.execute(
      {filePath: path.join('..', 'target', 'secret.txt')},
      makeContext(workDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('1\tsecret-data\n2\t\n(共 2 行，已显示全部)')
  })
})

describe('fileReadTool — raw 模式（纯文本，无行号无摘要）', () => {
  let tmpDir: string
  let filePath: string
  const CONTENT = 'alpha\nbeta\ngamma\ndelta\n'

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-read-raw-'))
    filePath = path.join(tmpDir, 'raw.txt')
    await fs.writeFile(filePath, CONTENT, 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('raw=true → 纯文本，无行号前缀、无末尾摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath, raw: true},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    // 文件以 \n 结尾，split 后末尾空串同样按原文拼回 → 输出以 \n 结尾
    expect(result.output).toBe('alpha\nbeta\ngamma\ndelta\n')
    expect(result.output).not.toContain('\t')
    expect(result.output).not.toContain('共 4 行')
  })

  it('raw=true + offset/limit → 只返回指定行，仍无行号无摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath, raw: true, offset: 2, limit: 2},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('beta\ngamma')
  })

  it('raw=true + 空文件 → 空字符串', async () => {
    const emptyPath = path.join(tmpDir, 'empty.txt')
    await fs.writeFile(emptyPath, '', 'utf-8')

    const result = await fileReadTool.execute(
      {filePath: emptyPath, raw: true},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('')
  })

  it('raw 缺省（false）→ 仍为行号 + 摘要', async () => {
    const result = await fileReadTool.execute(
      {filePath},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('1\talpha\n2\tbeta\n3\tgamma\n4\tdelta\n5\t\n(共 5 行，已显示全部)')
  })
})

describe('fileReadTool — filePaths 多文件读取', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-read-multi-'))
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'A1\nA2\n', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'B1\nB2\n', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('两个文件 → `=== <path> ===` 分隔，各自带行号与摘要', async () => {
    const result = await fileReadTool.execute(
      {filePaths: ['a.txt', 'b.txt']},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe(
      '=== a.txt ===\n1\tA1\n2\tA2\n3\t\n(共 3 行，已显示全部)\n' +
      '=== b.txt ===\n1\tB1\n2\tB2\n3\t\n(共 3 行，已显示全部)',
    )
  })

  it('每个文件独立应用 offset/limit', async () => {
    const result = await fileReadTool.execute(
      {filePaths: ['a.txt', 'b.txt'], offset: 2, limit: 1},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe(
      '=== a.txt ===\n2\tA2\n(共 3 行，已显示 2-2)\n' +
      '=== b.txt ===\n2\tB2\n(共 3 行，已显示 2-2)',
    )
  })

  it('filePaths + raw=true → 分隔头保留，内容无行号无摘要', async () => {
    const result = await fileReadTool.execute(
      {filePaths: ['a.txt', 'b.txt'], raw: true},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('=== a.txt ===\nA1\nA2\n\n=== b.txt ===\nB1\nB2\n')
  })

  it('filePaths 超过 10 个 → 报错 filePaths 最多 10 个文件', async () => {
    const paths = Array.from({length: 11}, (_, i) => `f${i}.txt`)

    const result = await fileReadTool.execute(
      {filePaths: paths},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('filePaths 最多 10 个文件')
  })

  it('恰好 10 个文件 → 允许（不报数量错误）', async () => {
    const paths: string[] = []
    for (let i = 0; i < 10; i++) {
      const name = `n${i}.txt`
      await fs.writeFile(path.join(tmpDir, name), `N${i}\n`, 'utf-8')
      paths.push(name)
    }

    const result = await fileReadTool.execute(
      {filePaths: paths},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output.split('=== ').length - 1).toBe(10)
  })

  it('filePath 与 filePaths 都缺 → 报错 必须提供 filePath 或 filePaths', async () => {
    const result = await fileReadTool.execute({} as any, makeContext(tmpDir))

    expect(result.success).toBe(false)
    expect(result.error).toBe('必须提供 filePath 或 filePaths')
  })

  it('filePaths 为空数组 → 视为未提供', async () => {
    const result = await fileReadTool.execute(
      {filePaths: []} as any,
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('必须提供 filePath 或 filePaths')
  })
})

describe('fileReadTool — 目录路径友好报错', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-read-dir-'))
    await fs.mkdir(path.join(tmpDir, 'sub'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('filePath 是目录 → 提示改用 glob，而不是 EISDIR', async () => {
    const result = await fileReadTool.execute(
      {filePath: 'sub'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      '路径是目录。列出目录内容请用 glob（pattern: "**/*"），不要用 bash Get-ChildItem。',
    )
  })

  it('filePaths 中含目录 → 同样返回目录提示', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'A1\n', 'utf-8')

    const result = await fileReadTool.execute(
      {filePaths: ['a.txt', 'sub']},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('路径是目录')
  })
})

describe('fileReadTool — description 契约', () => {
  it('描述披露 raw / filePaths / 大文件分页与工具分工', () => {
    const desc = fileReadTool.description

    expect(desc).toContain('raw=true 输出纯文本（无行号/摘要）')
    expect(desc).toContain('filePaths 可一次读多个文件')
    expect(desc).toContain('超过 10MB 的文件默认只返回前 2000 行，需用 offset 分页')
    expect(desc).toContain('读文件优先用它')
    expect(desc).toContain('需要按内容筛选时用 grep，列目录用 glob')
  })
})
