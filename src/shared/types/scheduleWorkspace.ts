/**
 * 定时任务 × 工作目录健康度 — 跨进程唯一形状
 *
 * 判定权属：主进程是唯一权威（见 src/main/scheduler/scheduleWorkspace.ts）。
 * 渲染层只**消费**这里的结果（经 IPC 出口 scheduler-workspace-health），
 * 不得自行推算第二份可用性真相。
 *
 * 约束：纯类型模块，零运行时依赖（不得 import electron / src/main）。
 */

/**
 * 工作目录健康度四态：
 * - `unset`       任务记录里的 workspaceId 为 null / 空串
 * - `missing`     workspaces 表按 id 查不到记录（库是好的，就是没这条）
 * - `unavailable` 有记录但当前拿不到可用目录：path 在磁盘上不是「存在的目录」，
 *                 **或**工作区记录读取本身失败（此时 path 为 null，reason 写明读失败）
 * - `ok`          其余
 *
 * 只有 `ok` 允许任务跑起来（cron 到点与「立即执行」两条路径共用此判定）。
 */
export type ScheduleWorkspaceState = 'unset' | 'missing' | 'unavailable' | 'ok'

/**
 * 单个任务的工作目录健康度。
 * - `path`：解析出的磁盘路径（unset / missing / 读取失败时为 null），仅供展示；
 * - `reason`：被拦原因（具体可辨），state 为 ok 时是 null。
 */
export interface ScheduleWorkspaceHealth {
    state: ScheduleWorkspaceState
    path: string | null
    reason: string | null
}

/** 任务 id → 健康度。只读派生量，不落库、不进 ScheduleRecord 字段集。 */
export type ScheduleWorkspaceHealthMap = Record<string, ScheduleWorkspaceHealth>
