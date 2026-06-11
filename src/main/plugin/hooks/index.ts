/**
 * Hook 系统入口
 * 
 * 统一 Hook 系统，支持：
 * - command 类型：执行 shell 命令
 * - function 类型：直接调用 JavaScript 函数
 * - prompt 类型：修改提示词
 * - http 类型：发送 HTTP 请求
 * - agent 类型：调用子 Agent
 * 
 * 基于 Claude Code Hooks 规范实现
 */

export { hookExecutor, HookExecutor } from './executor'
export { matchesTool, matchesEvent, matchesFile, isValidMatcher, describeMatcher } from './matcher'
export { registerBuiltinHandlers, getAuditLog, clearAuditLog } from './builtin'
export type {
  HookEvent,
  HookContext,
  HookResult,
  HookType,
  HookHandler,
  HookEventDefinition,
  HookConfig,
  HookDefinition,
  SerializedHook,
} from './types'
