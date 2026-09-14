import * as fs from 'fs/promises'
import {getImageMimeType} from './imageProcessor'

/** 工具名（与 Task 2 同值） */
export const LOAD_IMAGE_TOOL_NAME = 'load_image'

/**
 * 合成 user 消息的文本块前缀。
 * 与既有约定对齐（startAgentCore.ts 的 `【图片文件路径】<path>`）：
 * - 视觉模型：路径 + 紧随其后的 image_url 块 = 图片内容；
 * - 降级/非视觉模型（image_url 被 sanitize 剥离）：文本仍留下快照绝对路径，
 *   供 analyze_image 回退分析——不产生"图片内容已加载，见下"这类被剥图后变成谎言的文案。
 * R2：内容仅由快照路径派生，字节确定（无时间戳/随机）。
 */
export const LOAD_IMAGE_TEXT_PREFIX = '【图片文件路径】'

/** 合成 user 消息的文本块（纯派生：只依赖快照路径） */
export function buildLoadImageTextBlock(snapshotPath: string): string {
  return `${LOAD_IMAGE_TEXT_PREFIX}${snapshotPath}`
}

/** 单轮 LLM 请求注入图片上限 */
export const MAX_IMAGES_PER_REQUEST = 8

export interface LoadImageLikeMessage {
  role: string
  content: unknown
  toolCallId?: string
  functionName?: string
  toolResult?: string
  isError?: boolean
  id?: string
}

/**
 * 从 toolResult 文本解析快照路径（无匹配 → null）。多行模式，锚定首行。
 */
export function parseSnapshotPath(toolResult: string | undefined): string | null {
  if (!toolResult) return null
  const m = /^image_path: (.+)$/m.exec(toolResult)
  return m ? m[1].trim() : null
}

type ReadFileFn = (p: string) => Promise<Buffer>

/**
 * 纯派生：扫描连续 tool 消息段，把成功的 load_image 结果转成紧随其后的合成 user 消息。
 * - 输入不被修改；无变更时返回原数组引用
 * - 任何解析/读取失败 → 跳过该图片（保留 tool 文本，不抛）
 * - id = `load-image:${toolCallId}`；content 固定两段（R2）
 * @param readFile 注入以便单测（默认 fs.readFile）
 */
export async function injectLoadedImages<T extends LoadImageLikeMessage>(
  messages: T[],
  readFile: ReadFileFn = fs.readFile,
): Promise<T[]> {
  let count = 0
  const result: T[] = []
  let idx = 0

  while (idx < messages.length) {
    const msg = messages[idx]
    if (msg.role !== 'tool') {
      result.push(msg)
      idx++
      continue
    }

    // 收集连续 tool 段
    const seg: T[] = []
    while (idx < messages.length && messages[idx].role === 'tool') {
      seg.push(messages[idx])
      idx++
    }
    // 段内消息先原样保留（保持 tool_use/tool_result 配对安全）
    for (const m of seg) result.push(m)

    // 逐个成功的 load_image 生成合成 user 消息，统一排在该 tool 段之后
    for (const m of seg) {
      if (count >= MAX_IMAGES_PER_REQUEST) break
      if (m.functionName !== LOAD_IMAGE_TOOL_NAME || m.isError || !m.toolCallId) continue
      const snapPath = parseSnapshotPath(m.toolResult)
      if (!snapPath) continue

      let buffer: Buffer
      try {
        buffer = await readFile(snapPath)
      } catch {
        continue // 快照不可读 → 跳过注入，保留 tool 文本
      }

      const mime = getImageMimeType(snapPath)
      const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
      const synthetic = {
        role: 'user',
        content: [
          {type: 'text', text: buildLoadImageTextBlock(snapPath)},
          {type: 'image_url', image_url: {url: dataUri}},
        ],
        id: `load-image:${m.toolCallId}`,
      } as unknown as T
      result.push(synthetic)
      count++
    }
  }

  return count > 0 ? result : messages
}
