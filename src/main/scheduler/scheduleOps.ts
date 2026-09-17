/**
 * 定时任务域 — 主进程内部唯一操作出口
 *
 * 两个消费方（IPC 通道 scheduleIPC.ts 与智能体工具 schedulerManageTool.ts）都从这里取数，
 * 因此两条路径的可观察结果**必然是同一形状**：
 *   {ok: true, data} | {ok: false, error}
 * 与 memo / phrase 模块一致（memoIPC.ts 文件头即此约定）。
 *
 * 职责边界：
 * - 本层负责「存储 + cron 引擎同步」，失败一律拍平成可读字符串（ScheduleError.code → error）。
 * - 不负责通知渲染层：两条路径（IPC 通道与智能体工具）各自把「改了什么」带到边界层，
 *   再由 scheduleBroadcast 这一个出口广播——详见 scheduleBroadcast.ts。
 */
import crypto from 'crypto'
import type {ScheduleRecord, ScheduleResult} from '@shared/types/schedule'
import type {ScheduleWorkspaceHealthMap} from '@shared/types/scheduleWorkspace'
import {scheduleRepo} from './ScheduleRepository'
import {schedulerManager} from './index'
import {sweepWorkspaceHealth} from './scheduleWorkspace'
import {ScheduleError, notFound, storageFailure} from './scheduleErrors'

const ok = <T>(data: T): ScheduleResult<T> => ({ok: true, data})

/**
 * 把内部错误拍平成渲染层可直出的字符串。
 *
 * fallback 只在抛出物不是 Error 时生效，两条原有实现的口径不同（本模块用可读文案，
 * 只读通道用 String 化），故由调用方指定，避免合并实现时悄悄改掉兜底文案。
 */
export function fail(
    err: unknown,
    label?: string,
    fallback: (err: unknown) => string = () => '定时任务操作失败',
): {ok: false; error: string} {
  if (err instanceof ScheduleError) return {ok: false, error: err.message}
  console.error('[scheduleOps] 未预期的错误:', err)
  const message = err instanceof Error ? err.message : fallback(err)
  return {ok: false, error: label ? `${label}：${message}` : message}
}

/** 新建定时任务的入参（id 缺省时由本层生成） */
export interface CreateScheduleInput {
  id?: string
  name: string
  description?: string
  cronExpression: string
  taskType: ScheduleRecord['taskType']
  taskTarget: string
  taskArgs?: any[]
  enabled?: boolean
  workspaceId?: string | null
}

export function listSchedules(): ScheduleResult<ScheduleRecord[]> {
  try { return ok(scheduleRepo.list()) } catch (err) { return fail(err) }
}

export function getSchedule(id: string): ScheduleResult<ScheduleRecord> {
  try {
    const record = scheduleRepo.get(id)
    if (!record) throw notFound(id)
    return ok(record)
  } catch (err) { return fail(err) }
}

export function createSchedule(input: CreateScheduleInput): ScheduleResult<ScheduleRecord> {
  try {
    const id = input.id || crypto.randomUUID()
    scheduleRepo.create({
      id,
      name: input.name,
      description: input.description || '',
      cronExpression: input.cronExpression,
      taskType: input.taskType,
      taskTarget: input.taskTarget,
      taskArgs: input.taskArgs || [],
      enabled: input.enabled !== false,
      paused: false,
      pausedAt: null,
      workspaceId: input.workspaceId || null,
    })
    const record = scheduleRepo.get(id)
    if (!record) throw storageFailure('create', '创建后无法读回记录')
    if (record.enabled) schedulerManager.upsertWorkerSchedule(record)
    return ok(record)
  } catch (err) { return fail(err) }
}

export function updateSchedule(id: string, updates: Partial<ScheduleRecord>): ScheduleResult<ScheduleRecord> {
  try {
    scheduleRepo.update(id, updates)
    const record = scheduleRepo.get(id)
    if (!record) throw notFound(id)
    if (record.enabled) schedulerManager.upsertWorkerSchedule(record)
    else schedulerManager.deleteWorkerSchedule(record.id)
    return ok(record)
  } catch (err) { return fail(err) }
}

/**
 * 暂停一个定时任务：暂停是独立动作，不是「更新一条记录」的副作用。
 * 先落库（`paused` / `pausedAt`），再通知引擎停止触发。
 */
export function pauseSchedule(id: string): ScheduleResult<ScheduleRecord> {
  try {
    scheduleRepo.update(id, {paused: true, pausedAt: Date.now()})
    const record = scheduleRepo.get(id)
    if (!record) throw notFound(id)
    schedulerManager.pause(record.id)
    return ok(record)
  } catch (err) { return fail(err) }
}

/** 恢复一个被暂停的定时任务：清掉暂停标记，通知引擎按原表达式继续触发 */
export function resumeSchedule(id: string): ScheduleResult<ScheduleRecord> {
  try {
    scheduleRepo.update(id, {paused: false, pausedAt: null})
    const record = scheduleRepo.get(id)
    if (!record) throw notFound(id)
    schedulerManager.resume(record.id)
    return ok(record)
  } catch (err) { return fail(err) }
}

export function deleteSchedule(id: string): ScheduleResult<true> {
  try {
    if (!scheduleRepo.get(id)) throw notFound(id)
    schedulerManager.stop(id)
    schedulerManager.deleteWorkerSchedule(id)
    scheduleRepo.delete(id)
    return ok(true)
  } catch (err) { return fail(err) }
}

/** 停止一个任务的当前执行；任务不存在时返回 NOT_FOUND（不再假装成功） */
export function stopSchedule(id: string): ScheduleResult<true> {
  try {
    if (!scheduleRepo.get(id)) throw notFound(id)
    schedulerManager.stop(id)
    return ok(true)
  } catch (err) { return fail(err) }
}

export function runNowSchedule(id: string): Promise<ScheduleResult<true>> {
  return (async () => {
    try {
      const record = scheduleRepo.get(id)
      if (!record) throw notFound(id)
      const result = await schedulerManager.runNow(id)
      if (!result.success) return {ok: false as const, error: result.error || '立即执行失败'}
      return ok(true)
    } catch (err) { return fail(err) }
  })()
}

/**
 * 每个任务 id → 工作目录健康度（只读派生量，不落库、不进记录字段集）。
 *
 * 与执行拦截共用同一个判定函数（./scheduleWorkspace）：界面上看到的可用性
 * 就是执行时用的那一份，不存在第二真相。
 *
 * 成本口径（票 11 复核 S5）：走批量 sweep —— 一次 `tryList` 建索引 +
 * 每个**不同路径**一次 stat；而不是「每个任务一次 getById + 一次 statSync」。
 */
export function workspaceHealthMap(): ScheduleResult<ScheduleWorkspaceHealthMap> {
  try {
    const records = scheduleRepo.list()
    const healths = sweepWorkspaceHealth(records.map(record => record.workspaceId))
    const map: ScheduleWorkspaceHealthMap = {}
    records.forEach((record, index) => {
      map[record.id] = healths[index]
    })
    return ok(map)
  } catch (err) { return fail(err) }
}
