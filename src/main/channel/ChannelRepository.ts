// src/main/channel/ChannelRepository.ts
// 严格遵循 ScheduleRepository 的模式

import {getDatabase, saveDatabase} from '../repositories/sqlite'
import {logger} from '../agent/logger'
import type {ChannelBindingRecord, ChannelRecord} from './types'

function withDb<T>(name: string, fn: () => T, fallback: T): T {
    try {
        return fn()
    } catch (err) {
        logger.error('ChannelRepository.' + name, { error: (err as Error)?.message || err });
        return fallback
    }
}

export class ChannelRepository {
    private rowToRecord(row: any): ChannelRecord {
        return {
            id: row.id, name: row.name, type: row.type,
            enabled: !!row.enabled,
            config: JSON.parse(row.config || '{}'),
            status: row.status, statusMessage: row.status_message || '',
            lastConnectedAt: row.last_connected_at || null,
            errorCount: row.error_count || 0,
            createdAt: row.created_at, updatedAt: row.updated_at,
        }
    }

    // ─── Channels CRUD ──────────────────────────────────

    list(): ChannelRecord[] {
        return withDb('list', () =>
            (getDatabase().prepare('SELECT * FROM channels ORDER BY type').all() as any[])
                .map(r => this.rowToRecord(r)), [])
    }

    get(id: string): ChannelRecord | null {
        return withDb('get', () => {
            const row = getDatabase().prepare('SELECT * FROM channels WHERE id = ?').get(id) as any
            return row ? this.rowToRecord(row) : null
        }, null)
    }

    upsert(id: string, data: Partial<ChannelRecord> & { name: string; type: string }): boolean {
        return withDb('upsert', () => {
            const existing = this.get(id)
            const now = Date.now()
            if (existing) {
                const sets: string[] = ['updated_at = ?']
                const vals: any[] = [now]
                const fields: [string, keyof ChannelRecord][] = [
                    ['name', 'name'], ['type', 'type'], ['enabled', 'enabled'],
                    ['config', 'config'], ['status', 'status'], ['status_message', 'statusMessage'],
                    ['last_connected_at', 'lastConnectedAt'], ['error_count', 'errorCount'],
                ]
                for (const [col, key] of fields) {
                    if (data[key] !== undefined) {
                        if (key === 'config') {
                            sets.push(`${col} = ?`);
                            vals.push(JSON.stringify(data.config))
                        } else if (key === 'enabled') {
                            sets.push(`${col} = ?`);
                            vals.push(data.enabled ? 1 : 0)
                        } else {
                            sets.push(`${col} = ?`);
                            vals.push(data[key as keyof typeof data])
                        }
                    }
                }
                vals.push(id)
                getDatabase().prepare(`UPDATE channels
                                       SET ${sets.join(', ')}
                                       WHERE id = ?`).run(...vals)
            } else {
                getDatabase().prepare(`INSERT INTO channels (id, name, type, config, enabled, status, created_at, updated_at)
                                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(id, data.name, data.type, JSON.stringify(data.config || {}),
                        data.enabled ? 1 : 0, data.status || 'disconnected', now, now)
            }
            saveDatabase()
            return true
        }, false)
    }

    /**
     * 按 type 查找已存在的渠道记录
     * 用于"保存配置"时与 seedDefaults 固定 ID 对齐，避免 create 生成随机 ID
     */
    getByType(type: string): ChannelRecord | null {
        return withDb('getByType', () => {
            const row = getDatabase().prepare('SELECT * FROM channels WHERE type = ?').get(type) as any
            return row ? this.rowToRecord(row) : null
        }, null)
    }

    delete(id: string): boolean {
        return withDb('delete', () => {
            getDatabase().prepare('DELETE FROM channels WHERE id = ?').run(id)
            saveDatabase()
            return true
        }, false)
    }

    /** 启动时重置所有渠道状态为 disconnected，避免残留旧 session 的 connected 状态 */
    resetAllStatuses(): void {
        withDb('resetAllStatuses', () => {
            getDatabase().prepare(
                "UPDATE channels SET status = 'disconnected', status_message = '', updated_at = ? WHERE status != 'disconnected'"
            ).run(Date.now())
            saveDatabase()
        }, undefined)
    }

    /** 启动时重置未配置渠道为禁用+断开：config 为空且从未连接过的渠道归零 */

    resetUnconfiguredChannels(): void {
        withDb('resetUnconfiguredChannels', () => {
            getDatabase().prepare(
                "UPDATE channels SET enabled = 0, status = 'disconnected', status_message = '', updated_at = ? WHERE config = '{}' AND last_connected_at IS NULL"
            ).run(Date.now())
            saveDatabase()
        }, undefined)
    }

    /** 在首次启动时插入默认记录（四个渠道占位） */
    seedDefaults(): void {
        const defaults = [
            {id: 'feishu' as const, name: '飞书', type: 'feishu' as const},

            {id: 'wechat' as const, name: '个人微信', type: 'wechat' as const},
        ]
        for (const d of defaults) {
            if (!this.get(d.id)) {
                this.upsert(d.id, {...d, enabled: false})
            }
        }
    }

    // ─── Bindings ───────────────────────────────────────

    /** 获取指定渠道的所有活跃绑定用户 */
    getActiveBindings(channelId: string): ChannelBindingRecord[] {
        return withDb('getActiveBindings', () => {
            const rows = getDatabase().prepare(
                'SELECT * FROM channel_bindings WHERE channel_id = ? AND is_active = 1 ORDER BY updated_at DESC'
            ).all(channelId) as any[]
            return rows.map(r => ({
                id: r.id, channelId: r.channel_id, channelUserId: r.channel_key,
                conversationId: r.conversation_id, isActive: !!r.is_active,
                createdAt: r.created_at, updatedAt: r.updated_at,
            }))
        }, [])
    }

    getBinding(channelId: string, channelUserId: string): ChannelBindingRecord | null {
        return withDb('getBinding', () => {
            const row = getDatabase().prepare(
                'SELECT * FROM channel_bindings WHERE channel_id = ? AND channel_key = ? ORDER BY updated_at DESC LIMIT 1'
            ).get(channelId, channelUserId) as any
            if (!row) return null
            return {
                id: row.id, channelId: row.channel_id, channelUserId: row.channel_key,
                conversationId: row.conversation_id, isActive: !!row.is_active,
                createdAt: row.created_at, updatedAt: row.updated_at,
            }
        }, null)
    }

    upsertBinding(channelId: string, channelUserId: string, conversationId: string): boolean {
        return withDb('upsertBinding', () => {
            const existing = getDatabase().prepare(
                'SELECT id FROM channel_bindings WHERE channel_id = ? AND channel_key = ?'
            ).get(channelId, channelUserId) as any
            const now = Date.now()
            if (existing) {
                getDatabase().prepare(
                    'UPDATE channel_bindings SET conversation_id = ?, is_active = 1, updated_at = ? WHERE id = ?'
                ).run(conversationId, now, existing.id)
            } else {
                getDatabase().prepare(
                    'INSERT INTO channel_bindings (id, channel_id, channel_key, conversation_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
                ).run(`${channelId}_${channelUserId}_${now}`, channelId, channelUserId, conversationId, now, now)
            }
            saveDatabase()
            return true
        }, false)
    }
}

export const channelRepo = new ChannelRepository()
