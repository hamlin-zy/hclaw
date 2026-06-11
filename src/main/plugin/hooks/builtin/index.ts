/**
 * 内置 Hook Handlers
 * 
 * 提供内置的 function 类型 Hook 实现
 */

import type { HookContext, HookResult, HookHandler } from '../types'
import { createLogger } from '../../../agent/logger'

const logger = createLogger('hooks-builtin')

// ─── 审计日志缓冲区 ─────────────────────────────────────

interface AuditEntry {
  timestamp: number
  event: string
  sessionId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  error?: string
  success?: boolean
}

const auditBuffer: AuditEntry[] = []
const MAX_BUFFER = 1000

function appendAudit(entry: AuditEntry): void {
  auditBuffer.push(entry)
  if (auditBuffer.length > MAX_BUFFER) {
    auditBuffer.shift()
  }
}

/** 获取审计日志（供 IPC 查询） */
export function getAuditLog(limit = 100): AuditEntry[] {
  return auditBuffer.slice(-limit)
}

/** 清空审计日志 */
export function clearAuditLog(): void {
  auditBuffer.length = 0
}

/**
 * 审计日志 Hook
 * 记录所有 Hook 事件的执行日志
 */
export const auditLogHandler: HookHandler = async (context: HookContext): Promise<HookResult> => {
  const event = (context as any).event || 'unknown'

  appendAudit({
    timestamp: Date.now(),
    event,
    sessionId: context.sessionId,
    toolName: context.toolName,
    args: context.args,
    result: context.result,
    error: context.error,
    success: !context.error,
  })

  logger.info(`[Audit] ${event}: ${context.toolName || 'N/A'}`, {
    sessionId: context.sessionId,
    toolName: context.toolName,
  })

  return { allowed: true }
}

/**
 * 文件保护 Hook
 * 阻止对敏感文件的修改
 */
export const fileGuardHandler: HookHandler = async (context: HookContext): Promise<HookResult> => {
  // 只检查写操作
  const writeTools = ['Write', 'Edit', 'MultiEdit', 'Bash']
  if (!context.toolName || !writeTools.includes(context.toolName)) {
    return { allowed: true }
  }

  const filePath = (context.args as any)?.filePath
  if (!filePath) {
    return { allowed: true }
  }

  // 敏感文件模式
  const sensitivePatterns = [
    /\.env$/i,
    /\.env\./i,
    /\.key$/i,
    /\.pem$/i,
    /credentials/i,
    /secrets/i,
    /\.git\/config$/i,
    /package-lock\.json$/i,
    /\.lock$/i,
  ]

  for (const pattern of sensitivePatterns) {
    if (pattern.test(filePath)) {
      logger.warn(`[FileGuard] Blocked write to sensitive file: ${filePath}`)
      return {
        allowed: false,
        error: `文件保护：不允许修改敏感文件 "${filePath}"`,
      }
    }
  }

  return { allowed: true }
}

/**
 * 命令验证 Hook
 * 阻止危险命令的执行
 */
export const commandGuardHandler: HookHandler = async (context: HookContext): Promise<HookResult> => {
  // 只检查 Bash 工具
  if (context.toolName !== 'Bash') {
    return { allowed: true }
  }

  const command = (context.args as any)?.command
  if (!command) {
    return { allowed: true }
  }

  // 危险命令模式
  const dangerousPatterns = [
    /^rm\s+-rf\s+\/(?:\s|$)/,                    // rm -rf /
    /^rm\s+-rf\s+\*\s*$/,                        // rm -rf *
    /^\s*git\s+push\s+--force/i,                  // git push --force
    /^dd\s+if=/i,                                // dd if=
    /:\(\)\{\s*:\\|:\s*&\s*\};:\s*$/i,           // Fork bomb
    /^curl\s+.*\|\s*sh\b/i,                      // curl | sh
    /^wget\s+.*\|\s*sh\b/i,                      // wget | sh
    /eval\s+\$\([^)]+\)/i,                       // eval $(...)
    /chmod\s+-R\s+777/i,                          // chmod -R 777
  ]

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      logger.warn(`[CommandGuard] Blocked dangerous command: ${command.substring(0, 50)}...`)
      return {
        allowed: false,
        error: `命令保护：不允许执行危险命令 "${command.substring(0, 50)}..."`,
      }
    }
  }

  return { allowed: true }
}

/**
 * 自动格式化 Hook
 * 在文件修改后提示格式化
 */
export const autoFormatHandler: HookHandler = async (context: HookContext): Promise<HookResult> => {
  const formatTools = ['Write', 'Edit', 'MultiEdit']
  if (!context.toolName || !formatTools.includes(context.toolName)) {
    return { allowed: true }
  }

  const filePath = (context.args as any)?.filePath
  if (!filePath) {
    return { allowed: true }
  }

  // 需要格式化的文件类型
  const formatExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java']
  const shouldFormat = formatExtensions.some(ext => filePath.endsWith(ext))

  if (shouldFormat) {
    // 这里只是记录，实际格式化由 PostToolUse hook 处理
    logger.debug(`[AutoFormat] File may need formatting: ${filePath}`)
  }

  return { allowed: true }
}

/**
 * 上下文压缩 Hook
 * 在压缩前保存状态
 */
export const preCompactHandler: HookHandler = async (_context: HookContext): Promise<HookResult> => {
  logger.info('[PreCompact] Saving state before compaction')
  // 保存当前状态到临时文件
  // 这个 handler 主要用于记录和准备
  return { allowed: true }
}

/**
 * 上下文压缩后 Hook
 * 在压缩后恢复状态
 */
export const postCompactHandler: HookHandler = async (_context: HookContext): Promise<HookResult> => {
  logger.info('[PostCompact] Restoring state after compaction')
  // 读取保存的状态并恢复
  return { allowed: true }
}

/**
 * Session 启动 Hook
 * 会话启动时的初始化
 */
export const sessionStartHandler: HookHandler = async (context: HookContext): Promise<HookResult> => {
  logger.info(`[SessionStart] New session: ${context.sessionId}`)
  // 可以在这里初始化会话相关的状态
  return { allowed: true }
}

/**
 * Session 结束 Hook
 * 会话结束时的清理
 */
export const sessionEndHandler: HookHandler = async (context: HookContext): Promise<HookResult> => {
  logger.info(`[SessionEnd] Session ended: ${context.sessionId}`)
  // 可以在这里清理会话相关的状态
  return { allowed: true }
}

/**
 * 注册所有内置 Hooks
 */
export function registerBuiltinHandlers(executor: { registerBuiltinHandler: (id: string, handler: HookHandler) => void }): void {
  executor.registerBuiltinHandler('audit', auditLogHandler)
  executor.registerBuiltinHandler('file-guard', fileGuardHandler)
  executor.registerBuiltinHandler('command-guard', commandGuardHandler)
  executor.registerBuiltinHandler('auto-format', autoFormatHandler)
  executor.registerBuiltinHandler('pre-compact', preCompactHandler)
  executor.registerBuiltinHandler('post-compact', postCompactHandler)
  executor.registerBuiltinHandler('session-start', sessionStartHandler)
  executor.registerBuiltinHandler('session-end', sessionEndHandler)
}
