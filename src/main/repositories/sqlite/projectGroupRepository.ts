import {getDatabase, saveDatabase} from './index'
import type {ProjectGroupWithMembers} from '../../../shared/types/projectGroup'

// 类型唯一定义在 shared（主/渲染共用），此处 re-export 保持既有 import 路径可用
export type {ProjectGroup, ProjectGroupMember, ProjectGroupWithMembers} from '../../../shared/types/projectGroup'

interface Row {
    id: string; name: string; sort_order: number; created_at: number; updated_at: number
}

/**
 * 项目组仓储。
 *
 * 归属写在工作目录表（`workspaces.group_id` / `group_order`）上，故本仓储同时是
 * 「项目∈组」这一关系的唯一出口；`workspaceRepository` 只读这两个列（不写）。
 *
 * ⚠ 路径口径：`workspaceRepository` 用 `WHERE path = ?` 精确匹配，没有归一化。
 * 因此**调用方（渲染端）必须传 `resolveWorkspaceKey` 解析后的生效键**，
 * 否则会复现"同一项目两种写法 → 两条记录"的既有问题（spec §4.1）。
 *
 * 排序类操作（reorderGroups / reorderProjects）一律**单事务 + 全量重编号一次落库**，
 * 且入参集合必须与库内一致，否则整批回滚（不做部分写）——不沿用备忘录那种逐条 N 次写的做法。
 */
export class SqliteProjectGroupRepository {
    list(): ProjectGroupWithMembers[] {
        const db = getDatabase()
        const groups = db
            .prepare('SELECT id, name, sort_order, created_at, updated_at FROM project_groups ORDER BY sort_order ASC')
            .all() as Row[]
        const memberRows = db
            .prepare(
                `SELECT path, group_id, group_order FROM workspaces
                 WHERE group_id IS NOT NULL
                 ORDER BY group_id ASC, (group_order IS NULL) ASC, group_order ASC, updated_at DESC`,
            )
            .all() as Array<{path: string; group_id: string; group_order: number | null}>

        const byGroup = new Map<string, Array<{projectPath: string; groupOrder: number}>>()
        for (const m of memberRows) {
            const list = byGroup.get(m.group_id) ?? []
            list.push({projectPath: m.path, groupOrder: m.group_order ?? list.length})
            byGroup.set(m.group_id, list)
        }
        return groups.map(g => ({
            id: g.id,
            name: g.name,
            sortOrder: g.sort_order,
            createdAt: g.created_at,
            updatedAt: g.updated_at,
            members: byGroup.get(g.id) ?? [],
        }))
    }

    create(id: string, name: string): boolean {
        const db = getDatabase()
        const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_groups').get() as {m: number}
        const now = Date.now()
        db.prepare(
            'INSERT INTO project_groups (id, name, sort_order, created_at, updated_at) VALUES (?,?,?,?,?)',
        ).run(id, name, max.m + 1, now, now)
        saveDatabase()
        return true
    }

    rename(id: string, name: string): boolean {
        const db = getDatabase()
        const info = db.prepare('UPDATE project_groups SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id)
        saveDatabase()
        return info.changes > 0
    }

    /** 解散：成员 group_id/group_order 置 NULL（回顶层）+ 删组记录 + 组间排序重编号 */
    dissolve(id: string): boolean {
        return this.remove(id)
    }

    /** 删除组记录（级联删除项目由渲染端顺序循环 removeWorkspace 完成，见 spec §4.2） */
    remove(id: string): boolean {
        const db = getDatabase()
        let changes = 0
        db.exec('BEGIN')
        try {
            db.prepare('UPDATE workspaces SET group_id = NULL, group_order = NULL WHERE group_id = ?').run(id)
            const info = db.prepare('DELETE FROM project_groups WHERE id = ?').run(id)
            changes = info.changes
            this.renumberGroups()
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            console.error('[projectGroupRepository] remove failed:', err)
            return false
        }
        saveDatabase()
        return changes > 0
    }

    /** 加入 / 迁移 / 移出：groupId 为 null 即移出；目标组末尾追加 group_order */
    assign(projectPath: string, groupId: string | null): boolean {
        const db = getDatabase()
        if (groupId === null) {
            const info = db
                .prepare('UPDATE workspaces SET group_id = NULL, group_order = NULL, updated_at = ? WHERE path = ?')
                .run(Date.now(), projectPath)
            saveDatabase()
            return info.changes > 0
        }
        const current = db
            .prepare('SELECT group_id FROM workspaces WHERE path = ?')
            .get(projectPath) as {group_id: string | null} | undefined
        if (!current) return false
        if (current.group_id === groupId) return true // 幂等：不改顺序
        const max = db
            .prepare('SELECT COALESCE(MAX(group_order), -1) AS m FROM workspaces WHERE group_id = ?')
            .get(groupId) as {m: number}
        const info = db
            .prepare('UPDATE workspaces SET group_id = ?, group_order = ?, updated_at = ? WHERE path = ?')
            .run(groupId, max.m + 1, Date.now(), projectPath)
        saveDatabase()
        return info.changes > 0
    }

    /** 组间排序：入参 id 集合必须与库内一致，否则整批回滚 */
    reorderGroups(groupIds: string[]): boolean {
        const db = getDatabase()
        const existing = (db.prepare('SELECT id FROM project_groups').all() as Array<{id: string}>).map(r => r.id)
        if (!sameSet(existing, groupIds)) return false
        db.exec('BEGIN')
        try {
            const stmt = db.prepare('UPDATE project_groups SET sort_order = ? WHERE id = ?')
            groupIds.forEach((id, i) => stmt.run(i, id))
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            console.error('[projectGroupRepository] reorderGroups failed:', err)
            return false
        }
        saveDatabase()
        return true
    }

    /** 组内排序：入参路径集合必须与该组当前成员一致，否则整批回滚 */
    reorderProjects(groupId: string, projectPaths: string[]): boolean {
        const db = getDatabase()
        const members = (
            db.prepare('SELECT path FROM workspaces WHERE group_id = ?').all(groupId) as Array<{path: string}>
        ).map(r => r.path)
        if (!sameSet(members, projectPaths)) return false
        db.exec('BEGIN')
        try {
            const stmt = db.prepare('UPDATE workspaces SET group_order = ? WHERE path = ? AND group_id = ?')
            projectPaths.forEach((path, i) => stmt.run(i, path, groupId))
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            console.error('[projectGroupRepository] reorderProjects failed:', err)
            return false
        }
        saveDatabase()
        return true
    }

    /** 组间顺序全量重编号（内部用；删除组后调用，保证连续无空洞） */
    private renumberGroups(): void {
        const db = getDatabase()
        const ids = (db.prepare('SELECT id FROM project_groups ORDER BY sort_order ASC').all() as Array<{id: string}>)
            .map(r => r.id)
        const stmt = db.prepare('UPDATE project_groups SET sort_order = ? WHERE id = ?')
        ids.forEach((id, i) => stmt.run(i, id))
    }
}

function sameSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    const set = new Set(a)
    return b.every(x => set.has(x)) && new Set(b).size === b.length
}

export const projectGroupRepo = new SqliteProjectGroupRepository()
