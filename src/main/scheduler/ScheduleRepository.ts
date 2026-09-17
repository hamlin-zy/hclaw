import {getDatabase, saveDatabase} from '../repositories/sqlite'
// 记录类型的唯一来源在 shared，主进程 / cron 引擎 / 渲染层共用
import type {ScheduleRecord} from '@shared/types/schedule'
import {ScheduleError, invalidArgument, notFound, storageFailure} from './scheduleErrors'

/** SQL 列名 → ScheduleRecord 字段映射 (驼峰→蛇形) */
const COL_MAP: Record<string, string> = {
  cronExpression: 'cron_expression', taskType: 'task_type', taskTarget: 'task_target',
  taskArgs: 'task_args', pausedAt: 'paused_at', lastRunAt: 'last_run_at',
  lastRunStatus: 'last_run_status', lastRunConversationId: 'last_run_conversation_id',
  runCount: 'run_count', createdAt: 'created_at', updatedAt: 'updated_at',
  workspaceId: 'workspace_id',
}

function col(field: string): string { return COL_MAP[field] || field }

/**
 * 执行 DB 操作并统一捕获日志。
 *
 * 失败一律抛 ScheduleError('STORAGE_FAILURE')，不再降级为 fallback 值——
 * 调用方能区分「没找到」（NOT_FOUND）与「存储坏了」（STORAGE_FAILURE）。
 */
