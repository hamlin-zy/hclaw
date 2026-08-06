# file_edit 差异输出简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `file_edit` 工具的差异输出从第一个 `@@` 行开始，省略 unified diff 文件头 4 行（`Index:` / `===` / `---` / `+++`）。

**Architecture:** 在 `fileEditTool.ts` 生成 patch 后立即裁剪：`patch.slice(patch.indexOf('\n@@') + 1)`。`indexOf('\n@@')+1` 精确指向首个 hunk（首个 hunk 前必有换行）；找不到时 `-1+1=0`，`slice(0)` 天然回退为完整 patch，diff 字段永不损坏。渲染端 `renderDiff` 零改动（第一行即 `@@`，蓝色高亮逻辑原样生效）。

**Tech Stack:** TypeScript / vitest / jsdiff 9.0.0（已安装，无新增依赖）

## Global Constraints

- 唯一改动点：`src/main/agent/tools/builtin/fileEditTool.ts` 小文件分支（约 253-261 行）
- 渲染端 `popupUtils.tsx` 的 `renderDiff` 不做任何改动
- diff 透传链路（`manager.accumulator.ts` / `toolResultBatch.ts` / `misc.ts`）不做任何改动
- 大文件流式分支（`streamEditLargeFile`）不返回 diff，不涉及
- 裁剪表达式固定为 `patch.slice(patch.indexOf('\n@@') + 1)`，不得引入额外分支
- 测试必须真实写临时文件（fileEditTool 内部直接使用 fs，不 mock），vitest environment 为 node

---

### Task 1: file_edit diff 裁剪实现 + 测试

**Files:**
- Modify: `src/main/agent/tools/builtin/fileEditTool.ts:254-261`
- Create: `tests/main/agent/tools/builtin/fileEditTool.test.ts`

**Interfaces:**
- Consumes: `fileEditTool.execute(args: FileEditInput, context: ToolContext): Promise<ToolResult<string>>`（已存在，签名不变）；`context.workingDir` 用于路径解析；`resolveAndValidatePath` 的越界检查已注释，测试可用任意临时路径
- Produces: 成功替换时 `result.diff` 为裁剪后字符串（以 `@@` 开头，不含文件头 4 行）

- [ ] **Step 1: 写失败测试**

创建 `tests/main/agent/tools/builtin/fileEditTool.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/main/agent/tools/builtin/fileEditTool.test.ts`
Expected: 第一个测试 FAIL —— `diff.startsWith('@@')` 为 false（当前实现返回完整 patch，以 `Index:` 开头）；第二个测试 PASS（hunk 内容本就完整）。

- [ ] **Step 3: 实现裁剪**

修改 `src/main/agent/tools/builtin/fileEditTool.ts` 第 253-261 行：

原代码（第 253-254、258-263 行）：
```ts
      // 生成 Diff（基于原始内容比较，diff 统一用 LF 对比）
      const patch = diff.createPatch(filePath, content.replace(/\r\n/g, '\n'), finalContent.replace(/\r\n/g, '\n'))

      await fs.writeFile(absPath, finalContent, 'utf-8')

      return {
        success: true,
        output: `Replaced ${replaceAll ? matchCount : 1} match(es)`,
        diff: patch, // 返回补丁数据
        artifacts: [{ filePath: absPath, action: 'modified' }],
      }
```

改为：
```ts
      // 生成 Diff（基于原始内容比较，diff 统一用 LF 对比）
      const patch = diff.createPatch(filePath, content.replace(/\r\n/g, '\n'), finalContent.replace(/\r\n/g, '\n'))

      // 简化输出：省略文件头（Index/===/---/+++），从第一个 hunk 头 @@ 开始
      // 文件路径已由 file_edit 参数区展示；indexOf('\n@@')+1 精确指向首个 hunk
      // （首个 hunk 前必有换行；找不到时返回 -1+1=0，slice(0) 天然回退为完整 patch）
      const simplifiedPatch = patch.slice(patch.indexOf('\n@@') + 1)

      await fs.writeFile(absPath, finalContent, 'utf-8')

      return {
        success: true,
        output: `Replaced ${replaceAll ? matchCount : 1} match(es)`,
        diff: simplifiedPatch, // 返回补丁数据（已简化，省略文件头）
        artifacts: [{ filePath: absPath, action: 'modified' }],
      }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/main/agent/tools/builtin/fileEditTool.test.ts`
Expected: 2 个测试全部 PASS。

- [ ] **Step 5: 运行全量相关回归**

Run: `npx vitest run tests/main/agent/tools/builtin/`
Expected: 全部 PASS（确认未破坏同目录其他工具测试）。

- [ ] **Step 6: 提交**

```bash
git add src/main/agent/tools/builtin/fileEditTool.ts tests/main/agent/tools/builtin/fileEditTool.test.ts
git commit -m "feat: simplify file_edit diff output to start from @@ hunk"
```
