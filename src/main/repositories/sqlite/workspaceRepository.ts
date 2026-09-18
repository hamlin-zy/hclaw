import {getDatabase, saveDatabase} from './index'
import {systemSettingsRepo} from './systemSettingsRepository'

export interface Workspace {
    id: string
    path: string
    name: string
    createdAt: number
    updatedAt: number
    /** 所属项目组 id；null = 未分组（顶层项目） */
    groupId: string | null
    /** 组内顺序；null = 未指定 */
    groupOrder: number | null
}

const CURRENT_WORKSPACE_KEY = 'currentWorkspaceId'

/**
 * 单条读取的**判别式结果**（缺陷 task-16cdf257）：
 *   ok       读到了记录（等价于 `getById` 返回记录）
 *   missing  库是好的，但按 id 确实没有这条记录（等价于 `getById` 返回 null）
 *   fault    读取本身失败（DB 抖动 / 句柄失效）—— **必须让调用方看见**，不得再伪装成 missing
 */
export type WorkspaceLookup =
    | {kind: 'ok'; workspace: Workspace}
    | {kind: 'missing'}
    | {kind: 'fault'; error: unknown}

/** 整表读取的判别式结果：只有 `ok` 才代表「读到的就是全部」 */
export type WorkspaceListLookup =
    | {kind: 'ok'; workspaces: Workspace[]}
    | {kind: 'fault'; error: unknown}

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
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at, group_id, group_order FROM workspaces WHERE id = ?')
            const row = stmt.get(id) as {
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number;
                group_id: string | null;
                group_order: number | null
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                path: row.path,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                groupId: row.group_id,
                groupOrder: row.group_order,
            }
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] getById failed:', err)
            return null
        }
    }

    /**
     * ── 窄出口（缺陷 task-16cdf257）────────────────────────────────────────
     * `getById` 把「记录不存在」与「库读失败」一起压成 null，调用方无从分辨；而工作目录
     * 守卫必须分辨：前者是说「这条任务的工作目录没了」，后者是说「读书的人自己坏了」。
     * 故新增本出口：结果判别式，故障如实报成 fault。
     *
     * **既有 `getById` / `list` 的语义一字不动**（吞错、返回 null / []），本出口只供工作区
     * 守卫消费（src/main/scheduler/scheduleWorkspace.ts），其余调用方零影响。
     * 代价是行映射与上面重复一份 —— 换取的是既有出口的行尾行为完全不变。
     */
    tryGetById(id: string): WorkspaceLookup {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at, group_id, group_order FROM workspaces WHERE id = ?')
            const row = stmt.get(id) as {
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number;
                group_id: string | null;
                group_order: number | null
            } | undefined
            if (!row) return {kind: 'missing'}
            return {
                kind: 'ok',
                workspace: {
                    id: row.id,
                    path: row.path,
                    name: row.name,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                    groupId: row.group_id,
                    groupOrder: row.group_order,
                },
            }
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] tryGetById failed:', err)
            return {kind: 'fault', error: err}
        }
    }

    /**
     * 整表读取的窄出口：`list` 把读失败压成 `[]`（读起来就是「一个工作区都没有」），
     * 工作区 sweep 需要的却是「表是空的」与「表没读到」之分，故同上另开一个出口。
     */
    tryList(): WorkspaceListLookup {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at, group_id, group_order FROM workspaces ORDER BY updated_at DESC')
            const rows = stmt.all() as Array<{
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number;
                group_id: string | null;
                group_order: number | null
            }>
            return {
                kind: 'ok',
                workspaces: rows.map(row => ({
                    id: row.id,
                    path: row.path,
                    name: row.name,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                    groupId: row.group_id,
                    groupOrder: row.group_order,
                })),
            }
        } catch (err) {
            console.error('[SqliteWorkspaceRepository] tryList failed:', err)
            return {kind: 'fault', error: err}
        }
    }

    /**
     * 根据路径获取工作目录
     */
    getByPath(workspacePath: string): Workspace | null {
        try {
            const db = getDatabase()
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at, group_id, group_order FROM workspaces WHERE path = ?')
            const row = stmt.get(workspacePath) as {
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number;
                group_id: string | null;
                group_order: number | null
            } | undefined
            if (!row) return null
            return {
                id: row.id,
                path: row.path,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                groupId: row.group_id,
                groupOrder: row.group_order,
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
            const stmt = db.prepare('SELECT id, path, name, created_at, updated_at, group_id, group_order FROM workspaces ORDER BY updated_at DESC')
            const rows = stmt.all() as Array<{
                id: string;
                path: string;
                name: string;
                created_at: number;
                updated_at: number;
                group_id: string | null;
                group_order: number | null
            }>
            return rows.map(row => ({
                id: row.id,
                path: row.path,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                groupId: row.group_id,
                groupOrder: row.group_order,
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
     * 删除工作目录 —— 并清掉引用它的定时任务（数据一致性，票 task-670265c2）。
     *
     * 顺序：**先清引用、再删记录**。反过来的话，「删完再清」一旦失败就正好留下本票要
     * 消灭的那种悬空引用（`schedules.workspace_id` 指向一个不存在的 id）。
     *
     * 清理方式是把引用它的任务 `workspace_id` 置 NULL，而不是删除/改写这些任务：
     * - 任务本身保留 —— 越权删用户的任务是最不该做的事；
     * - 置 NULL 后由**工作目录守卫**（src/main/scheduler/scheduleWorkspace.ts）判成
     *   `unset`（未设置工作目录）拦下执行，任务列表里以行内标记呈现，用户重选一个
     *   工作区即可恢复。守卫是执行拦截的唯一权威，此处不另造一份判定。
     *
     * 跨表写与 `llmProviderRepository.delete`（同文件族，删 Provider 连带删其 models /
     * headers）同口径：本仓储是「删一条记录」这件事的唯一出口，调用方不该记得额外补一刀。
     */
    delete(id: string): boolean {
        try {
            const db = getDatabase()
            // 先清引用：该工作区若被定时任务引用，置 NULL 让它下轮被守卫拦下……
            db.prepare('UPDATE schedules SET workspace_id = NULL, updated_at = ? WHERE workspace_id = ?')
                .run(Date.now(), id)
            // ……再摘掉工作区记录本身（可逆性最差的一步放最后）
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
