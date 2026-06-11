import {getDatabase, saveDatabase} from './index'

export interface ToolRecord {
    id: string
    name: string
    description: string
    enabled: boolean
    /** 超时时间（毫秒），null 表示使用默认值 */
    timeout: number | null
}

/** 工具超时默认值映射 */
const DEFAULT_TIMEOUTS: Record<string, number> = {
    bash: 30000,
    web_fetch: 15000,
    // agent：30 分钟 — 子 Agent 内部有独立的超时保护（默认 15 分钟），
    // executor 外层超时仅作兜底，必须远大于子 Agent 内部超时，避免被提前截杀
    agent: 1800000,
    // skill：5 分钟 — 技能可能包含脚本执行，需要足够时间
    skill: 300000,
    // ask_user：24 小时 — 等待用户输入，不应因超时而自动继续执行
    ask_user: 86400000,
    // 其他工具默认使用 60 秒
}

/**
 * 获取工具的默认超时时间
 */
export function getToolDefaultTimeout(toolId: string): number {
    return DEFAULT_TIMEOUTS[toolId] ?? 60000
}

/**
 * 获取工具的超时时间（优先使用数据库配置，否则使用默认值）
 */
export function getToolTimeout(toolId: string, dbTimeout: number | null | undefined): number {
    return dbTimeout ?? getToolDefaultTimeout(toolId)
}

export class SqliteToolRepository {
    /**
     * 获取所有工具记录
     */
    list(): ToolRecord[] {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`
                SELECT id, name, description, enabled, timeout
                FROM tools
                ORDER BY name ASC
            `)
            const rows = stmt.all() as Array<{
                id: string
                name: string
                description: string
                enabled: number
                timeout: number | null
            }>
            return rows.map(row => ({
                id: row.id,
                name: row.name,
                description: row.description,
                enabled: row.enabled === 1,
                timeout: row.timeout ?? null,
            }))
        } catch (err) {
            console.error('[SqliteToolRepository] list failed:', err)
            return []
        }
    }

    /**
     * 获取所有工具的启用状态映射（id -> enabled）
     * 数据库中不存在的工具返回 undefined
     */
    getAllToolEnabledMap(): Map<string, boolean> {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`SELECT id, enabled FROM tools`)
            const rows = stmt.all() as Array<{ id: string; enabled: number }>
            return new Map(rows.map(r => [r.id, r.enabled === 1]))
        } catch (err) {
            console.error('[SqliteToolRepository] getAllToolEnabledMap failed:', err)
            return new Map()
        }
    }

    /**
     * 获取已启用的工具 ID 列表
     */
    getEnabledToolIds(): Set<string> {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`SELECT id FROM tools WHERE enabled = 1`)
            const rows = stmt.all() as Array<{ id: string }>
            return new Set(rows.map(r => r.id))
        } catch (err) {
            console.error('[SqliteToolRepository] getEnabledToolIds failed:', err)
            return new Set()
        }
    }

    /**
     * 获取单个工具的启用状态
     */
    isEnabled(toolId: string): boolean {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`SELECT enabled FROM tools WHERE id = ?`)
            const row = stmt.get(toolId) as { enabled: number } | undefined
            return row ? row.enabled === 1 : true // 默认启用
        } catch (err) {
            console.error('[SqliteToolRepository] isEnabled failed:', err)
            return true
        }
    }

    /**
     * 设置工具启用状态
     */
    setEnabled(toolId: string, enabled: boolean): boolean {
        try {
            const db = getDatabase()
            const now = Date.now()
            const stmt = db.prepare(`
                INSERT INTO tools (id, name, description, enabled, created_at, updated_at)
                VALUES (?, ?, '', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET enabled = ?, updated_at = ?
            `)
            stmt.run(toolId, toolId, enabled ? 1 : 0, now, now, enabled ? 1 : 0, now)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteToolRepository] setEnabled failed:', err)
            return false
        }
    }

    /**
     * 批量设置工具启用状态
     */
    setEnabledBatch(updates: Array<{ id: string; enabled: boolean }>): boolean {
        try {
            const db = getDatabase()
            const now = Date.now()
            const stmt = db.prepare(`
                INSERT INTO tools (id, name, description, enabled, created_at, updated_at)
                VALUES (?, ?, '', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET enabled = ?, updated_at = ?
            `)

            const transaction = db.transaction(() => {
                for (const { id, enabled } of updates) {
                    stmt.run(id, id, enabled ? 1 : 0, now, now, enabled ? 1 : 0, now)
                }
            })
            transaction()
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteToolRepository] setEnabledBatch failed:', err)
            return false
        }
    }

    /**
     * 获取单个工具的超时时间
     */
    getTimeout(toolId: string): number | null {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`SELECT timeout FROM tools WHERE id = ?`)
            const row = stmt.get(toolId) as { timeout: number | null } | undefined
            return row?.timeout ?? null
        } catch (err) {
            console.error('[SqliteToolRepository] getTimeout failed:', err)
            return null
        }
    }

    /**
     * 设置工具超时时间
     * @param toolId 工具 ID
     * @param timeout 超时时间（毫秒），null 表示使用默认值
     */
    setTimeout(toolId: string, timeout: number | null): boolean {
        try {
            const db = getDatabase()
            const now = Date.now()
            const stmt = db.prepare(`
                INSERT INTO tools (id, name, description, enabled, timeout, created_at, updated_at)
                VALUES (?, ?, '', 1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET timeout = ?, updated_at = ?
            `)
            stmt.run(toolId, toolId, timeout, now, now, timeout, now)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteToolRepository] setTimeout failed:', err)
            return false
        }
    }

    /**
     * 获取所有工具的超时时间映射（id -> timeout）
     */
    getAllToolTimeoutMap(): Map<string, number> {
        try {
            const db = getDatabase()
            const stmt = db.prepare(`SELECT id, timeout FROM tools`)
            const rows = stmt.all() as Array<{ id: string; timeout: number | null }>
            const result = new Map<string, number>()
            for (const row of rows) {
                if (row.timeout !== null) {
                    result.set(row.id, row.timeout)
                }
            }
            return result
        } catch (err) {
            console.error('[SqliteToolRepository] getAllToolTimeoutMap failed:', err)
            return new Map()
        }
    }
}

export const toolRepo = new SqliteToolRepository()
