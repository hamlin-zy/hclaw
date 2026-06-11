/**
 * Hook 系统兼容层
 *
 * 用于将旧系统（HookEngine）的用户脚本迁移到新系统（HookExecutor）。
 * 提供事件名映射、上下文格式转换和处理器包装。
 *
 * 旧系统事件 → 新系统事件映射：
 *   beforeThink      →  ThinkStart
 *   afterThink       →  ThinkEnd
 *   beforeToolCall   →  PreToolUse
 *   afterToolCall    →  PostToolUse
 *   beforeResponse   →  Stop (近似映射)
 *   afterResponse    →  Stop (近似映射)
 *   onError          →  PostToolUseFailure / StopFailure
 *   onInterrupt      →  Stop
 *
 * @deprecated 用户脚本应逐步迁移到新系统的 Hook 配置方式
 */

import { createLogger } from '../../agent/logger'
import type { HookHandler, HookContext as NewHookContext, HookResult as NewHookResult, HookEvent } from './types'
import { hookExecutor } from './executor'

const logger = createLogger('hooks-compat')

/**
 * 旧系统事件名 → 新系统事件名映射表
 */
const EVENT_MAP: Record<string, HookEvent> = {
  beforeThink: 'ThinkStart',
  afterThink: 'ThinkEnd',
  beforeToolCall: 'PreToolUse',
  afterToolCall: 'PostToolUse',
  beforeResponse: 'Stop',
  afterResponse: 'Stop',
  onError: 'PostToolUseFailure',
  onInterrupt: 'Stop',
}

function mapEventName(oldEvent: string): HookEvent | null {
  return EVENT_MAP[oldEvent] || null
}

/**
 * 新系统 HookContext → 旧系统 HookContext（用于调用旧处理器）
 *
 * 旧系统处理器期望的格式：
 * { event, toolCall?, toolResult?, responseText, error, timestamp, conversationId, toolCallId }
 */
function convertToOldContext(
  eventName: string,
  newCtx: NewHookContext,
): Record<string, unknown> {
  return {
    event: eventName,
    toolCall: newCtx.toolName ? {
      name: newCtx.toolName,
      arguments: newCtx.args,
    } : undefined,
    toolResult: newCtx.result ? {
      output: newCtx.result,
      error: newCtx.error,
      success: !newCtx.error,
    } : undefined,
    responseText: typeof newCtx.result === 'string' ? newCtx.result : undefined,
    error: newCtx.error,
    timestamp: Date.now(),
    conversationId: newCtx.sessionId,
  }
}

function convertOldResult(
  oldResult: Record<string, unknown> | undefined | null,
): NewHookResult {
  if (!oldResult || oldResult.action === 'continue') {
    return { allowed: true }
  }

  if (oldResult.action === 'block') {
    return {
      allowed: false,
      error: (oldResult.reason as string) || 'Blocked by hook script',
    }
  }

  // action === 'modify' or unknown — accept unknown as pass-through
  return {
    allowed: true,
    modified: oldResult.action === 'modify' && oldResult.modifications
      ? { context: oldResult.modifications as Record<string, unknown> }
      : undefined,
  }
}

function wrapOldHandler(oldHandler: (ctx: any) => Promise<any> | any): HookHandler {
  return async (newCtx: NewHookContext): Promise<NewHookResult> => {
    const eventName = newCtx.event || 'unknown'
    const oldCtx = convertToOldContext(eventName, newCtx)

    try {
      const oldResult = await Promise.resolve(oldHandler(oldCtx))
      return convertOldResult(oldResult)
    } catch (err: any) {
      logger.warn(`[Compat] Script handler failed: ${err.message}`, { event: eventName })
      return { allowed: true, error: err.message }
    }
  }
}

// ─── 注册旧脚本到新系统 ─────────────────────────────────────

export function registerLegacyScript(
  oldEvent: string,
  handler: (ctx: any) => Promise<any> | any,
  name: string,
): boolean {
  const newEvent = mapEventName(oldEvent)
  if (!newEvent) {
    logger.warn(`[Compat] Unknown old event "${oldEvent}", script "${name}" skipped`)
    return false
  }

  hookExecutor.registerEventHandler(newEvent, wrapOldHandler(handler), `${name} (compat)`)

  logger.warn(`[Compat] Legacy script "${name}" → "${newEvent}" — 请迁移到新 Hook 系统`, {
    oldEvent, newEvent, scriptName: name,
  })

  return true
}

export function logMigrationNotice(loadedCount: number): void {
  if (loadedCount > 0) {
    logger.warn(`[Compat] 已通过兼容层加载 ${loadedCount} 个旧系统脚本，即将弃用。请通过 Hook 管理界面迁移。`)
  }
}
