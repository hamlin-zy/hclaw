/**
 * Unified Logger — 统一结构化日志工具（Console-only）
 *
 * 统一格式：{time}-{module}-{function}-{level}-{result(JSON)}
 * Example: 2026-04-21T10:30:00.000Z-app-init-db-info-{success:true}
 *
 * Log levels:
 * - info:   Normal operational events (console.log)
 * - warn:   Warning conditions (console.warn)
 * - error:  Error conditions (console.error)
 * - debug:  Debug information (console.log, only in development)
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
    time: string
    module: string
    function: string
    level: LogLevel
    result: Record<string, unknown>
}

// ─── 格式化 ─────────────────────────────────────────────────────

function formatLogEntry(entry: LogEntry): string {
    const {time, module, function: fn, level, result} = entry
    const resultStr = JSON.stringify(result)
    return `${time}-${module}-${fn}-${level}-${resultStr}`
}

function getTimestamp(): string {
    return new Date().toISOString()
}

// ─── Logger 工厂 ────────────────────────────────────────────────

export function createLogger(module: string) {
    return {
        info(functionName: string, result?: Record<string, unknown>): void {
            const entry: LogEntry = {
                time: getTimestamp(),
                module,
                function: functionName,
                level: 'info',
                result: result || {},
            }
            console.log(formatLogEntry(entry))
        },

        warn(functionName: string, result?: Record<string, unknown>): void {
            const entry: LogEntry = {
                time: getTimestamp(),
                module,
                function: functionName,
                level: 'warn',
                result: result || {},
            }
            console.warn(formatLogEntry(entry))
        },

        error(functionName: string, result?: Record<string, unknown>): void {
            const entry: LogEntry = {
                time: getTimestamp(),
                module,
                function: functionName,
                level: 'error',
                result: result || {},
            }
            console.error(formatLogEntry(entry))
        },

        debug(functionName: string, result?: Record<string, unknown>): void {
            // Only output in development mode or when DEBUG is set
            if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
                const entry: LogEntry = {
                    time: getTimestamp(),
                    module,
                    function: functionName,
                    level: 'debug',
                    result: result || {},
                }
                console.log(formatLogEntry(entry))
            }
        },
    }
}

/**
 * Default logger instance for general use
 */
export const logger = createLogger('app')
