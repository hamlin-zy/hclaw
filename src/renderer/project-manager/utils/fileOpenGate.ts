// src/renderer/project-manager/utils/fileOpenGate.ts
// 打开入口的大文件门控（计划 §大文件策略）：
// - >5MB（content === null && size > 5MB）：不实例化编辑器内容，占位 title + content '' + fileHash ''
//   （图片 >5MB 同样在此拦截，占位而非转 base64；base64 管线归 Task 15）
// - 1MB < size <= 5MB：正常打开，tab 保留 size 信息（EditorArea 后续按 size 判 forceVim）
import type {FileContentResult} from '@shared/types/project-manager'

export const BIG_FILE_LIMIT = 5 * 1024 * 1024

export function bigFileTitle(size: number): string {
  return `文件过大（${(size / 1024 / 1024).toFixed(1)} MB）`
}

export interface OpenFileTabInput {
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
