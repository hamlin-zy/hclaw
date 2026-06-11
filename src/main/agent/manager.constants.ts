/**
 * AgentManager 常量
 */

/** Worker 优雅退出等待时间（毫秒） */
export const WORKER_GRACEFUL_SHUTDOWN_MS = 1000

/**
 * pendingAssistantMsg 单条消息最大容量（字节）
 * 防止流式缓冲区无限增长导致 OOM
 * 100KB ≈ 10 万 tokens 文本，超过此阈值截断并记录警告
 */
export const PENDING_MSG_MAX_BYTES = 100 * 1024

/** tool result 单条输出最大容量（字节），防止 web_fetch 等工具返回巨大结果跨轮累积 */
export const TOOL_RESULT_MAX_BYTES = 50 * 1024

/** 不刷日志的流事件类型（避免 text/thinking 刷屏） */
export const SKIP_LOG_EVENT_TYPES = new Set([
  'text',
  'text_delta',
  'thinking',
  'thinking_delta',
])