/**
 * Unified Logger — 统一结构化日志工具
 *
 * 统一格式：{time}-{module}-{function}-{result(JSON)}
 * Example: 2026-04-21T10:30:00.000Z-app-init-db-{success:true}
 *
 * Log levels:
 * - info: Normal operational events (file only, no console)
 * - warn: Warning conditions (file + console)
 * - error: Error conditions (file + console)
 * - debug: Debug information (file only, only in development)
 *
 * 文件日志：
 * - 写入 {hclawDir}/logs/app.log
 * - 缓冲异步写入，每秒刷盘一次，避免同步 I/O 阻塞事件循环
 * - 文件达到 MAX_FILE_SIZE 时自动轮转 (app.log.1, app.log.2, ...)
 * - 最大保留 MAX_FILES 个旧日志文件
 * - 进程退出时同步刷盘，保证最后一批日志不丢失
 */

import * as fs from 'fs'
import * as path from 'path'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
    time: string
    module: string
    function: string
    level: LogLevel
    result: Record<string, unknown>
}

/** 日志文件最大 10MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024
/** 最多保留 3 个轮转文件 (app.log, app.log.1, app.log.2) */
const MAX_FILES = 3
/** 缓存日志文件路径，避免重复解析 */
let _logFilePath: string | null = null

// ─── 异步日志缓冲区 ─────────────────────────────────────────────

/**
 * 日志缓冲区 — 批量异步写入文件
 *
 * 替代原始的逐条 fs.appendFileSync，将多条日志合并为一次异步写入，
 * 避免同步 I/O 阻塞主进程事件循环，显著降低 CPU 占用。
 */
class LogBuffer {
    private buffer: string[] = []
    private timer: ReturnType<typeof setTimeout> | null = null
    private readonly FLUSH_INTERVAL_MS = 1000
    private readonly MAX_BUFFER_SIZE = 100

    push(line: string): void {
        this.buffer.push(line)
        if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
            this.flushAsync()
        } else if (!this.timer) {
            this.timer = setTimeout(() => this.flushAsync(), this.FLUSH_INTERVAL_MS)
        }
    }

    private flushAsync(): void {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        const lines = this.buffer.splice(0)
        if (lines.length === 0) return

        const filePath = getLogFilePath()
        if (!filePath) return

        rotateLogFile(filePath)

        // 异步写入 — 不阻塞事件循环
        fs.promises.appendFile(filePath, lines.join(''), 'utf-8').catch(() => {
        })
    }

    /** 进程退出前同步刷盘，保证最后一批日志不丢失 */
    flushSync(): void {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        const lines = this.buffer.splice(0)
        if (lines.length === 0) return

        const filePath = getLogFilePath()
        if (!filePath) return

        rotateLogFile(filePath)
        try {
            fs.appendFileSync(filePath, lines.join(''), 'utf-8')
        } catch { /* ignore */
        }
    }
}

const logBuffer = new LogBuffer()

// 进程退出前同步刷盘
process.on('beforeExit', () => logBuffer.flushSync())
process.on('exit', () => logBuffer.flushSync())

// ─── 文件路径 ───────────────────────────────────────────────────

function getLogFilePath(): string | null {
    if (_logFilePath) return _logFilePath
    try {
        const {getHclawDir} = require('../../config')
        const hclawDir = getHclawDir()
        const logsDir = path.join(hclawDir, 'logs')
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, {recursive: true})
        }
        _logFilePath = path.join(logsDir, 'app.log')
    } catch {
        // config 系统尚未初始化，跳过文件日志
        return null
    }
    return _logFilePath
}

/** 轮转日志文件（调用方确保已持有 logFilePath） */
function rotateLogFile(logFilePath: string): void {
    try {
        const stat = fs.statSync(logFilePath)
        if (stat.size < MAX_FILE_SIZE) return
    } catch {
        return
    }

    const oldestFile = `${logFilePath}.${MAX_FILES - 1}`
    try {
        fs.unlinkSync(oldestFile)
    } catch { /* ignore */
    }

    for (let i = MAX_FILES - 2; i >= 1; i--) {
        const src = `${logFilePath}.${i}`
        const dst = `${logFilePath}.${i + 1}`
        try {
            fs.renameSync(src, dst)
        } catch { /* ignore */
        }
    }

    try {
        fs.renameSync(logFilePath, `${logFilePath}.1`)
    } catch { /* ignore */
    }
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

/**
 * Create a logger instance for a specific module
 *
 * CPU 优化说明：
 * - info / debug：仅写入文件，不输出 console → 减少 80% 的 Electron IPC 流量
 * - warn / error：保留 console 输出（开发阶段需要关注的关键信息）
 * - 文件写入使用缓冲异步模式，不再阻塞事件循环
 */
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
            // 不输出 console — 消除 IPC 开销，DevTools 不再被 info 日志刷屏
            logBuffer.push(formatLogEntry(entry) + '\n')
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
            logBuffer.push(formatLogEntry(entry) + '\n')
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
            logBuffer.push(formatLogEntry(entry) + '\n')
        },

        debug(functionName: string, result?: Record<string, unknown>): void {
            if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
                const entry: LogEntry = {
                    time: getTimestamp(),
                    module,
                    function: functionName,
                    level: 'debug',
                    result: result || {},
                }
                // debug 也不输出 console，仅在开发环境写文件
                logBuffer.push(formatLogEntry(entry) + '\n')
            }
        },
    }
}

/**
 * Default logger instance for general use
 * Backward compatibility with the old API
 */
export const logger = createLogger('app')
