/**
 * 脚本执行日志的落盘位置 — 全模块唯一来源。
 *
 * 写入方（SchedulerManager.writeScriptLog）与读取方（scheduleIPC 的日志列表通道）
 * 共用同一份拼接：此前两处各写一遍 `path.join(getHclawDir(), 'logs', 'schedules')`，
 * 任一处改动都会让「写得进去、读不出来」，且不会有测试发现。
 *
 * 约束：本模块位于 Agent Worker 的静态依赖闭包内（builtin/schedulerManageTool → scheduler/index），
 * 因此只依赖 `path` 与 `../config`，不得引入 electron。
 */
import path from 'path'
import {getHclawDir} from '../hclawPaths'

/** 脚本执行日志目录：`{hclawDir}/logs/schedules` */
export function getScriptLogDir(): string {
  return path.join(getHclawDir(), 'logs', 'schedules')
}