function withDb<T>(name: string, fn: () => T): T {
  try { return fn() } catch (err) {
    console.error(`[ScheduleRepository] ${name}:`, err)
    // 已经是带 code 的域内错误（例如 NOT_FOUND）直接透传，不再二次包装成存储异常
    if (err instanceof ScheduleError) throw err
    throw storageFailure(name, err)
  }
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
    )
  }

  list(): ScheduleRecord[] { return this.queryAll('SELECT * FROM schedules ORDER BY created_at DESC') }

  /**
   * 返回**所有启用**（`enabled = 1`）的记录，**含已暂停**的记录。
   *
   * 「暂停」是引擎侧的运行时状态，不是「不该装载」的理由：暂停中的记录必须随
   * `{cmd:'init'}` 一起进入引擎，否则引擎的 schedules Map 里根本没有这条记录，
   * 后续的 `{cmd:'resume'}` 只能空转（唤不醒一条不存在的记录）。
   * 是否起定时器由引擎按自身 `pausedTasks` 判定（见 SchedulerEngine.hasActiveSchedules）。
   */
  listEnabled(): ScheduleRecord[] {
    return this.queryAll('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at DESC')
  }

  /** 支持前缀匹配的 ID 解析；空 id 视为未找到（否则 `LIKE '%'` 会命中任意一条记录） */
  private resolveId(partialId: string): string | null {
    if (!partialId) return null
    return withDb('resolveId', () => {
      const row = getDatabase().prepare(
        'SELECT id FROM schedules WHERE id = ? OR id LIKE ?'
      ).get(partialId, partialId + '%') as any
      return row ? row.id : null
    })
  }

  /** 未找到返回 null；存储异常抛出 STORAGE_FAILURE */
  get(id: string): ScheduleRecord | null {
    return withDb('get', () => {
      const fullId = this.resolveId(id)
      if (!fullId) return null
      const row = getDatabase().prepare('SELECT * FROM schedules WHERE id = ?').get(fullId) as any
      return row ? this.rowToRecord(row) : null
    })
  }

  /** 写入一条记录；ID 冲突 → INVALID_ARGUMENT，其余失败 → STORAGE_FAILURE */
  create(data: Omit<ScheduleRecord, 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunConversationId' | 'runCount'>): void {
    try {
      getDatabase().prepare(`INSERT INTO schedules (id, name, description, cron_expression, task_type, task_target, task_args, enabled, paused, workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(data.id, data.name, data.description, data.cronExpression, data.taskType, data.taskTarget,
          JSON.stringify(data.taskArgs), data.enabled ? 1 : 0, data.paused ? 1 : 0,
          data.workspaceId || null, Date.now(), Date.now())
      saveDatabase()
    } catch (err) {
      console.error('[ScheduleRepository] create:', err)
      const message = err instanceof Error ? err.message : String(err)
      // 实测底层驱动（sqlite 包装层）报 'UNIQUE constraint failed: schedules.id'；
      // 该 INSERT 的约束只有主键 id（其余列均由本方法或上层补全），故命中即 ID 冲突。
      if (message.includes('UNIQUE constraint failed')) throw invalidArgument(`定时任务 ID 已存在：${data.id}`)
      throw storageFailure('create', err)
    }
  }

  // 可更新字段及其序列化方式
  private static readonly UPDATE_FIELDS: Record<string, (v: any) => any> = {
    name: v => v, description: v => v, cronExpression: v => v,
    taskType: v => v, taskTarget: v => v, taskArgs: v => JSON.stringify(v),
    enabled: v => v ? 1 : 0, paused: v => v ? 1 : 0,
    pausedAt: v => v, lastRunStatus: v => v,
    lastRunConversationId: v => v, runCount: v => v, workspaceId: v => v,
  }

  /** 更新一条记录；未找到 → NOT_FOUND，无可更新字段 → INVALID_ARGUMENT */
  update(id: string, updates: Partial<ScheduleRecord>): void {
    const fullId = this.resolveId(id)
    if (!fullId) throw notFound(id)

    const setClauses: string[] = []
    const vals: any[] = []

    for (const [field, serialize] of Object.entries(ScheduleRepository.UPDATE_FIELDS)) {
      const value = (updates as any)[field]
      if (value !== undefined) {
        setClauses.push(`${col(field)} = ?`)
        vals.push(serialize(value))
      }
    }
    if (setClauses.length === 0) throw invalidArgument('未提供任何可更新的字段。')

    vals.push(Date.now(), fullId)
    withDb('update', () => {
      getDatabase().prepare(`UPDATE schedules SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals)
      saveDatabase()
    })
  }

  /**
   * 启动复位：把所有残留的 `last_run_status = 'running'` 批量改写为 `'failure'`，
   * 返回受影响行数（0 表示没有残留，属正常情况）。
   *
   * 语义：上次执行被进程中断（强制退出/崩溃），没跑完 —— 就是失败，
   * 不能让它永久停在「运行中」。其余状态（none / success / failure）不受影响。
   *
   * 不复用 update()，原因有二：
   *   1. update() 按单条 id 定位，未命中即抛 NOT_FOUND；本方法要按**状态**批量命中，
   *      且「一条残留都没有」是合法结果而非错误。
   *   2. 逐条 update 会 N 次解析 id + N 次 saveDatabase，而这里一次 UPDATE 即可
   *      （last_run_status 上已有索引 idx_schedules_last_run_status）。
   */
  resetRunningToFailure(): number {
    return withDb('resetRunningToFailure', () => {
      const result = getDatabase().prepare(
        `UPDATE schedules SET last_run_status = 'failure', updated_at = ? WHERE last_run_status = 'running'`
      ).run(Date.now())
      saveDatabase()
      return result.changes
    })
  }

  /**
   * 更新最近一次运行状态。
   * 幂等：记录不存在时不报 NOT_FOUND（引擎在删除竞态下仍会调用它），只在存储异常时抛出。
   */
  updateRunStatus(id: string, status: ScheduleRecord['lastRunStatus'], conversationId?: string): void {
    withDb('updateRunStatus', () => {
      const fields = ['last_run_status = ?', 'last_run_at = ?']
      const vals: any[] = [status, Date.now()]
      if (conversationId) { fields.push('last_run_conversation_id = ?'); vals.push(conversationId) }
      if (status === 'success' || status === 'failure') fields.push('run_count = run_count + 1')
      vals.push(Date.now(), id)
      getDatabase().prepare(`UPDATE schedules SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals)
      saveDatabase()
    })
  }

  /** 删除一条记录；未找到 → NOT_FOUND */
  delete(id: string): void {
    const fullId = this.resolveId(id)
    if (!fullId) throw notFound(id)
    withDb('delete', () => {
      const result = getDatabase().prepare('DELETE FROM schedules WHERE id = ?').run(fullId)
      saveDatabase()
      // 解析到了 id 却没删掉任何行 = 并发删除，语义上就是「未找到」
      if (result.changes === 0) throw notFound(id)
    })
  }
}

export const scheduleRepo = new ScheduleRepository()
