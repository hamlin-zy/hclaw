/**
 * AgentManager 常量
 */

/** Worker 优雅退出等待时间（毫秒） */
export const WORKER_GRACEFUL_SHUTDOWN_MS = 1000

/**
 * 预热 idle Worker 等待 standby_ready 的超时（毫秒）。
 *
 * prewarm() 挂起的等待 Promise 必须有界出口：worker 永不 ready / 异常退出时，
 * 无超时会永久挂起（悬挂闭包持有 dead worker 引用），且与 idleWorker 状态叠加
 * 会让 prewarming 永 true → 后续 prewarm 全部短路，永久降级 fallback 且不自愈。
 * 10s 远超正常预热耗时（~几百 ms），仅作异常兜底。
 */
export const PREWARM_READY_TIMEOUT_MS = 10_000

/**
 * pendingAssistantMsg 单条消息最大容量（字节）
 * 防止流式缓冲区无限增长导致 OOM
 * 100KB ≈ 10 万 tokens 文本，超过此阈值截断并记录警告
 */
export const PENDING_MSG_MAX_BYTES = 100 * 1024

/** 不刷日志的流事件类型（避免 text/thinking 刷屏） */
export const SKIP_LOG_EVENT_TYPES = new Set([
  'text',
  'text_delta',
  'thinking',
  'thinking_delta',
])