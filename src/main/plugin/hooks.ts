/**
 * Hook 系统 - 统一导出
 * 
 * 此文件导出所有 Hook 相关功能
 * 基于 Claude Code Hooks 规范实现
 */

// 直接从 hooks 模块导入（避免循环引用）
import { hookExecutor as _hookExecutor } from './hooks/executor'
import { HookExecutor as _HookExecutor } from './hooks/executor'
import { registerBuiltinHandlers as _registerBuiltinHandlers } from './hooks/builtin'
import { matchesTool as _matchesTool, matchesEvent as _matchesEvent, matchesFile as _matchesFile, isValidMatcher as _isValidMatcher, describeMatcher as _describeMatcher } from './hooks/matcher'

export const hookExecutor = _hookExecutor
export { _HookExecutor as HookExecutor }
export const registerBuiltinHandlers = _registerBuiltinHandlers
export const matchesTool = _matchesTool
export const matchesEvent = _matchesEvent
export const matchesFile = _matchesFile
export const isValidMatcher = _isValidMatcher
export const describeMatcher = _describeMatcher

// 导出类型
export type { HookEvent, HookContext, HookResult, HookType, HookHandler } from './hooks/types'
export type { HookConfig, HookDefinition, SerializedHook } from './hooks/types'
