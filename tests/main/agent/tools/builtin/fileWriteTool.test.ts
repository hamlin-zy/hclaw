/**
 * fileWriteTool 单元测试
 *
 * 覆盖：
 * - 写入新文件（action=created，内容正确）
 * - 覆盖已有文件（action=modified）
 * - createDirs=true（默认）自动创建父目录
 * - createDirs=false 且父目录不存在 → 失败
 * - 路径穿越（当前 resolveAndValidatePath 越界检查已注释，按实际行为固化）
 * - output 含字符数
 *
 * fileWriteTool 内部直接使用 fs（不 mock），测试在系统临时目录创建真实文件。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {fileWriteTool} from '@/main/agent/tools/builtin/fileWriteTool'

/** 构造最小 ToolContext */
function makeContext(workingDir: string): any {
  return {
    workingDir,
    abortSignal: new AbortController().signal,
    sendMessage: vi.fn(),
  }
}

describe('fileWriteTool — 基础写入', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-write-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('写入新文件 → success=true，action=created，文件内容正确', async () => {
    const filePath = path.join(tmpDir, 'new.txt')
    const result = await fileWriteTool.execute(
      {filePath, content: 'hello world'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts![0].action).toBe('created')
    expect(result.artifacts![0].filePath).toBe(filePath)

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('hello world')
  })

  it('覆盖已有文件 → action=modified，内容被替换', async () => {
    const filePath = path.join(tmpDir, 'existing.txt')
    await fs.writeFile(filePath, 'old-content', 'utf-8')

    const result = await fileWriteTool.execute(
      {filePath, content: 'new-content'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.artifacts![0].action).toBe('modified')

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('new-content')
  })

  it('createDirs=true（默认）→ 自动创建父目录', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'dir', 'file.txt')
    const result = await fileWriteTool.execute(
      {filePath, content: 'in nested dir'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.artifacts![0].action).toBe('created')
    expect(result.artifacts![0].filePath).toBe(filePath)

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('in nested dir')
  })

  it('createDirs=false 且父目录不存在 → 失败', async () => {
    const filePath = path.join(tmpDir, 'no-dir', 'file.txt')
    const result = await fileWriteTool.execute(
      {filePath, content: 'x', createDirs: false},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to write file')
    // 目录未被创建，文件不存在
    await expect(fs.access(path.join(tmpDir, 'no-dir'))).rejects.toThrow()
  })

  it('output 含字符数', async () => {
    const filePath = path.join(tmpDir, 'count.txt')
    const result = await fileWriteTool.execute(
      {filePath, content: '12345'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('(5 chars)')
  })
})

describe('fileWriteTool — 路径穿越（resolveAndValidatePath 越界检查当前已注释）', () => {
  let root: string
  let workDir: string
  let targetDir: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-write-travel-'))
    workDir = path.join(root, 'work')
    targetDir = path.join(root, 'target')
    await fs.mkdir(workDir)
    await fs.mkdir(targetDir)
  })

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true})
  })

  it('filePath 含 ../ 逃出工作目录 → 当前实现不拦截（按实际行为固化）', async () => {
    const result = await fileWriteTool.execute(
      {filePath: path.join('..', 'target', 'escaped.txt'), content: 'pwned'},
      makeContext(workDir),
    )

    expect(result.success).toBe(true)
    expect(result.artifacts![0].action).toBe('created')

    const content = await fs.readFile(path.join(targetDir, 'escaped.txt'), 'utf-8')
    expect(content).toBe('pwned')
  })
})
