/**
 * 定时任务域 — 记录与跨线程协议的唯一来源
 *
 * 全应用只有这一处定义 `ScheduleRecord`：主进程（仓储 / 管理器）、cron 引擎、
 * 渲染层一律从这里引用或派生，不得再平行定义。引擎实际用到的字段用 `Pick` 派生。
 *
 * cron 引擎与主进程之间的 worker 消息在此定义为判别联合（入站按 `cmd`、出站按 `type`），
 * 两端共用同一份，协议变更由编译器拦截。
 *
 * 约束：纯类型模块，零运行时依赖（不得 import electron / src/main）。
 */

/**
 * 定时任务模块的统一返回形状 — 与 memo / phrase 模块一致。
 * `error` 在 IPC 边界已是可读字符串（渲染层直接 toast）；
 * 主进程内部的存储层用带 `code` 的 ScheduleError 区分「未找到 / 参数非法 / 存储异常」，
 * 在边界拍平成字符串。
 */
export type ScheduleResult<T> = {ok: true; data: T} | {ok: false; error: string}

/** 定时任务的执行类型 */
export type ScheduleTaskType = 'agent' | 'skill' | 'command' | 'script'

/** 定时任务最近一次执行状态 */
export type ScheduleRunStatus = 'none' | 'running' | 'success' | 'failure'

/**
 * 触发来源（Fire Source）—— 一次执行是「cron 到点」还是「用户手动立即执行」。
 *
 * 单一来源：主进程执行器（`scheduler/index.ts` 的 `executeSchedule`）的调用方
 * 必须显式传入，不得复用字面量。它决定两件可观察的事：
 *   1. 是否向 cron 引擎发送 ack（只有到点触发才拥有「本轮已认领」的语义）；
 *   2. 执行日志里的 source 字段（排查时用来分辨是谁触发的）。
 */
export type ScheduleFireSource = 'cron' | 'manual'

/** 定时任务记录 — 权威定义，稳定键 `id` */
export interface ScheduleRecord {
  id: string
  name: string
  description: string
  cronExpression: string
  taskType: ScheduleTaskType
  taskTarget: string
  taskArgs: any[]
  enabled: boolean
  paused: boolean
  pausedAt: number | null
  lastRunAt: number | null
  lastRunStatus: ScheduleRunStatus
  lastRunConversationId: string | null
  runCount: number
  createdAt: number
  updatedAt: number
  workspaceId: string | null
  isSystem: boolean
}

/**
 * 配置变更广播载荷 — `schedules-changed` 通道的唯一载荷形状。
 *
 * 三种**可区分**形态：新增 / 更新携带记录本体，删除只带 `id`。
 * 渲染层收到后只更新对应行；无法识别的形态（含历史上无载荷的广播）一律回退整表重取。
 * 载荷走既有 `schedules-changed` 通道，不新增通道。
 */
export type ScheduleChangePayload =
  | {type: 'created'; record: ScheduleRecord}
  | {type: 'updated'; record: ScheduleRecord}
  | {type: 'deleted'; id: string}

/** 系统任务单个 id 的漂移信息：drifted=与出厂模板是否不一致；changedFields 列出不等字段名 */
export interface SystemScheduleDriftInfo { drifted: boolean; changedFields: string[] }
/** 系统任务 id → 漂移信息（仅 isSystem 且在 SYSTEM_SCHEDULE_DEFAULTS 中找得到的记录进 map） */
export type SystemScheduleDriftMap = Record<string, SystemScheduleDriftInfo>

/** cron 引擎实际持有的字段子集 — 由 `ScheduleRecord` 派生，不平行定义 */
export type SchedulerEngineSchedule = Pick<
  ScheduleRecord,
  'id' | 'cronExpression' | 'taskType' | 'taskTarget' | 'taskArgs' | 'enabled' | 'paused'
>

/** 主进程 → cron 引擎（worker 入站消息，按 `cmd` 判别） */
export type SchedulerEngineInboundMessage =
  | { cmd: 'init'; schedules: SchedulerEngineSchedule[] }
  | { cmd: 'update'; schedule: SchedulerEngineSchedule }
  | { cmd: 'delete'; id: string }
  | { cmd: 'pause'; id: string }
  | { cmd: 'resume'; id: string }
  | { cmd: 'ack'; scheduleId: string }
  | { cmd: 'shutdown' }

/** cron 引擎 → 主进程（worker 出站消息，按 `type` 判别） */
export type SchedulerEngineOutboundMessage =
  | { type: 'worker_ready' }
  | { type: 'task_fire'; scheduleId: string; taskType: ScheduleTaskType; taskTarget: string; taskArgs: any[] }

/**
 * cron 引擎依赖的消息端口。
 * worker 侧注入 `parentPort`；测试注入桩以捕获出站消息。
 */
export interface SchedulerEnginePort {
  postMessage(message: SchedulerEngineOutboundMessage): void
  close(): void
}
