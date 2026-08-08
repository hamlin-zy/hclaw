/**
 * fileEditTool 单元测试
 *
 * 覆盖 diff 输出简化：从第一个 @@ hunk 开始，省略文件头 4 行
 * （Index: / === / --- <path> / +++ <path>）
 *
 * fileEditTool 内部直接使用 fs（不 mock），测试在系统临时目录
 * 创建真实文件进行替换。
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {fileEditTool} from '@/main/agent/tools/builtin/fileEditTool'

describe('fileEditTool — diff 输出简化（从 @@ 开始）', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-test-'))
    filePath = path.join(tmpDir, 'demo.txt')
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\n', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('成功替换后 diff 以 @@ 开头，省略文件头 4 行', async () => {
    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line2-CHANGED'},
      {workingDir: tmpDir} as any,
    )

    expect(result.success).toBe(true)
    const diff = result.diff as string
    expect(diff.startsWith('@@')).toBe(true)
    expect(diff).not.toContain('Index:')
    expect(diff).not.toContain('====')
    expect(diff).not.toContain('--- ')
    expect(diff).not.toContain('+++ ')
  })

  it('diff 保留完整 hunk 内容（上下文行与 +/- 变更行）', async () => {
    const result = await fileEditTool.execute(
      {filePath, oldString: 'line2', newString: 'line2-CHANGED'},
      {workingDir: tmpDir} as any,
    )

    const diff = result.diff as string
    expect(diff).toContain('@@ -1,4 +1,4 @@')
    expect(diff).toContain('line1')          // 上下文行
    expect(diff).toContain('-line2')         // 删除行
    expect(diff).toContain('+line2-CHANGED') // 新增行
    expect(diff).toContain('line3')          // 上下文行
  })
})
