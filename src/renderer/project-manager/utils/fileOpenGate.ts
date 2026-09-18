// src/renderer/project-manager/utils/fileOpenGate.ts
// 打开入口的大文件门控（计划 §大文件策略）：
// - >5MB（content === null && size > 5MB）：不实例化编辑器内容，占位 title + content '' + fileHash ''
//   （图片 >5MB 同样在此拦截，占位而非转 base64；base64 管线归 Task 15）
// - 1MB < size <= 5MB：正常打开，tab 保留 size 信息（EditorArea 后续按 size 判 forceVim）
import type {FileContentResult, FileSliceResult} from '@shared/types/project-manager'

export const BIG_FILE_LIMIT = 5 * 1024 * 1024

/**
 * QuickOpen 预览取数的 **EOF 短路** 适配（工单 04 第 4 条）。
 *
 * `pm.readLines` 在「请求范围已抵达文件尾且文件 ≤256KB」时会一并带回 `fullContent` + `hash`。
 * 预览读过的文件因此已经握有全文，从列表打开它时不该再发一次全量读（`pm.readFile`）——把这份
 * 切片结果适配成 `FileContentResult` 交给既有的 `toOpenFileTabInput` 即可。
 *
 * 只做形状搬运：切片路径全部走「非二进制、非图片、未截断」的既有占位语义
 * （readLines 遇到二进制/超大文件会返回 error 且没有 fullContent，调用方只有拿到
 * fullContent 才会走到这里，见 `findCachedFullContent`）。
 */
export function fileSliceToContentResult(slice: FileSliceResult): FileContentResult {
  return {
    path: slice.path,
    size: slice.size ?? 0,
    content: slice.fullContent ?? '',
    isBinary: false,
    isImage: false,
    decodeError: false,
    mimeType: '',
    truncated: false,
    mtime: slice.mtime ?? 0,
    hash: slice.hash ?? '',
  }
}

function bigFileTitle(size: number): string {
  return `文件过大（${(size / 1024 / 1024).toFixed(1)} MB）`
}

interface OpenFileTabInput {
  path: string
  title: string
  content: string
  hash: string
  size?: number
  statusBadge?: 'M' | 'A' | 'D' | 'R' | '??'
}

export function toOpenFileTabInput(
  path: string,
  name: string,
  r: FileContentResult,
  statusBadge?: OpenFileTabInput['statusBadge'],
): OpenFileTabInput {
  const tooBig = r.content === null && r.size > BIG_FILE_LIMIT
  // 二进制/解码失败（非图片）→ 占位（不实例化编辑器内容）
  const undecodable = !r.isImage && (r.isBinary || r.decodeError)
  const placeholder = tooBig || undecodable
  // 图片 ≤5MB：主进程补 base64 → 拼 dataURL 交给 tab（EditorArea 按 data:image/ 前缀分流 ImageViewer）
  const imageDataUrl = r.isImage && r.base64 ? `data:${r.mimeType};base64,${r.base64}` : null

  let title = name
  if (tooBig) title = bigFileTitle(r.size)
  else if (undecodable) title = r.isBinary ? '二进制文件' : '无法解码'

  return {
    path,
    title,
    content: imageDataUrl ?? (placeholder ? '' : (r.content ?? '')),
    hash: placeholder ? '' : (r.hash || ''),
    size: r.size,
    statusBadge,
  }
}
