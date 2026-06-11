/**
 * 渠道媒体文件通用工具
 *
 * 提供会话感知的附件存储功能，所有 Adapter 可复用：
 * - resolveSessionDir: 获取会话级/渠道级附件目录
 * - saveMediaBuffer:   保存媒体文件到会话隔离目录
 *
 * 路径结构：{dataDir}/channels/{channelId}/attachments/{conversationId}/{yyyyMMdd}/{filename}
 * 无 conversationId 时：{dataDir}/channels/{channelId}/attachments/{yyyyMMdd}/{filename}
 *
 * ⚠️ 注意：config.ts 有 module-level 副作用（加载 SQLite），
 * 必须在 Worker 中延迟加载（动态 require），不能用静态 import。
 */

import * as path from 'path'
import * as fs from 'fs'
import crypto from 'crypto'

// ─── 公开 API ────────────────────────────────────────────

/**
 * 获取会话级附件存储目录
 *
 * @param channelId      渠道 ID（如 'wechat'）
 * @param conversationId 会话 ID（可选，无则回退到渠道级目录）
 * @returns              目录的绝对路径（目录已确保存在）
 */
export function resolveSessionDir(channelId: string, conversationId?: string): string {
    const {getChannelSessionMediaDir, getChannelMediaDir} = require('../../config')
    return conversationId
        ? getChannelSessionMediaDir(channelId, conversationId)
        : getChannelMediaDir(channelId)
}

/**
 * 保存媒体文件到会话隔离目录
 *
 * @param channelId  渠道 ID
 * @param buffer     文件二进制数据
 * @param options    可选配置
 * @param options.conversationId  会话 ID（可选，无则渠道级）
 * @param options.mimeType        MIME 类型（用于推断扩展名）
 * @param options.fileName        原始文件名（优先于 mimeType 推断扩展名）
 * @returns  { path }  保存后的完整文件路径
 *
 * 文件名格式：{timestamp}_{uuid8}{ext}
 * 目录格式：{baseDir}/{yyyyMMdd}/
 */
export function saveMediaBuffer(
    channelId: string,
    buffer: Buffer,
    options?: {
        conversationId?: string
        mimeType?: string
        fileName?: string
    }
): { path: string } {
    const baseDir = resolveSessionDir(channelId, options?.conversationId)
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const dir = path.join(baseDir, dateStr)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true})

    const ext = resolveExt(options?.fileName, options?.mimeType)
    const name = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`
    const fp = path.join(dir, name)
    fs.writeFileSync(fp, buffer)

    return {path: fp}
}

// ─── 内部辅助 ────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'audio/wav': '.wav',
    'audio/silk': '.silk',
    'audio/mp3': '.mp3',
    'audio/mpeg': '.mp3',
    'video/mp4': '.mp4',
    'application/octet-stream': '.bin',
}

/**
 * 推断文件扩展名
 * 优先使用 fileName（如 "photo.jpg" → ".jpg"），
 * 其次使用 mimeType 映射，
 * 兜底 ".bin"
 */
function resolveExt(fileName?: string, mimeType?: string): string {
    if (fileName) {
        const fext = path.extname(fileName)
        if (fext) return fext
    }
    if (mimeType) return MIME_TO_EXT[mimeType] || '.bin'
    return '.bin'
}
