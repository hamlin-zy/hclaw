/**
 * 用户命令存储（精简版）
 *
 * 用户命令（source='user'）已迁移到文件系统（~/.hclaw/commands/），
 * 本模块仅保留插件命令的 override 管理（source='plugin'）。
 */

import {getDatabase, saveDatabase} from '../repositories/sqlite/index'

export interface UserCommandRow {
    id: string
    name: string
    description: string | null
    content: string
    args: string
    tags: string
    enabled: number
    trigger_type: string
    trigger_target: string | null
    source: string
    plugin_command_id: string | null
    created_at: number
    updated_at: number
}

export interface UserCommandData {
    id: string
    name: string
    description?: string
    content: string
    args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
    tags?: string[]
    enabled: boolean
    triggerType?: 'none' | 'skill' | 'agent'
    triggerTarget?: string
    source?: 'user' | 'plugin'
    pluginCommandId?: string
    createdAt: number
    updatedAt: number
}

export interface UpsertPluginOverrideInput {
    pluginCommandId: string  // e.g., "my-plugin:explain"
    name: string
    description?: string
    content?: string
    args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
    enabled: boolean
    tags?: string[]
}

// ─── 内部辅助 ─────────────────────────────────────

/** 从命令 ID 中提取名称部分（去除命名空间前缀） */
export function extractCommandName(cmdId: string): string {
    const idx = cmdId.indexOf(':')
    return idx >= 0 ? cmdId.slice(idx + 1) : cmdId
}

/**
 * 构建 UPDATE 的 SET 子句和参数列表
 */
function buildSetClause(
    fields: Record<string, unknown | undefined>,
    extraValues: unknown[] = []
): { clause: string; values: unknown[] } {
    const clauses: string[] = []
    const values: unknown[] = [...extraValues]
    for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined) {
            clauses.push(`${field} = ?`)
            values.push(value)
        }
    }
    return {clause: clauses.join(', '), values}
}

class UserCommandStore {
    // ─── 插件命令 Override ──────────────────────────────

    /**
     * 获取所有插件命令覆盖记录
     */
    getPluginOverrides(): UserCommandData[] {
        const db = getDatabase()
        const rows = db.prepare("SELECT * FROM user_commands WHERE source = 'plugin' ORDER BY name ASC").all() as UserCommandRow[]
        return rows.map(row => this.rowToData(row))
    }

    /**
     * 获取指定插件命令的覆盖记录
     */
    getPluginOverride(pluginCommandId: string): UserCommandData | null {
        const db = getDatabase()
        const row = db.prepare(
            "SELECT * FROM user_commands WHERE plugin_command_id = ? AND source = 'plugin'"
        ).get(pluginCommandId) as UserCommandRow | undefined
        return row ? this.rowToData(row) : null
    }

    /**
     * 创建或更新插件命令覆盖
     */
    upsertPluginOverride(input: UpsertPluginOverrideInput): UserCommandData {
        const db = getDatabase()
        const id = `plugin-override:${input.pluginCommandId}`
        const now = Date.now()
        const exists = !!db.prepare("SELECT 1 FROM user_commands WHERE id = ?").get(id)

        if (exists) {
            const {clause, values} = buildSetClause(
                {
                    name: input.name,
                    updated_at: now,
                    content: input.content,
                    description: input.description !== undefined ? (input.description || null) : undefined,
                    args: input.args !== undefined ? JSON.stringify(input.args) : undefined,
                    tags: input.tags !== undefined ? JSON.stringify(input.tags) : undefined,
                    enabled: input.enabled ? 1 : 0,
                },
            )
            db.prepare(`UPDATE user_commands SET ${clause} WHERE id = ?`).run(...values, id)
        } else {
            db.prepare(`
                INSERT INTO user_commands (id, name, description, content, args, tags, enabled, source, plugin_command_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'plugin', ?, ?, ?)
            `).run(
                id, input.name,
                input.description || null,
                input.content || '',
                JSON.stringify(input.args || []),
                JSON.stringify(input.tags || []),
                input.enabled ? 1 : 0,
                input.pluginCommandId,
                now, now
            )
        }

        saveDatabase()
        return this.getById(id)!
    }

    /**
     * 删除插件命令覆盖
     */
    deletePluginOverride(pluginCommandId: string): boolean {
        const db = getDatabase()
        const id = `plugin-override:${pluginCommandId}`
        const result = db.prepare("DELETE FROM user_commands WHERE id = ? AND source = 'plugin'").run(id)
        if (result.changes > 0) {
            saveDatabase()
            return true
        }
        return false
    }

    // ─── 通用查询（被插件 override 使用） ────────────────

    /**
     * 获取所有命令记录（按来源过滤）
     */
    getAll(source?: 'user' | 'plugin'): UserCommandData[] {
        const db = getDatabase()
        const sql = source
            ? 'SELECT * FROM user_commands WHERE source = ? ORDER BY created_at DESC'
            : 'SELECT * FROM user_commands ORDER BY created_at DESC'
        const rows = db.prepare(sql).all(...(source ? [source] : [])) as UserCommandRow[]
        return rows.map(row => this.rowToData(row))
    }

    /**
     * 根据 ID 查找命令
     */
    getById(id: string): UserCommandData | null {
        const db = getDatabase()
        const row = db.prepare('SELECT * FROM user_commands WHERE id = ?').get(id) as UserCommandRow | undefined
        return row ? this.rowToData(row) : null
    }

    // ─── 内部方法 ─────────────────────────────────────

    private rowToData(row: UserCommandRow): UserCommandData {
        return {
            id: row.id,
            name: row.name,
            description: row.description || undefined,
            content: row.content,
            args: JSON.parse(row.args || '[]'),
            tags: JSON.parse(row.tags || '[]'),
            enabled: row.enabled === 1,
            triggerType: (row.trigger_type as UserCommandData['triggerType']) || 'none',
            triggerTarget: row.trigger_target || undefined,
            source: row.source as 'user' | 'plugin' | undefined,
            pluginCommandId: row.plugin_command_id || undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }
    }
}

// ─── 单例 ─────────────────────────────────────────────

let _store: UserCommandStore | null = null

export function getUserCommandStore(): UserCommandStore {
    if (!_store) {
        _store = new UserCommandStore()
    }
    return _store
}

export {UserCommandStore}
