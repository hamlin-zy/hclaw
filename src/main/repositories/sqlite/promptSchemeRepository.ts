import crypto from 'crypto'
import {getDatabase, saveDatabase} from './index'
import {createQueryLogger} from './queryLogger'
import type {PromptNodeKey, PromptScheme} from '@shared/types'
import {createDefaultPromptScheme} from '@shared/prompts'

interface SchemeRow {
    id: string
    name: string
    description: string | null
    enabled: number
    created_at: number
    updated_at: number
}

interface NodeRow {
    id: string
    scheme_id: string
    node_key: string
    content: string
}

/** 方案行 → PromptScheme 对象（延迟加载节点） */
function rowToScheme(row: SchemeRow, nodes: Partial<Record<PromptNodeKey, string>>): PromptScheme {
    return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        enabled: row.enabled === 1,
        nodes,
    }
}

/** 批量插入方案的所有节点（先删后插，全量替换） */
function replaceNodes(db: ReturnType<typeof getDatabase>, schemeId: string, nodes: Partial<Record<PromptNodeKey, string>> | undefined, now: number): void {
    db.prepare('DELETE FROM prompt_scheme_nodes WHERE scheme_id = ?').run(schemeId)
    if (!nodes) return

    const stmt = db.prepare(`
        INSERT INTO prompt_scheme_nodes (id, scheme_id, node_key, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const [key, content] of Object.entries(nodes)) {
        if (content) {
            stmt.run(crypto.randomUUID(), schemeId, key, content, now, now)
        }
    }
}

/** 插入一条方案主记录 */
function insertSchemeRow(db: ReturnType<typeof getDatabase>, id: string, scheme: {
    name: string;
    description?: string;
    enabled: boolean
}, now: number): void {
    db.prepare(`
        INSERT INTO prompt_schemes (id, name, description, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, scheme.name, scheme.description ?? null, scheme.enabled ? 1 : 0, now, now)
}

/** 更新一条方案主记录 */
function updateSchemeRow(db: ReturnType<typeof getDatabase>, scheme: PromptScheme, now: number): void {
    db.prepare(`
        UPDATE prompt_schemes SET name = ?, description = ?, enabled = ?, updated_at = ?
        WHERE id = ?
    `).run(scheme.name, scheme.description ?? null, scheme.enabled ? 1 : 0, now, scheme.id)
}

export class SqlitePromptSchemeRepository {
    private log = createQueryLogger('SqlitePromptSchemeRepository')

    list(): PromptScheme[] {
        const start = Date.now()
        try {
            const rows = getDatabase().prepare(`
                SELECT id, name, description, enabled, created_at, updated_at
                FROM prompt_schemes
                ORDER BY created_at ASC
            `).all() as SchemeRow[]

            const result = rows.map(row => rowToScheme(row, this.getNodesBySchemeId(row.id)))
            this.log('list', start, `${result.length} schemes`)
            return result
        } catch {
            return []
        }
    }

    getById(id: string): PromptScheme | null {
        const start = Date.now()
        try {
            const row = getDatabase().prepare(`
                SELECT id, name, description, enabled, created_at, updated_at
                FROM prompt_schemes WHERE id = ?
            `).get(id) as SchemeRow | undefined

            if (!row) return null
            this.log('getById', start, id)
            return rowToScheme(row, this.getNodesBySchemeId(row.id))
        } catch {
            return null
        }
    }

    save(scheme: PromptScheme): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            const now = Date.now()

            const exists = db.prepare('SELECT id FROM prompt_schemes WHERE id = ?').get(scheme.id)
            if (exists) {
                updateSchemeRow(db, scheme, now)
            } else {
                insertSchemeRow(db, scheme.id, scheme, now)
            }

            replaceNodes(db, scheme.id, scheme.nodes, now)
            saveDatabase()
            this.log('save', start, scheme.id)
            return true
        } catch (err) {
            console.error('[SqlitePromptSchemeRepository] save failed:', err)
            return false
        }
    }

    delete(id: string): boolean {
        const start = Date.now()
        try {
            const db = getDatabase()
            db.prepare('DELETE FROM prompt_scheme_nodes WHERE scheme_id = ?').run(id)
            db.prepare('DELETE FROM prompt_schemes WHERE id = ?').run(id)
            saveDatabase()
            this.log('delete', start, id)
            return true
        } catch (err) {
            console.error('[SqlitePromptSchemeRepository] delete failed:', err)
            return false
        }
    }

    private getNodesBySchemeId(schemeId: string): Partial<Record<PromptNodeKey, string>> {
        try {
            const rows = getDatabase().prepare(`
                SELECT node_key, content FROM prompt_scheme_nodes WHERE scheme_id = ?
            `).all(schemeId) as NodeRow[]

            const nodes: Record<string, string> = {}
            for (const row of rows) {
                nodes[row.node_key] = row.content
            }
            return nodes as Partial<Record<PromptNodeKey, string>>
        } catch {
            return {}
        }
    }

    getActiveId(): string | null {
        try {
            const row = getDatabase().prepare('SELECT value FROM system_settings WHERE key = ?').get('activePromptSchemeId') as
                { value: string } | undefined
            return row?.value ?? null
        } catch {
            return null
        }
    }

    setActiveId(id: string | null): void {
        try {
            const db = getDatabase()
            if (id) {
                db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)')
                    .run('activePromptSchemeId', id, Date.now())
            } else {
                db.prepare('DELETE FROM system_settings WHERE key = ?').run('activePromptSchemeId')
            }
            saveDatabase()
        } catch (err) {
            console.error('[SqlitePromptSchemeRepository] setActiveId failed:', err)
        }
    }

    initializeDefaults(): void {
        try {
            const db = getDatabase()
            const now = Date.now()

            // 检查是否已存在名为"默认方案"的方案
            const existing = db.prepare('SELECT id FROM prompt_schemes WHERE name = ?').get('默认方案') as {
                id: string
            } | undefined

            if (existing) {
                // 检查已有方案是否缺少节点（可能是旧版升级或数据被清除）
                const nodeCount = db.prepare('SELECT COUNT(*) as cnt FROM prompt_scheme_nodes WHERE scheme_id = ?').get(existing.id) as {
                    cnt: number
                }
                const defaultScheme = createDefaultPromptScheme('默认方案', '系统默认提示词方案')
                const expectedNodeCount = Object.keys(defaultScheme.nodes).length

                if (nodeCount.cnt < expectedNodeCount) {
                    console.log(`[PromptScheme] 默认方案缺少节点（现有${nodeCount.cnt}，应有${expectedNodeCount}），补全中...`)
                    replaceNodes(db, existing.id, defaultScheme.nodes, now)
                    saveDatabase()
                }
                return
            }

            // 无"默认方案"时用最新代码默认值创建（不清除用户自定义的其他方案）
            const defaultScheme = createDefaultPromptScheme('默认方案', '系统默认提示词方案')
            const id = crypto.randomUUID()

            insertSchemeRow(db, id, defaultScheme, now)
            replaceNodes(db, id, defaultScheme.nodes, now)
            this.setActiveId(id)
            saveDatabase()
        } catch (err) {
            console.error('[PromptScheme] 初始化默认方案失败:', err)
        }
    }
}

export const promptSchemeRepo = new SqlitePromptSchemeRepository()
