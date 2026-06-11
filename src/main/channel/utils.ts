/**
 * Channel module utilities
 *
 * Shared utility functions and helpers for the channel module.
 */

import {getDatabase, saveDatabase} from '../repositories/sqlite'
import {logger} from '../agent/logger'
import type {ChannelConfig, ChannelRecord, ChannelRow} from './types'

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

/**
 * Convert raw database row to ChannelRecord
 */
export function rowToChannelRecord(row: ChannelRow): ChannelRecord {
    return {
        id: row.id,
        name: row.name,
        type: row.type as ChannelRecord['type'],
        enabled: Boolean(row.enabled),
        config: JSON.parse(row.config || '{}') as ChannelConfig,
        status: row.status as ChannelRecord['status'],
        statusMessage: row.status_message || '',
        lastConnectedAt: row.last_connected_at || null,
        errorCount: row.error_count || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

/**
 * Save channel record to database
 */
export function saveChannelRecord(
    id: string,
    data: Partial<ChannelRecord> & { name: string; type: string },
    existing?: ChannelRecord
): boolean {
    return withDb('saveChannelRecord', () => {
        const now = Date.now()

        if (existing) {
            const sets: string[] = ['updated_at = ?']
            const vals: unknown[] = [now]

            const fieldMap: [string, keyof ChannelRecord][] = [
                ['name', 'name'],
                ['type', 'type'],
                ['enabled', 'enabled'],
                ['config', 'config'],
                ['status', 'status'],
                ['status_message', 'statusMessage'],
                ['last_connected_at', 'lastConnectedAt'],
                ['error_count', 'errorCount'],
            ]

            for (const [col, key] of fieldMap) {
                if (data[key] !== undefined) {
                    sets.push(`${col} = ?`)
                    if (key === 'config') {
                        vals.push(JSON.stringify(data.config))
                    } else if (key === 'enabled') {
                        vals.push(data.enabled ? 1 : 0)
                    } else {
                        vals.push(data[key as keyof typeof data])
                    }
                }
            }

            vals.push(id)
            getDatabase()
                .prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`)
                .run(...vals)
        } else {
            getDatabase()
                .prepare(
                    `INSERT INTO channels (id, name, type, config, enabled, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    id,
                    data.name,
                    data.type,
                    JSON.stringify(data.config || {}),
                    data.enabled ? 1 : 0,
                    data.status || 'disconnected',
                    now,
                    now
                )
        }

        saveDatabase()
        return true
    }, false)
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

/**
 * Build user content string with text and attachments
 */
export function buildUserContent(text: string, attachments: Array<{ path: string; name: string }>): string {
    if (!attachments.length) return text

    const {audio, image, other} = processAttachments(attachments)

    const sections: string[] = []

    if (audio.length) {
        sections.push(`--- 语音消息 ---\n${audio.join('\n\n')}\n---`)
    }
    if (image.length) {
        sections.push(`--- 图片 ---\n${image.join('\n\n')}\n---`)
    }
    if (other.length) {
        sections.push(`--- 附件 ---\n${other.join('\n\n')}\n---`)
    }

    return text ? `${text}\n\n${sections.join('\n\n')}` : sections.join('\n\n')
}

// ─── ID Generation ────────────────────────────────────────

/**
 * Generate a unique binding ID
 */
export function generateBindingId(channelId: string, channelUserId: string): string {
    return `${channelId}_${channelUserId}_${Date.now()}`
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
 * 检查附件列表中是否包含图片/文件/文档等非音频附件
 */
export function hasNonAudioAttachment(attachments: Array<{ path: string; name: string }>): boolean {
    return attachments.some(a => {
        const ext = getExt(a.path || a.name)
        return !AUDIO_EXT_SET.has(ext)
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
