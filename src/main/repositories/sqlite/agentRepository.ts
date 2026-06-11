import {getDatabase, saveDatabase} from './index'
import {createQueryLogger} from './queryLogger'

export interface Agent {
    id: string
    name: string
    description: string
    enabled: boolean
    isSystem: boolean
    createdAt?: number
    updatedAt?: number
}

const logQuery = createQueryLogger('SQLite AgentRepository')

export class SqliteAgentRepository {
    /**
     * 获取所有 Agent
     */
    list(): Agent[] {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare(`
        SELECT id, name, description, enabled, is_system, created_at, updated_at
        FROM agents
        ORDER BY name ASC
      `)
            const rows = stmt.all() as Array<{
                id: string
                name: string
                description: string
                enabled: number
                is_system: number
                created_at: number
                updated_at: number
            }>
            const agents = rows.map(row => ({
                id: row.id,
                name: row.name,
                description: row.description,
                enabled: row.enabled === 1,
                isSystem: row.is_system === 1,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }))
            logQuery('list', start, `${agents.length} agents`)
            return agents
        } catch (err) {
            console.error('[SqliteAgentRepository] list failed:', err)
            return []
        }
    }

    /**
     * 根据 ID 获取 Agent
     */
    getById(id: string): Agent | null {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare(`
        SELECT id, name, description, enabled, is_system, created_at, updated_at
        FROM agents
        WHERE id = ?
      `)
            const row = stmt.get(id) as {
                id: string
                name: string
                description: string
                enabled: number
                is_system: number
                created_at: number
                updated_at: number
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                name: row.name,
                description: row.description,
                enabled: row.enabled === 1,
                isSystem: row.is_system === 1,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }
        } catch (err) {
            console.error('[SqliteAgentRepository] getById failed:', err)
            return null
        }
    }

    /**
     * 根据名称获取 Agent
     */
    getByName(name: string): Agent | null {
        const start = Date.now()
        try {
            const db = getDatabase()
            const stmt = db.prepare(`
        SELECT id, name, description, enabled, is_system, created_at, updated_at
        FROM agents
        WHERE name = ?
      `)
            const row = stmt.get(name) as {
                id: string
                name: string
                description: string
                enabled: number
                is_system: number
                created_at: number
                updated_at: number
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                name: row.name,
                description: row.description,
                enabled: row.enabled === 1,
                isSystem: row.is_system === 1,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }
        } catch (err) {
            console.error('[SqliteAgentRepository] getByName failed:', err)
            return null
        }
    }

    /**
     * 保存所有 Agent（批量替换）
     */
    save(agents: Agent[]): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const now = Date.now()

            // 清空现有数据
            db.exec('DELETE FROM agents')

            const stmt = db.prepare(`
        INSERT INTO agents (id, name, description, enabled, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

            for (const agent of agents) {
                stmt.run(
                    agent.id,
                    agent.name,
                    agent.description || '',
                    agent.enabled ? 1 : 0,
                    agent.isSystem ? 1 : 0,
                    agent.createdAt || now,
                    agent.updatedAt || now
                )
            }

            saveDatabase()
            logQuery('save', start, `${agents.length} agents`)
            return true
        } catch (err) {
            console.error('[SqliteAgentRepository] save failed:', err)
            return false
        }
    }

    /**
     * 设置 Agent 启用/禁用状态
     */
    setEnabled(id: string, enabled: boolean): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const now = Date.now()
            const stmt = db.prepare('UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?')
            stmt.run(enabled ? 1 : 0, now, id)
            saveDatabase()
            logQuery('setEnabled', start)
            return true
        } catch (err) {
            console.error('[SqliteAgentRepository] setEnabled failed:', err)
            return false
        }
    }
}

export const agentRepo = new SqliteAgentRepository()
