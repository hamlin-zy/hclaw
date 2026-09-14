/**
 * 冷启动时间线打点模块（纯主进程文件日志）
 *
 * 设计约束（刻意为之）：
 *   - 不 import electron：本模块会被任意主进程模块安全引用；IPC 注册放在 index.ts。
 *   - 零功能影响：只做观测，失败必须完全静默（永不抛异常、永不阻塞启动）。
 *   - 非阻塞落盘：fs.promises.appendFile 追加，不 await、失败静默。
 *   - 落盘路径：<getHclawDir()>/logs/app.log
 *
 * 每行格式（便于 grep）：
 *   [2026-09-14T11:20:51.601Z] [+1234.5ms] label {"k":"v"}
 * 其中 +xxx.xms 为相对「首次调用 trace() 的时刻」的耗时；第一行额外附 process.uptime()，
 * 用于标定「进程启动 → 首次打点」的耗时。
 */

import * as fs from 'fs'
import * as path from 'path'
import {getHclawDir} from './config'

/** 首次调用 trace() 的时刻（用于计算相对耗时）；null 表示尚未调用 */
let t0: number | null = null
/** 是否为第一次 trace 调用（第一行额外附上 process.uptime()） */
let isFirstTrace = true
/** 目录创建 / 轮转是否已执行（仅首次写入前做一次） */
let initialized = false
/** 已进入缓冲、异步落盘尚未确认的行；flush 时同步补写，避免退出丢尾 */
const pendingLines: string[] = []

/** 日志目录 */
function getLogsDir(): string {
    return path.join(getHclawDir(), 'logs')
}

/** 日志文件路径 */
function getLogFilePath(): string {
    return path.join(getLogsDir(), 'app.log')
}

/**
 * 首次写入前：确保日志目录存在 + 文件超过 2MB 时轮转为 app.log.1（覆盖旧 .1）。
 * 全程 try/catch，失败静默——目录/轮转失败不影响启动。
 */
function ensureInitialized(): void {
    if (initialized) return
    initialized = true
    try {
        const logsDir = getLogsDir()
        fs.mkdirSync(logsDir, {recursive: true})
        const logFile = path.join(logsDir, 'app.log')
        const stat = fs.statSync(logFile, {throwIfNoEntry: false})
        if (stat && stat.size > 2 * 1024 * 1024) {
            fs.renameSync(logFile, path.join(logsDir, 'app.log.1'))
        }
    } catch {
        // 目录创建/轮转失败不影响启动，静默
    }
}

/** JSON 序列化兜底：循环引用等异常时退化为 String()，绝不抛出 */
function safeStringify(data: Record<string, unknown>): string {
    try {
        return JSON.stringify(data)
    } catch {
        return String(data)
    }
}

/** 记录一条启动打点（非阻塞、失败静默、永不抛出） */
export function trace(label: string, data?: Record<string, unknown>): void {
    try {
        const now = Date.now()
        if (t0 === null) t0 = now

        let payload = data
        if (isFirstTrace) {
            isFirstTrace = false
            // 第一行附上 process.uptime()，便于标定「进程启动 → 首次打点」的耗时
            payload = {uptime: process.uptime(), ...(data ?? {})}
        }

        const elapsedMs = now - t0
        const line = `[${new Date(now).toISOString()}] [+${elapsedMs.toFixed(1)}ms] ${label}`
            + (payload !== undefined ? ` ${safeStringify(payload)}` : '')
            + '\n'

        ensureInitialized()
        pendingLines.push(line)

        // 异步落盘确认后从缓冲移除（成功/失败都移除，避免 flush 重复写）
        const drop = (): void => {
            const idx = pendingLines.indexOf(line)
            if (idx >= 0) pendingLines.splice(idx, 1)
        }
        // 非阻塞追加：不 await，失败静默
        fs.promises.appendFile(getLogFilePath(), line, 'utf8').then(drop, drop)
    } catch {
        // 打点失败绝不影响启动
    }
}

/** 退出前把缓冲中尚未落盘的行同步刷出（供 app.on('will-quit') 调用） */
export function flushStartupTraceSync(): void {
    if (pendingLines.length === 0) return
    try {
        ensureInitialized()
        const remaining = pendingLines.splice(0, pendingLines.length).join('')
        fs.appendFileSync(getLogFilePath(), remaining, 'utf8')
    } catch {
        // 静默
    }
}
