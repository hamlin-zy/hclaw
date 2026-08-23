/**
 * 任务批次持久化仓库（migration 040：task_batches + tasks）
 *
 * TaskStore（内存权威态）在批次/任务变化时调用 upsertSnapshot 落库；
 * 历史任务组窗口通过 listBatches 按会话分组读取。
 */
import {getDatabase} from './index'
import type {Task} from '@shared/types'

export interface BatchSnapshot {
    id: string
    name: string
    status: 'active' | 'completed'
}

export interface BatchInfo {
    id: string
    name: string
    status: string
    createdAt: number
    completedAt: number | null
}

export interface BatchWithTasks {
    batch: BatchInfo
    tasks: Array<{id: string; title: string; description?: string; status: string; subtasks?: unknown[]}>
}

export type BatchSummary = BatchInfo & {total: number; done: number}

export interface BatchGroup {
    conversationId: string
    conversationTitle: string
    batches: BatchSummary[]
}

interface BatchRow {
    id: string
    conversation_id: string
    name: string
    status: string
    created_at: number
    completed_at: number | null
    conv_meta?: string | null
}

function rowToBatch(row: BatchRow): BatchInfo {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
    }
}

/** conversations 无独立标题列，标题存于 meta JSON；解析失败容错为空串 */
function extractConversationTitle(metaJson: string | null | undefined): string {
    if (!metaJson) return ''
    try {
        const meta = JSON.parse(metaJson) as {title?: unknown}
        return typeof meta.title === 'string' ? meta.title : ''
    } catch {
        return ''
    }
}

/** subtasks JSON 解析（空值容错） */
function parseSubtasks(json: string | null): unknown[] | undefined {
    if (!json) return undefined
    try {
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

/** LIKE 通配符转义（配合 ESCAPE '\'） */
function escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, ch => '\\' + ch)
}

/**
 * 写入批次快照（事务内）：
 * INSERT OR REPLACE 批次行 → 遍历快照 INSERT OR REPLACE 任务行（sort_order = 数组下标）
 * → DELETE 快照外的旧任务行。幂等：重复写同一快照不产生重复行。
 */
export function upsertSnapshot(convId: string, batch: BatchSnapshot, tasks: Task[]): void {
    const db = getDatabase()
    db.transaction(() => {
        // 保留首次 created_at / completed_at，避免重复 upsert 抖动时间戳
        const existing = db.prepare('SELECT created_at, completed_at FROM task_batches WHERE id = ?')
            .get(batch.id) as {created_at: number; completed_at: number | null} | undefined
        const now = Date.now()
        const createdAt = existing?.created_at ?? now
        const completedAt = batch.status === 'completed'
            ? (existing?.completed_at ?? now)
            : null

        db.prepare(
            `INSERT OR REPLACE INTO task_batches (id, conversation_id, name, status, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(batch.id, convId, batch.name, batch.status, createdAt, completedAt)

        const insertTask = db.prepare(
            `INSERT OR REPLACE INTO tasks (id, batch_id, conversation_id, title, description, status, subtasks, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i]!
            insertTask.run(
                t.id,
                batch.id,
                convId,
                t.title,
                t.description ?? null,
                t.status,
                t.subtasks ? JSON.stringify(t.subtasks) : null,
                i,
                now,
                now,
            )
        }

        // diff 删除：清掉本次快照之外残留的旧任务行
        if (tasks.length === 0) {
            db.prepare('DELETE FROM tasks WHERE batch_id = ?').run(batch.id)
        } else {
            const placeholders = tasks.map(() => '?').join(', ')
            db.prepare(`DELETE FROM tasks WHERE batch_id = ? AND id NOT IN (${placeholders})`)
                .run(batch.id, ...tasks.map(t => t.id))
        }
    })()
}

