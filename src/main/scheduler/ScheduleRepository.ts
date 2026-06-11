import {getDatabase, saveDatabase} from '../repositories/sqlite'

export interface ScheduleRecord {
  id: string
  name: string
  description: string
  cronExpression: string
  taskType: 'agent' | 'skill' | 'command' | 'script'
  taskTarget: string
  taskArgs: any[]
  enabled: boolean
  paused: boolean
  pausedAt: number | null
  lastRunAt: number | null
  lastRunStatus: 'none' | 'running' | 'success' | 'failure'
  lastRunConversationId: string | null
  runCount: number
  createdAt: number
  updatedAt: number
  workspaceId: string | null
}

/** SQL 列名 → ScheduleRecord 字段映射 (驼峰→蛇形) */
const COL_MAP: Record<string, string> = {
  cronExpression: 'cron_expression', taskType: 'task_type', taskTarget: 'task_target',
  taskArgs: 'task_args', pausedAt: 'paused_at', lastRunAt: 'last_run_at',
  lastRunStatus: 'last_run_status', lastRunConversationId: 'last_run_conversation_id',
  runCount: 'run_count', createdAt: 'created_at', updatedAt: 'updated_at',
  workspaceId: 'workspace_id',
}

function col(field: string): string { return COL_MAP[field] || field }

/** 执行 DB 操作并统一捕获日志 */
function withDb<T>(name: string, fn: () => T, fallback: T): T {
  try { return fn() } catch (err) { console.error(`[ScheduleRepository] ${name}:`, err); return fallback }
}

export class ScheduleRepository {
  private rowToRecord(row: any): ScheduleRecord {
    return {
      id: row.id, name: row.name, description: row.description || '',
      cronExpression: row.cron_expression, taskType: row.task_type,
      taskTarget: row.task_target,
      taskArgs: JSON.parse(row.task_args || '[]'),
      enabled: !!row.enabled, paused: !!row.paused,
      pausedAt: row.paused_at || null, lastRunAt: row.last_run_at || null,
      lastRunStatus: row.last_run_status || 'none',
      lastRunConversationId: row.last_run_conversation_id || null,
      runCount: row.run_count || 0, createdAt: row.created_at, updatedAt: row.updated_at,
      workspaceId: row.workspace_id || null,
    }
  }

  private queryAll(sql: string, ...params: any[]): ScheduleRecord[] {
    return withDb('query', () =>
      (getDatabase().prepare(sql).all(...params) as any[]).map(r => this.rowToRecord(r)),
    [])
  }

  list(): ScheduleRecord[] { return this.queryAll('SELECT * FROM schedules ORDER BY created_at DESC') }

  listEnabled(): ScheduleRecord[] {
    return this.queryAll('SELECT * FROM schedules WHERE enabled = 1 AND paused = 0 ORDER BY created_at DESC')
  }

  /** 支持前缀匹配的 ID 解析 */
  private resolveId(partialId: string): string | null {
    return withDb('resolveId', () => {
      const row = getDatabase().prepare(
        'SELECT id FROM schedules WHERE id = ? OR id LIKE ?'
      ).get(partialId, partialId + '%') as any
      return row ? row.id : null
    }, null)
  }

  get(id: string): ScheduleRecord | null {
    return withDb('get', () => {
      const fullId = this.resolveId(id)
      if (!fullId) return null
      const row = getDatabase().prepare('SELECT * FROM schedules WHERE id = ?').get(fullId) as any
      return row ? this.rowToRecord(row) : null
    }, null)
  }

  create(data: Omit<ScheduleRecord, 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunConversationId' | 'runCount'>): boolean {
    return withDb('create', () => {
      getDatabase().prepare(`INSERT INTO schedules (id, name, description, cron_expression, task_type, task_target, task_args, enabled, paused, workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(data.id, data.name, data.description, data.cronExpression, data.taskType, data.taskTarget,
          JSON.stringify(data.taskArgs), data.enabled ? 1 : 0, data.paused ? 1 : 0,
          data.workspaceId || null, Date.now(), Date.now())
      saveDatabase()
      return true
    }, false)
  }

  // 可更新字段及其序列化方式
  private static readonly UPDATE_FIELDS: Record<string, (v: any) => any> = {
    name: v => v, description: v => v, cronExpression: v => v,
    taskType: v => v, taskTarget: v => v, taskArgs: v => JSON.stringify(v),
    enabled: v => v ? 1 : 0, paused: v => v ? 1 : 0,
    pausedAt: v => v, lastRunStatus: v => v,
    lastRunConversationId: v => v, runCount: v => v, workspaceId: v => v,
  }

  update(id: string, updates: Partial<ScheduleRecord>): boolean {
    return withDb('update', () => {
      const fullId = this.resolveId(id)
      if (!fullId) return false

      const setClauses: string[] = []
      const vals: any[] = []

      for (const [field, serialize] of Object.entries(ScheduleRepository.UPDATE_FIELDS)) {
        const value = (updates as any)[field]
        if (value !== undefined) {
          setClauses.push(`${col(field)} = ?`)
          vals.push(serialize(value))
        }
      }
      if (setClauses.length === 0) return false

      vals.push(Date.now(), fullId)
      const result = getDatabase().prepare(`UPDATE schedules SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals)
      saveDatabase()
      return result.changes > 0
    }, false)
  }

  updateRunStatus(id: string, status: ScheduleRecord['lastRunStatus'], conversationId?: string): boolean {
    return withDb('updateRunStatus', () => {
      const fields = ['last_run_status = ?', 'last_run_at = ?']
      const vals: any[] = [status, Date.now()]
      if (conversationId) { fields.push('last_run_conversation_id = ?'); vals.push(conversationId) }
      if (status === 'success' || status === 'failure') fields.push('run_count = run_count + 1')
      vals.push(Date.now(), id)
      getDatabase().prepare(`UPDATE schedules SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals)
      saveDatabase()
      return true
    }, false)
  }

  delete(id: string): boolean {
    return withDb('delete', () => {
      const fullId = this.resolveId(id)
      if (!fullId) return false
      const stmt = getDatabase().prepare('DELETE FROM schedules WHERE id = ?')
      const result = stmt.run(fullId)
      saveDatabase()
      return result.changes > 0  // 只有实际删除了行才返回 true
    }, false)
  }
}

export const scheduleRepo = new ScheduleRepository()
