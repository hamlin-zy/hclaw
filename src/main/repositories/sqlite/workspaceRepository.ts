import {getDatabase, saveDatabase} from './index'
import {systemSettingsRepo} from './systemSettingsRepository'

export interface Workspace {
    id: string
    path: string
    name: string
    createdAt: number
    updatedAt: number
}

const CURRENT_WORKSPACE_KEY = 'currentWorkspaceId'

export class SqliteWorkspaceRepository {
    /**
     * 创建工作目录
     */
    create(id: string, workspacePath: string, name: string): boolean {
        try {
            const db = getDatabase()
            const now = Date.now()
            const stmt = db.prepare(
                'INSERT OR REPLACE INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
            )
            stmt.run(id, workspacePath, name, now, now)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] create failed:', err)
            return false
        }
    }

    /**
     * 根据 ID 获取工作目录
     */
    getById(id: string): Workspace | null {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at FROM workspaces WHERE id = ?')
            const row = stmt.get(id) as {
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                path: row.path,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] getById failed:', err)
            return null
        }
    }

    /**
     * 根据路径获取工作目录
     */
    getByPath(workspacePath: string): Workspace | null {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at FROM workspaces WHERE path = ?')
            const row = stmt.get(workspacePath) as {
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                path: row.path,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] getByPath failed:', err)
            return null
        }
    }

    /**
     * 获取所有工作目录
     */
    list(): Workspace[] {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC')
            const rows = stmt.all() as Array<{
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number
            }>
            return rows.map(row => ({
                id: row.id,
                path: row.path,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            }))
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] list failed:', err)
            return []
        }
    }

    /**
     * 更新工作目录
     */
    update(id: string, updates: Partial<Pick<Workspace, 'path' | 'name'>>): boolean {
        try {
            const existing = this.getById(id)
            if (!existing) return false

            const db = getDatabase()
            const now = Date.now()
            const path = updates.path ?? existing.path
            const name = updates.name ?? existing.name
            const stmt = db.prepare('UPDATE workspaces SET path = ?, name = ?, updated_at = ? WHERE id = ?')
            stmt.run(path, name, now, id)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] update failed:', err)
            return false
        }
    }

    /**
     * 删除工作目录
     */
    delete(id: string): boolean {
        try {
            const db = getDatabase()
            const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?')
            stmt.run(id)
            saveDatabase()
            return true
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] delete failed:', err)
            return false
        }
    }

    /**
     * 获取当前工作目录
     */
    getCurrentWorkspace(): Workspace | null {
        const currentId = systemSettingsRepo.get(CURRENT_WORKSPACE_KEY)
        if (!currentId) {
            // 如果没有设置当前工作目录，返回列表中的第一个
            const workspaces = this.list()
            return workspaces[0] || null
        }
        return this.getById(currentId)
    }

    /**
     * 设置当前工作目录
     */
    setCurrentWorkspace(id: string): boolean {
        const workspace = this.getById(id)
        if (!workspace) return false
        return systemSettingsRepo.set(CURRENT_WORKSPACE_KEY, id)
    }
}

export const workspaceRepo = new SqliteWorkspaceRepository()
