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
