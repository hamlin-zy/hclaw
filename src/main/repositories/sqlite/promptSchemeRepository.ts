import crypto from 'crypto'
import {getDatabase, saveDatabase} from './index'
import {createQueryLogger} from './queryLogger'
import type {PromptNodeKey, PromptScheme} from '@shared/types'
import {createDefaultPromptScheme} from '@shared/prompts'
import {PROMPT_NODE_MIGRATIONS, runPromptNodeMigrations} from '../../agent/prompts/promptDefaultUpgrade'

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

/**
 * 只补入缺失节点（不 DELETE、不覆盖既有节点），避免清掉用户对该方案其它节点的自定义。
 * @returns 实际插入的节点数
 */
function insertMissingNodes(db: ReturnType<typeof getDatabase>, schemeId: string, nodes: Partial<Record<PromptNodeKey, string>> | undefined, now: number): number {
    if (!nodes) return 0

    const existingKeys = new Set(
        (db.prepare('SELECT node_key FROM prompt_scheme_nodes WHERE scheme_id = ?').all(schemeId) as { node_key: string }[])
            .map(row => row.node_key),
    )

    const stmt = db.prepare(`
        INSERT INTO prompt_scheme_nodes (id, scheme_id, node_key, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `)
    let inserted = 0
    for (const [key, content] of Object.entries(nodes)) {
        if (!content || existingKeys.has(key)) continue
        stmt.run(crypto.randomUUID(), schemeId, key, content, now, now)
        inserted++
    }
    return inserted
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
                    const inserted = insertMissingNodes(db, existing.id, defaultScheme.nodes, now)
                    if (inserted > 0) saveDatabase()
                }
            } else {
                // 无"默认方案"时用最新代码默认值创建（不清除用户自定义的其他方案）
                const defaultScheme = createDefaultPromptScheme('默认方案', '系统默认提示词方案')
                const id = crypto.randomUUID()

                insertSchemeRow(db, id, defaultScheme, now)
                replaceNodes(db, id, defaultScheme.nodes, now)
                this.setActiveId(id)
                saveDatabase()
            }

            // 所有分支之后：对已有方案节点套用默认值升级迁移（老用户快照覆盖的最新化）
            this.applyNodeMigrations(db, now)
        } catch (err) {
            console.error('[PromptScheme] 初始化默认方案失败:', err)
        }
    }

    /**
     * 遍历全部方案的已有节点，按注册表套用默认值迁移。
     * 只处理**已存在**的行（不凭空创建节点）；单方案/单节点失败不阻断启动（整体 try/catch）。
     */
    private applyNodeMigrations(db: ReturnType<typeof getDatabase>, now: number): void {
        try {
            const nodeKeys = [...new Set(PROMPT_NODE_MIGRATIONS.map(migration => migration.nodeKey))]
            if (nodeKeys.length === 0) return

            const schemes = db.prepare('SELECT id FROM prompt_schemes').all() as { id: string }[]
            const selectNode = db.prepare('SELECT id, content FROM prompt_scheme_nodes WHERE scheme_id = ? AND node_key = ?')
            const updateNode = db.prepare('UPDATE prompt_scheme_nodes SET content = ?, updated_at = ? WHERE id = ?')

            let changed = false
            for (const scheme of schemes) {
                for (const nodeKey of nodeKeys) {
                    const row = selectNode.get(scheme.id, nodeKey) as { id: string; content: string } | undefined
                    if (!row) continue

                    const result = runPromptNodeMigrations(nodeKey, row.content)
                    if (result.applied.length === 0 || result.content === row.content) continue

                    updateNode.run(result.content, now, row.id)
                    changed = true
                    console.log(`[PromptScheme] 节点 ${nodeKey} 应用默认值迁移: ${result.applied.join(', ')}`)
                }
            }

            if (changed) saveDatabase()
        } catch (err) {
            console.error('[PromptScheme] 节点默认值迁移失败:', err)
        }
    }
}

export const promptSchemeRepo = new SqlitePromptSchemeRepository()
