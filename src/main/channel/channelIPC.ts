/**
 * channelIPC — 渠道配置 IPC handlers
 *
 * 职责：
 * - 渠道配置 CRUD（channels 表）
 * - 渠道启停控制
 * - 个人微信扫码登录触发
 */
import {ipcMain} from 'electron'
import {getDatabase, saveDatabase} from '../repositories/sqlite'
import {channelRepo} from './ChannelRepository'
import crypto from 'crypto'
import {logger} from '../agent/logger'
import {channelManager} from './ChannelManager'

interface ChannelRow {
    id: string
    name: string
    type: string
    enabled: number
    config: string
    status: string
    status_message: string
    last_connected_at: number | null
    error_count: number
    created_at: number
    updated_at: number
}

function rowToObj(row: ChannelRow) {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: !!row.enabled,
        config: JSON.parse(row.config || '{}'),
        status: row.status || 'disconnected',
        statusMessage: row.status_message || '',
        lastConnectedAt: row.last_connected_at || null,
        errorCount: row.error_count || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

function withDb<T>(name: string, fn: () => T, fallback: T): T {
    try { return fn() } catch (err) { logger.error('channelIPC.' + name, { error: (err as Error)?.message || err }); return fallback }
}

export function initChannelIPC() {
    // ── CRUD ─────────────────────────────────────────────

    ipcMain.handle('channel-list', () => {
        return withDb('list', () => {
            const rows = getDatabase().prepare(
                'SELECT * FROM channels ORDER BY type ASC'
            ).all() as ChannelRow[]
            return rows.map(rowToObj)
        }, [])
    })

    ipcMain.handle('channel-create', (_e, data: { type: string; name: string; config: Record<string, unknown> }) => {
        return withDb('create', () => {
            // 优先使用 seedDefaults 固定 ID，避免 startWorker 用随机 UUID 找不到记录
            const seedId = channelRepo.getByType(data.type)
            const id = seedId?.id ?? `ch-${crypto.randomUUID()}`
            const now = Date.now()

            if (seedId) {
                // seed 记录已存在 → 更新 config，并将 enabled 设为 1
                channelRepo.upsert(id, {
                    name: data.name,
                    type: seedId.type,
                    enabled: true,  // 保存配置即启用渠道
                    config: data.config || {},
                    status: 'disconnected',
                })
                saveDatabase()
                return {success: true, id}
            }

            // 无 seed 记录 → 全新创建（新建渠道场景，非飞书等内置渠道）
            getDatabase().prepare(`INSERT INTO channels (id, name, type, config, enabled, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, data.name, data.type, JSON.stringify(data.config || {}), 1, 'disconnected', now, now)
            saveDatabase()
            return {success: true, id}
        }, {success: false, id: ''})
    })

    ipcMain.handle('channel-update', (_e, id: string, updates: any) => {
        const result = withDb('update', () => {
            const setClauses: string[] = []
            const vals: any[] = []

            const writes: Array<[string, any]> = [
                ['name', updates.name],
                ['enabled', updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : undefined],
                ['status', updates.status],
                ['status_message', updates.statusMessage],
                ['last_connected_at', updates.lastConnectedAt],
                ['error_count', updates.errorCount],
            ]
            if (updates.config) {
                writes.push(['config', JSON.stringify(updates.config)])
            }

            for (const [field, value] of writes) {
                if (value !== undefined) {
                    setClauses.push(`${field} = ?`)
                    vals.push(value)
                }
            }
            if (setClauses.length === 0) return {success: false}

            vals.push(Date.now(), id)
            getDatabase().prepare(`UPDATE channels SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals)
            saveDatabase()
            return {success: true}
        }, {success: false})

        // enabled 变更后同步 Worker 连接状态
        if (updates.enabled !== undefined) {
            channelManager.notifyConfigChange(id)
        }

        return result
    })

    ipcMain.handle('channel-delete', (_e, id: string) => {
        return withDb('delete', () => {
            getDatabase().prepare('DELETE FROM channels WHERE id = ?').run(id)
            saveDatabase()
            return {success: true}
        }, {success: false})
    })

    // ── 操作 ─────────────────────────────────────────────

    ipcMain.handle('channel-login', async (_e, id: string) => {
        // 个人微信扫码登录：更新状态为 connecting
        return withDb('login', () => {
            getDatabase().prepare(
                'UPDATE channels SET status = ?, status_message = ?, updated_at = ? WHERE id = ?'
            ).run('connecting', '正在等待扫码...', Date.now(), id)
            saveDatabase()
            return {success: true}
        }, {success: false})
    })

    // ── 微信扫码登录 ────────────────────────────────────

    ipcMain.handle('channel-start-wechat-login', async () => {
        try {
            const {startWechatLogin} = await import('./loginWechat')
            const result = await startWechatLogin()
            return {success: true, ...result}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    ipcMain.handle('channel-check-wechat-login', async (_e, sessionKey: string) => {
        try {
            const {checkWechatLogin} = await import('./loginWechat')
            const result = await checkWechatLogin(sessionKey)
            // 登录确认后自动保存到数据库并启动 Worker Thread
            if (result.status === 'confirmed' && result.botToken) {
                const chRow = getDatabase().prepare('SELECT * FROM channels WHERE type = ?').get('wechat') as any
                if (chRow) {
                    const cfg = JSON.parse(chRow.config || '{}')
                    cfg.botToken = result.botToken
                    if (result.accountId) cfg.accountId = result.accountId
                    if (result.baseUrl) cfg.baseUrl = result.baseUrl
                    if (result.userId) cfg.userId = result.userId
                    getDatabase().prepare(
                        'UPDATE channels SET config = ?, enabled = 1, status = ?, status_message = ?, last_connected_at = ?, updated_at = ? WHERE id = ?'
                    ).run(JSON.stringify(cfg), 'connecting', 'Worker connecting...', Date.now(), Date.now(), chRow.id)
                    saveDatabase()

                    // 通过 Worker Thread 启动长轮询（不阻塞主进程）
                    channelManager.connect('wechat').catch((_err: Error) => {
                        getDatabase().prepare(
                            'UPDATE channels SET status = ?, status_message = ?, updated_at = ? WHERE id = ?'
                        ).run('error', `Connection failed`, Date.now(), chRow.id)
                        saveDatabase()
                    })
                }
            }
            return result
        } catch (err: any) {
            return {status: 'error' as const, message: err.message}
        }
    })

    ipcMain.handle('channel-cancel-wechat-login', async (_e, sessionKey: string) => {
        const {cancelWechatLogin} = await import('./loginWechat')
        cancelWechatLogin(sessionKey)
        return {success: true}
    })

    // ── 微信消息 Worker Thread ───────────────────────────

    ipcMain.handle('channel-start-worker', async (_e, channelId: string) => {
        try {
            await channelManager.connect(channelId)
            return {success: true}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    ipcMain.handle('channel-stop-worker', async (_e, channelId: string) => {
        channelManager.disconnect(channelId)
        return {success: true}
    })
}