/** 读取指定会话当前活跃批次（任务按 sort_order 升序）；无 active 批次返回 null */
export function getActiveBatch(convId: string): BatchWithTasks | null {
    const db = getDatabase()
    const batchRow = db.prepare(
        `SELECT id, conversation_id, name, status, created_at, completed_at
         FROM task_batches WHERE conversation_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
    ).get(convId) as BatchRow | undefined
    if (!batchRow) return null

    const taskRows = db.prepare(
        `SELECT id, title, description, status, subtasks FROM tasks WHERE batch_id = ? ORDER BY sort_order ASC`,
    ).all(batchRow.id) as Array<{id: string; title: string; description: string | null; status: string; subtasks: string | null}>

    return {
        batch: rowToBatch(batchRow),
        tasks: taskRows.map(row => ({
            id: row.id,
            title: row.title,
            description: row.description ?? undefined,
            status: row.status,
            subtasks: parseSubtasks(row.subtasks),
        })),
    }
}

/**
 * 历史批次列表：按批次 created_at 倒序，按会话分组（组序 = 组内最新批次时间倒序）。
 * - filter：LIKE 匹配批次名或该批次任一任务标题（转义 %/_/\）
 * - conversationId：限定单会话
 * - workspaceId：过滤会话所属工作区（conversations 表实际列为 workspace_path，
 *   该参数取值即工作区路径——代码库中 workspace 以路径为唯一标识）
 */
export function listBatches(opts?: {filter?: string; conversationId?: string; workspaceId?: string}): BatchGroup[] {
    const db = getDatabase()
    const conditions: string[] = []
    const params: unknown[] = []

    if (opts?.filter) {
        const like = `%${escapeLike(opts.filter)}%`
        conditions.push(
            `(b.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM tasks t WHERE t.batch_id = b.id AND t.title LIKE ? ESCAPE '\\'))`,
        )
        params.push(like, like)
    }
    if (opts?.conversationId) {
        conditions.push('b.conversation_id = ?')
        params.push(opts.conversationId)
    }
    if (opts?.workspaceId) {
        conditions.push('c.workspace_path = ?')
        params.push(opts.workspaceId)
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db.prepare(
        `SELECT b.id, b.conversation_id, b.name, b.status, b.created_at, b.completed_at, c.meta AS conv_meta
         FROM task_batches b
         LEFT JOIN conversations c ON c.id = b.conversation_id
         ${whereSql}
         ORDER BY b.created_at DESC, b.rowid DESC`,
    ).all(...params) as BatchRow[]

    if (rows.length === 0) return []

    // done 计数：单次聚合查询，避免 N+1
    const placeholders = rows.map(() => '?').join(', ')
    const countRows = db.prepare(
        `SELECT batch_id,
                COUNT(*) AS total,
                SUM(CASE WHEN status IN ('completed', 'failed', 'error', 'success') THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE batch_id IN (${placeholders})
         GROUP BY batch_id`,
    ).all(...rows.map(r => r.id)) as Array<{batch_id: string; total: number; done: number}>
    const countByBatch = new Map(countRows.map(r => [r.batch_id, r]))

    // 分组保持批次倒序遍历顺序 → 组序即「最新活跃会话在前」
    const groupByConv = new Map<string, BatchGroup>()
    for (const row of rows) {
        let group = groupByConv.get(row.conversation_id)
        if (!group) {
            group = {
                conversationId: row.conversation_id,
                conversationTitle: extractConversationTitle(row.conv_meta),
                batches: [],
            }
            groupByConv.set(row.conversation_id, group)
        }
        const counts = countByBatch.get(row.id)
        group.batches.push({
            ...rowToBatch(row),
            total: counts?.total ?? 0,
            done: counts?.done ?? 0,
        })
    }
    return Array.from(groupByConv.values())
}

/** 读取指定批次的任务明细（sort_order 升序）；历史任务组窗口展开行懒加载 */
export function getTasksByBatchId(batchId: string): BatchWithTasks['tasks'] {
    const db = getDatabase()
    const rows = db.prepare(
        `SELECT id, title, description, status, subtasks FROM tasks WHERE batch_id = ? ORDER BY sort_order ASC`,
    ).all(batchId) as Array<{id: string; title: string; description: string | null; status: string; subtasks: string | null}>

    return rows.map(row => ({
        id: row.id,
        title: row.title,
        description: row.description ?? undefined,
        status: row.status,
        subtasks: parseSubtasks(row.subtasks),
    }))
}

/** 查询批次所属会话 id（去重）；删除批次后跨窗口广播用 */
export function getConversationIdsByBatchIds(ids: string[]): string[] {
    if (ids.length === 0) return []
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(', ')
    const rows = db.prepare(
        `SELECT DISTINCT conversation_id FROM task_batches WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{conversation_id: string}>
    return rows.map(r => r.conversation_id)
}

/** 删除指定批次（显式两步 DELETE：先 tasks 后 task_batches），返回实际删除的批次数 */
export function deleteBatches(ids: string[]): number {
    if (ids.length === 0) return 0
    const db = getDatabase()
    let deleted = 0
    db.transaction(() => {
        const placeholders = ids.map(() => '?').join(', ')
        db.prepare(`DELETE FROM tasks WHERE batch_id IN (${placeholders})`).run(...ids)
        const result = db.prepare(`DELETE FROM task_batches WHERE id IN (${placeholders})`).run(...ids)
        deleted = Number(result.changes)
    })()
    return deleted
}

/** 清空指定会话的全部批次与任务（显式两步 DELETE） */
export function deleteByConversation(convId: string): void {
    const db = getDatabase()
    db.transaction(() => {
        db.prepare('DELETE FROM tasks WHERE conversation_id = ?').run(convId)
        db.prepare('DELETE FROM task_batches WHERE conversation_id = ?').run(convId)
    })()
}
