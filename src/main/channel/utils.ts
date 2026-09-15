/**
 * Channel module utilities
 *
 * Shared utility functions and helpers for the channel module.
 */

import {logger} from '../agent/logger'

// ─── Database Helpers ─────────────────────────────────────

/**
 * Wrap database operations with error handling.
 * Returns fallback value on error instead of throwing.
 */
export function withDb<T>(name: string, fn: () => T, fallback: T): T {
    try {
        return fn()
    } catch (err) {
        logger.error('Channel.' + name, { error: (err as Error)?.message || err })
        return fallback
    }
}

// ─── Message Formatting ────────────────────────────────────

/** Attachment types for categorization */
export interface ProcessedAttachments {
    audio: string[]
    image: string[]
    other: string[]
}

/**
 * Process attachments and categorize them for message content
 */
export function processAttachments(
    attachments: Array<{ path: string; name: string }>
): ProcessedAttachments {
    const audio: string[] = []
    const image: string[] = []
    const other: string[] = []

    const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.amr', '.ogg', '.webm', '.flac', '.aac', '.silk'])
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'])

    for (const att of attachments) {
        const ext = att.path ? `.${att.path.split('.').pop()?.toLowerCase()}` : ''
        const isExternal = att.path?.startsWith('http') ?? false

        if (isExternal || IMAGE_EXTENSIONS.has(ext)) {
            image.push(`[图片] 文件: ${att.name}\n路径: ${att.path}`)
        } else if (AUDIO_EXTENSIONS.has(ext)) {
            audio.push(`[语音消息] 文件: ${att.name}\n路径: ${att.path}`)
        } else {
            other.push(`[附件] 文件: ${att.name}\n路径: ${att.path}`)
        }
    }

    return {audio, image, other}
}

// ─── Attachment Classification ─────────────────────────────

const AUDIO_EXT_SET = new Set(['.mp3', '.wav', '.m4a', '.amr', '.ogg', '.flac', '.aac', '.silk'])
const _IMAGE_EXT_SET = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'])

function getExt(path: string): string {
    return `.${path.split('.').pop()?.toLowerCase() || ''}`
}

/**
 * 检查附件列表中是否包含音频文件
 */
export function hasAudioAttachment(attachments: Array<{ path: string; name: string }>): boolean {
    return attachments.some(a => {
        const ext = getExt(a.path || a.name)
        return AUDIO_EXT_SET.has(ext)
    })
}

/**
 * 判断消息是否只有附件标记（没有用户实际输入的文字内容）
 * 纯附件消息如：msg.text="[图片]" 或 "[语音消息 9:09]" 或 "[文件: xxx.pdf]"
 */
export function isAttachmentOnlyMarker(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return true
    // 检查每一行是否都以 [ 开头（附件标记）
    const lines = trimmed.split('\n').filter(l => l.trim())
    if (lines.length === 0) return true
    return lines.every(l => /^\[.*?\]/.test(l.trim()))
}
