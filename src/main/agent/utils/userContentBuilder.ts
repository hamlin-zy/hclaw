/**
 * user 消息附件 → LLM content 构建器（共享）
 *
 * 两条链路必须共用本模块，保证输出逐字节一致（跨 turn KV cache 前缀稳定）：
 * - session_handoff 首轮：工具构建首条 user 消息 content（session_handoff_start → AgentManager.start）
 * - agent-start 历史重建：从 DB 读回 user 消息（content + metadata.attachments）后重建 content
 *
 * 语义与 execution.ts 历史 user 消息重建分支一致：
 * - 图片（本地/网络）：文本追加【图片文件路径】标记（供非视觉模型 analyze_image 使用），
 *   本地图片转 base64 image_url 块，网络图片直接用 URL；读取失败回退文本描述
 * - 非图片附件：文本 + '\n\n' + `[附件]\n文件: ...\n路径: ...` 描述
 */

import * as fs from 'fs/promises'
import crypto from 'crypto'
import {isImageFile, isNetworkImageUrl} from './imageProcessor'

type ContentPart = {type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string}}

/** 附件可能是 {path} 对象，也可能是裸路径字符串（历史数据兼容） */
function attPath(att: {path?: string} | string): string {
    return typeof att === 'string' ? att : att.path || ''
}

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
}

function extToMime(p: string): string {
    const ext = p.split('.').pop()?.toLowerCase() || 'png'
    return MIME_BY_EXT[ext] || 'image/png'
}

/**
 * 构建带附件的 user 消息 LLM content。
 * 与 execution.ts 历史重建分支同源：相同输入（文本 + 附件列表）→ 相同输出。
 */
export async function buildUserHistoryContent(
    text: string,
    attachments: Array<{path?: string; name?: string}>,
): Promise<string | ContentPart[]> {
    if (!attachments || attachments.length === 0) return text

    const imgAttachments = attachments.filter(att =>
        isImageFile(attPath(att)) || isNetworkImageUrl(attPath(att)),
    )

    if (imgAttachments.length === 0) {
        // 非图片附件，添加文本描述
        const otherDesc = attachments.map(att => {
            const path = attPath(att)
            const attName = att.name || path.split('/').pop() || path.split('\\').pop() || path
            return `[附件]\n文件: ${attName}\n路径: ${path}`
        }).join('\n')
        return (text || '') + '\n\n' + otherDesc
    }

    // 将图片路径加入文本，确保非视觉模型也能通过 analyze_image 工具分析图片
    const textParts: string[] = [text || '']
    const imgParts: ContentPart[] = []
    for (const img of imgAttachments) {
        const imgPath = attPath(img)
        if (isNetworkImageUrl(imgPath)) {
            imgParts.push({type: 'image_url', image_url: {url: imgPath}})
        } else {
            try {
                const imgBuffer = await fs.readFile(imgPath)
                const mime = extToMime(imgPath)
                const dataUri = `data:${mime};base64,${imgBuffer.toString('base64')}`
                imgParts.push({type: 'image_url', image_url: {url: dataUri}})
            } catch {
                // 图片读取失败，使用文本描述代替
                textParts.push(`\n[图片: ${imgPath}]`)
            }
        }
    }
    const histImgPaths = imgAttachments.map(att =>
        `\n【图片文件路径】${attPath(att)}`,
    ).join('')
    textParts.push(histImgPaths)
    return [{type: 'text', text: textParts.join('')}, ...imgParts]
}

/**
 * 命令模板 → <command-task> 尾随消息 content。
 * 所有 CT 消息 content 必须经本函数构建，保证输出逐字节一致（跨 turn KV cache 前缀稳定）：
 * - 命令轮首轮：loop/controller.ts 在主循环前构建 CT 消息插入 state 并落库
 * - 后续轮：CT 是真实持久化消息，历史重建自然读到，无需重放
 */
export function buildCommandTaskContent(template: string): string {
    return `<command-task>\n${template}\n</command-task>`
}

/** DB 读回的 user 消息行（execution.ts 历史重建输入，metadata 已含命令/附件等） */
export interface HistoryUserRow {
    id?: string
    role: string
    content?: unknown
    attachments?: Array<{ path?: string; name?: string }>
    messageAttachments?: Array<{ path?: string; name?: string }>
    metadata?: Record<string, unknown> | null
    /** catalog 恢复字段（DB 读回约定：展开到消息顶层） */
    sourceKind?: unknown
    catalogDigest?: unknown
    catalogEntries?: unknown
    catalogSuperseded?: unknown
}

/** 重建后的 user 消息 */
export interface RebuiltUserMessage {
    role: 'user'
    content: string | ContentPart[]
    id: string
    metadata?: Record<string, unknown>
}

/**
 * DB user 消息行 → LLM 历史消息（恒 1:1）。
 *
 * 唯一重建入口：ipc/execution.ts 历史重建调用。
 * CT（<command-task>）自 Task 4 起是真实持久化消息，随历史自然读回，无需重放；
 * 旧会话中残留的 commandTemplate metadata 不再影响重建内容。
 */
export async function convertUserHistoryMessage(msg: HistoryUserRow): Promise<RebuiltUserMessage[]> {
    const attachments = (msg.attachments || msg.messageAttachments) as Array<{ path?: string; name?: string }> | undefined
    let userContent: RebuiltUserMessage['content'] = (msg.content as string) || ''

    if (attachments && attachments.length > 0) {
        userContent = await buildUserHistoryContent((msg.content as string) || '', attachments)
    }

    // ★ DB 读回约定：metadata 展开到消息顶层（buildMessagesFromRows）。
    //   白名单收拢回 metadata，否则 restoreCatalogState 扫不到
    //   sourceKind/catalogDigest → 崩溃/重启恢复后重复发布第二条 catalog。
    const histMetadata: Record<string, unknown> = {
        ...(msg.metadata || {}),
        ...(msg.sourceKind !== undefined ? {sourceKind: msg.sourceKind} : {}),
        ...(msg.catalogDigest !== undefined ? {catalogDigest: msg.catalogDigest} : {}),
        ...(msg.catalogEntries !== undefined ? {catalogEntries: msg.catalogEntries} : {}),
        ...(msg.catalogSuperseded !== undefined ? {catalogSuperseded: msg.catalogSuperseded} : {}),
    }

    const result: RebuiltUserMessage[] = [{
        role: 'user',
        content: userContent,
        id: msg.id || `msg-${Date.now()}`,
        ...(Object.keys(histMetadata).length > 0 ? {metadata: histMetadata} : {}),
    }]

    return result
}

/**
 * 渠道/工具附件 → Message Attachment 结构（AttachmentPreview 渲染兼容）。
 * 与 messageHandler.toMessageAttachments 同构，此处为共享版本。
 */
export function toMessageAttachments(atts: Array<{path: string; name: string; mimeType?: string}>): Array<{
    id: string; name: string; type: string; size: number; path: string; isImage: boolean
}> {
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg'])
    return atts.map(a => {
        const ext = a.path ? `.${a.path.split('.').pop()?.toLowerCase()}` : ''
        return {
            id: crypto.randomUUID(),
            name: a.name,
            type: a.mimeType || '',
            size: 0,
            path: a.path,
            isImage: IMAGE_EXTENSIONS.has(ext),
        }
    })
}
