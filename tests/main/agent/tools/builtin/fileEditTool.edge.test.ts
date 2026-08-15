/**
 * fileEditTool 补充单元测试（edge 场景）
 *
 * 覆盖 fileEditTool.test.ts 未涉及的场景：
 * - oldString 不存在 / 不唯一（含 replaceAll 变体）
 * - newString 为空字符串（删除文本）
 * - 多行 oldString/newString 替换（diff 含 hunk）
 * - 文件不存在
 * - 路径穿越（当前 resolveAndValidatePath 越界检查已注释，按实际行为固化）
 * - 替换后文件实际内容正确（读回断言）
 *
 * fileEditTool 内部直接使用 fs（不 mock），测试在系统临时目录创建真实文件。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {fileEditTool} from '@/main/agent/tools/builtin/fileEditTool'

/** 构造最小 ToolContext */
function makeContext(workingDir: string): any {
  return {
    workingDir,
    abortSignal: new AbortController().signal,
    sendMessage: vi.fn(),
  }
}

describe('fileEditTool — 边界场景', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-edge-'))
    filePath = path.join(tmpDir, 'demo.txt')
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\n', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('oldString 不存在 → success=false，error 提示找不到', async () => {
    const result = await fileEditTool.execute(
      {filePath, oldString: '不存在的文本', newString: 'x'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('No matching text found')
  })

  it('单行 oldString 不唯一（无 replaceAll）→ 按实现只替换第一个匹配并成功', async () => {
    // 源码行为：小文件分支使用无 g 标志的正则 replace，回调只触发一次，
    // 因此 matchCount=1，不唯一检测对单行 oldString 不生效 —— 只替换第一个匹配。
    await fs.writeFile(filePath, 'line1\nline2\nline2\nline3\n', 'utf-8')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line2-CHANGED'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('Replaced 1 match(es)')

    // 仅第一个匹配被替换
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nline2-CHANGED\nline2\nline3\n')
  })

  it('多行 oldString 不唯一（无 replaceAll，小文件）→ 只替换第一个匹配并成功', async () => {
    // 源码行为：streamEditLargeFile 的 split 计数（含不唯一检测）只在
    // isLargeFile（>10MB）时走；小文件始终走内存分支（无 g 正则 replace），
    // matchCount 最多 1，因此多行 oldString 不唯一也不报错，只替换第一个匹配。
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline2\nline3\nline4\n', 'utf-8')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2\nline3', newString: 'X'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('Replaced 1 match(es)')

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nX\nline2\nline3\nline4\n')
  })

  it('oldString 不唯一 + replaceAll=true → 全部替换成功', async () => {
    await fs.writeFile(filePath, 'line1\nline2\nline2\nline3\n', 'utf-8')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line2-CHANGED', replaceAll: true},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nline2-CHANGED\nline2-CHANGED\nline3\n')
  })

  it('newString 为空字符串（删除文本）→ 成功，内容被删除', async () => {
    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2\n', newString: ''},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nline3\nline4\n')
  })

  it('多行 oldString/newString → 成功替换，diff 含 hunk', async () => {
    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2\nline3', newString: 'X\nY'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('Replaced 1 match(es)')

    // diff 含 hunk
    const diff = result.diff as string
    expect(diff.startsWith('@@')).toBe(true)
    expect(diff).toContain('-line2')
    expect(diff).toContain('+X')
    expect(diff).toContain('+Y')

    // 文件内容正确
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nX\nY\nline4\n')
  })

  it('文件不存在 → success=false', async () => {
    const missing = path.join(tmpDir, 'not-exists.txt')
    const result = await fileEditTool.execute(
      {filePath: missing, oldString: 'x', newString: 'y'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to edit file')
  })

  it('替换后文件实际内容正确（读回断言）', async () => {
    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line2-EDITED'},
      makeContext(tmpDir),
    )

    expect(result.success).toBe(true)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('line1\nline2-EDITED\nline3\nline4\n')
  })
})

describe('fileEditTool — 路径穿越（resolveAndValidatePath 越界检查当前已注释）', () => {
  let root: string
  let workDir: string
  let targetDir: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-travel-'))
    workDir = path.join(root, 'work')
    targetDir = path.join(root, 'target')
    await fs.mkdir(workDir)
    await fs.mkdir(targetDir)
  })

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true})
  })

  it('filePath 含 ../ 逃逸出工作目录 → 当前实现不拦截（按实际行为固化）', async () => {
    // resolveAndValidatePath 中 path.relative 越界检查已被注释，
    // 因此 ../ 路径不会被拦截，会真实编辑工作目录之外的文件。
    const targetFile = path.join(targetDir, 'escaped.txt')
    await fs.writeFile(targetFile, 'old-content\n', 'utf-8')

    const result = await fileEditTool.execute(
      {filePath: path.join('..', 'target', 'escaped.txt'), oldString: 'old-content', newString: 'hijacked'},
      makeContext(workDir),
    )

    expect(result.success).toBe(true)
    const content = await fs.readFile(targetFile, 'utf-8')
    expect(content).toBe('hijacked\n')
  })
})
