/**
 * 一次性迁移：从 SQLite 迁移 MCP 和 Hook 配置到 JSON 文件。
 *
 * 调用时机：在 app.on('ready') 中、mcpService.initialize() 之前，
 * 确保旧 SQLite 数据被复制到 mcp.json / hooks.json。
 *
 * 迁移完成后，SQLite 中的旧数据保留不删除（回滚备用）。
 * mcpConfig.ts / hookConfig.ts 不再包含 SQLite 依赖。
 */

import {getDatabase} from '../repositories/sqlite'
import type {McpServer} from '../../shared/types/mcp'
import type {HookDefinition} from './hookConfig'
import {getHookConfigPath, writeHookConfig} from './hookConfig'
import {getMcpConfigPath, writeMcpConfig} from './mcpConfig'
import fs from 'fs'

/** 从 SQLite mcps 表迁移到 mcp.json */
export function migrateMcpFromSqlite(): void {
    const jsonPath = getMcpConfigPath()
    if (fs.existsSync(jsonPath)) return // 已有 JSON，跳过

    try {
        const db = getDatabase()
        const hasMcpsTable = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='mcps'"
        ).get()
        if (!hasMcpsTable) return

        const rows = db.prepare(`
      SELECT id, name, transport, command, args, env, url, headers,
             cwd, timeout, auto_approve, deny_list, user_description, enabled
      FROM mcps ORDER BY name ASC
    `).all() as any[]

        if (rows.length === 0) return

        const servers: McpServer[] = rows.map((row: any) => ({
            id: row.id,
            name: row.name,
            transport: row.transport,
            command: row.command,
            args: JSON.parse(row.args || '[]'),
            env: JSON.parse(row.env || '{}'),
            url: row.url || '',
            headers: JSON.parse(row.headers || '{}'),
            cwd: row.cwd || '',
            timeout: row.timeout ?? 60000,
            autoApprove: JSON.parse(row.auto_approve || '[]'),
            denyList: JSON.parse(row.deny_list || '[]'),
            userDescription: row.user_description || '',
            enabled: row.enabled === 1,
        }))

        writeMcpConfig(servers)
        console.log('[Migrate] 已从 SQLite 迁移', servers.length, '条 MCP 配置到 mcp.json')
    } catch (err) {
        console.error('[Migrate] MCP SQLite 迁移失败:', err)
    }
}

/** 从 SQLite hooks 表迁移到 hooks.json */
export function migrateHooksFromSqlite(): void {
    const jsonPath = getHookConfigPath()
    if (fs.existsSync(jsonPath)) return // 已有 JSON，跳过

    try {
        const db = getDatabase()
        const hasHooksTable = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='hooks'"
        ).get()
        if (!hasHooksTable) return

        const rows = db.prepare('SELECT * FROM hooks ORDER BY updated_at DESC').all() as any[]
        if (rows.length === 0) return

        const hooks: HookDefinition[] = rows.map((row: any) => {
            let events: string[] = []
            try {
                events = JSON.parse(row.events);
                if (!Array.isArray(events)) events = [events]
            } catch {
                events = []
            }
            let config: Record<string, unknown> = {}
            try {
                config = JSON.parse(row.config)
            } catch {
                config = {}
            }

            return {
                id: row.id,
                name: row.name,
                description: row.description || '',
                events,
                config,
                enabled: row.enabled === 1,
                source: row.source as 'builtin' | 'user' | 'plugin' || 'user',
                pluginName: row.plugin_name || undefined,
                createdAt: row.created_at || Date.now(),
                updatedAt: row.updated_at || Date.now(),
            }
        })

        writeHookConfig(hooks)
        console.log('[Migrate] 已从 SQLite 迁移', hooks.length, '条 Hook 配置到 hooks.json')
    } catch (err) {
        console.error('[Migrate] Hook SQLite 迁移失败:', err)
    }
}
