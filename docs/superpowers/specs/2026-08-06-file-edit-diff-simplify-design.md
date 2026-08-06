---
type: design
topic: file_edit 差异输出简化
date: 2026-08-06
status: approved
---

# file_edit 差异输出简化设计

## 背景

`file_edit` 工具的变更差异区当前显示完整 unified diff，头部包含 4 行冗余信息：

```
Index: E:\path\to\file.ts          ← 冗余：文件路径
=================================== ← 冗余：分隔线
--- "E:\path\to\file.ts"           ← 冗余：文件路径
+++ "E:\path\to\file.ts"           ← 冗余：文件路径
@@ -1,4 +1,4 @@                     ← 有效内容起点
```

文件路径已在工具卡片的参数区展示（`filePath` 参数），头部 4 行属于重复信息，占空间且无信息量。

## 目标

`file_edit` 差异输出从第一个 `@@` 行开始，省略文件头 4 行。

## 方案选择

用户选定 **方案 A：生成端裁剪**（vs 方案 B：渲染端过滤）。

理由：
- 改动点唯一（`fileEditTool.ts`），所有消费方（UI/存储/透传）统一生效
- 渲染端 `renderDiff` 无需改动，第一行即 `@@`，蓝色高亮逻辑原样生效
- 已确认 `diff` 字段唯一消费者是 UI 展示（`PopupToolCard.tsx:129`，外层条件 `toolCall.name === 'file_edit'`），无任何依赖标准 unified diff 格式的功能（`ToolCallBody.tsx:82` 为空占位），格式简化的风险为零
- 渲染端过滤仅影响展示层，数据仍冗余；且需多一层行前缀过滤逻辑

## 改动内容

**唯一改动点**：`src/main/agent/tools/builtin/fileEditTool.ts`，`execute()` 小文件分支内（约 253-261 行）。

```ts
// 生成 Diff（基于原始内容比较，diff 统一用 LF 对比）
const patch = diff.createPatch(filePath, content.replace(/\r\n/g, '\n'), finalContent.replace(/\r\n/g, '\n'))

// 简化输出：省略文件头（Index/===/---/+++），从第一个 hunk 头 @@ 开始
// 文件路径已由 file_edit 参数区展示；indexOf('\n@@')+1 精确指向首个 hunk
// （首个 hunk 前必有换行；找不到时返回 -1+1=0，slice(0) 天然回退为完整 patch）
const simplifiedPatch = patch.slice(patch.indexOf('\n@@') + 1)
```

返回时使用 `diff: simplifiedPatch`。

## 行为说明

- 替换成功时 `patch` 必然包含至少一个 `@@` hunk（否则内容无变化），裁剪后输出示例：
  ```
  @@ -1,4 +1,4 @@
   line1
  -line2
  +line2-CHANGED
   line3
  ```
- 兜底分支（找不到 `@@` 时）返回完整 patch，保证 `diff` 字段永不损坏
- 大文件流式分支（`streamEditLargeFile`）不返回 diff，不受影响

## 影响面

- 渲染端 `renderDiff`（`popupUtils.tsx:6`）零改动
- 其他工具卡片（file_write/bash/MCP）不经由 `renderDiff`，不受影响
- `diff` 字段透传链路（`manager.accumulator.ts` / `toolResultBatch.ts` / `misc.ts`）无需改动

## 测试策略

- 新增 `tests/main/agent/tools/builtin/fileEditTool.test.ts`（目录已有同类测试先例）：
  - 断言成功替换后返回的 `diff` 以 `@@` 开头，且不含 `Index:` / `===` / `--- <path>` / `+++ <path>` 头行
  - 断言 hunk 内容完整（含上下文行与 `+`/`-` 变更行）
- 若评估认为改动过小不值得新增测试文件，可在现有工具测试中补一条断言；最终由实现阶段按最小变更原则权衡

## 验证方式

1. `npx vitest run` 相关测试通过
2. 手动验证：UI 中执行一次 file_edit，确认差异区从 `@@` 行开始显示，参数区仍显示文件路径
