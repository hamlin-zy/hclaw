/**
 * globTool 单元测试
 *
 * 覆盖 glob 模式、regex 模式、maxDepth、maxResults、错误处理、相对路径输出。
 * 使用真实 fs 临时目录（beforeEach mkdtemp / afterEach rm）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {globTool} from '@/main/agent/tools/builtin/globTool'

describe('globTool — 文件搜索工具', () => {
  let tmpRoot: string
  let workingDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-tool-test-'))
    workingDir = path.join(tmpRoot, 'root')
    await fs.mkdir(path.join(workingDir, 'sub/deep'), {recursive: true})
    await fs.mkdir(path.join(workingDir, 'node_modules'), {recursive: true})

    await fs.writeFile(path.join(workingDir, 'a.ts'), '// a\n')
    await fs.writeFile(path.join(workingDir, 'b.ts'), '// b\n')
    await fs.writeFile(path.join(workingDir, 'sub/c.ts'), '// c\n')
    await fs.writeFile(path.join(workingDir, 'sub/deep/d.ts'), '// d\n')
    await fs.writeFile(path.join(workingDir, '.hidden.ts'), '// hidden\n')
    await fs.writeFile(path.join(workingDir, 'node_modules/x.ts'), '// x\n')
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

  it('pattern **/*.ts 找到 4 个 .ts（排除隐藏文件和 node_modules）', async () => {
    const result = await globTool.execute({pattern: '**/*.ts'}, makeContext() as any)

    expect(result.success).toBe(true)
    expect(result.output).toHaveLength(4)
    const names = (result.output as string[]).map((p) => p.replace(/\\/g, '/')).sort()
    expect(names).toEqual(['a.ts', 'b.ts', 'sub/c.ts', 'sub/deep/d.ts'])
  })

  it('pattern *.ts 只匹配根目录的 a.ts/b.ts', async () => {
    const result = await globTool.execute({pattern: '*.ts'}, makeContext() as any)

    expect(result.success).toBe(true)
    const names = (result.output as string[]).map((p) => p.replace(/\\/g, '/')).sort()
    expect(names).toEqual(['a.ts', 'b.ts'])
  })

  it('regex 按文件名正则匹配（忽略大小写），c\\.ts 匹配 sub/c.ts', async () => {
    const result = await globTool.execute({regex: 'c\\.ts'}, makeContext() as any)

    expect(result.success).toBe(true)
    const names = (result.output as string[]).map((p) => p.replace(/\\/g, '/'))
    expect(names).toEqual(['sub/c.ts'])
  })

  it('regex 模式同样排除 node_modules（与 glob 模式一致）', async () => {
    // node_modules/x.ts 不应被 regex 模式搜到
    const result = await globTool.execute({regex: 'x\\.ts'}, makeContext() as any)

    expect(result.success).toBe(true)
    expect(result.output).toHaveLength(0)
  })

  it('maxDepth: 1 + **/*.ts 只匹配 root 和 sub 层（不含 deep）', async () => {
    const result = await globTool.execute(
      {pattern: '**/*.ts', maxDepth: 1},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    const names = (result.output as string[]).map((p) => p.replace(/\\/g, '/')).sort()
    expect(names).toEqual(['a.ts', 'b.ts', 'sub/c.ts'])
  })

  it('maxResults: 2 最多返回 2 个结果', async () => {
    const result = await globTool.execute(
      {pattern: '**/*.ts', maxResults: 2},
      makeContext() as any,
    )

    expect(result.success).toBe(true)
    expect(result.output).toHaveLength(2)
  })

  it('不传 pattern/regex 返回 success=false 且 error 提示必须提供', async () => {
    const result = await globTool.execute({}, makeContext() as any)

    expect(result.success).toBe(false)
    expect(result.error).toContain('必须提供')
  })

  it('返回相对 workingDir 的相对路径', async () => {
    const result = await globTool.execute({pattern: '*.ts'}, makeContext() as any)

    expect(result.success).toBe(true)
    for (const p of result.output as string[]) {
      expect(path.isAbsolute(p)).toBe(false)
    }
  })

  it('不存在的目录返回 success=false（readdir 失败）', async () => {
    const result = await globTool.execute(
      {pattern: '*.ts', directory: 'not-exists'},
      makeContext() as any,
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Search failed')
  })
})
