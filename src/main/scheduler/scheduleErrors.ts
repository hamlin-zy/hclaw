/**
 * 定时任务域 — 主进程内部错误类型
 *
 * 存储层不再把写失败降级为 `false` / `null`：失败时抛出带 `code` 的 ScheduleError，
 * 调用方能区分「未找到（NOT_FOUND）」「参数非法（INVALID_ARGUMENT）」「存储异常（STORAGE_FAILURE）」。
 * 到了 IPC / 工具边界，由 scheduleOps 拍平成可读字符串（ScheduleResult.error）。
 */

export type ScheduleErrorCode = 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'STORAGE_FAILURE'

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode

  constructor(code: ScheduleErrorCode, message: string) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
  }
}

/** 未找到记录 — 消息与历史文案保持一致（渲染层 toast 直出） */
export function notFound(id: string): ScheduleError {
  return new ScheduleError('NOT_FOUND', `未找到ID为 "${id}" 的定时任务。`)
}

/** 参数非法 */
export function invalidArgument(message: string): ScheduleError {
  return new ScheduleError('INVALID_ARGUMENT', message)
}

/** 存储异常 — 保留底层原因，便于排查 */
export function storageFailure(op: string, err: unknown): ScheduleError {
  const message = err instanceof Error ? err.message : String(err)
  return new ScheduleError('STORAGE_FAILURE', `定时任务存储异常（${op}）：${message}`)
}
