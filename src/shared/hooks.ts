/**
 * Hooks 类型定义
 * 参考 CC 的 HooksSettings
 */

/**
 * Hook 配置
 */
export interface HooksSettings {
  /** Before tool call hooks */
  beforeToolCall?: BeforeToolCallHook[]
  /** After tool call hooks */
  afterToolCall?: AfterToolCallHook[]
}

/**
 * Before tool call hook
 */
export interface BeforeToolCallHook {
  /** Tool name pattern (glob) */
  tool: string
  /** Command to run before tool call */
  command: string
}

/**
 * After tool call hook
 */
export interface AfterToolCallHook {
  /** Tool name pattern (glob) */
  tool: string
  /** Command to run after tool call */
  command: string
}
