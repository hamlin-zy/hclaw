/**
 * 冷启动时间线打点模块（纯主进程文件日志）
 *
 * 设计约束（刻意为之）：
 *   - 不 import electron：本模块会被任意主进程模块安全引用；IPC 注册放在 index.ts。
 *   - 不 import config：tray.ts / window.ts 也引用本模块，若此处静态 import config
 *     会形成 tray → startupTrace → config → runtimeConfigManager → modelSchemeManager
 *     → googleAuth → window → tray 等新增循环（见 npm run lint:deps）。
 *     日志目录改由主进程入口经 setStartupTraceDir() 注入（与 initProgress 的传输注入同款）。
 *   - 零功能影响：只做观测，失败必须完全静默（永不抛异常、永不阻塞启动）。
 *   - 非阻塞落盘：fs.promises.appendFile 追加，不 await、失败静默。
 *   - 落盘路径：<注入的 hclawDir>/logs/app.log（未注入时回退 ~/.hclaw/logs）
 *
 * 每行格式（便于 grep）：
 *   [2026-09-14T11:20:51.601Z] [+1234.5ms] label {"k":"v"}
 * 其中 +xxx.xms 为相对「首次调用 trace() 的时刻」的耗时；第一行额外附 process.uptime()，
 * 用于标定「进程启动 → 首次打点」的耗时。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/** 首次调用 trace() 的时刻（用于计算相对耗时）；null 表示尚未调用 */
let t0: number | null = null
/** 是否为第一次 trace 调用（第一行额外附上 process.uptime()） */
let isFirstTrace = true
/** 目录创建 / 轮转是否已执行（仅首次写入前做一次） */
let initialized = false
/** 已进入缓冲、异步落盘尚未确认的行；flush 时同步补写，避免退出丢尾 */
const pendingLines: string[] = []

/**
 * 由主进程入口注入的日志根目录（见文件头：刻意不 import config 以避开循环依赖）。
 * 入口在首条打点前调用 setStartupTraceDir(path.join(getHclawDir(), 'logs'))，
 * 因此正常启动路径下始终使用真实的 hclaw 目录（含用户自定义路径）。
 */
let injectedLogsDir: string | null = null

/** 注入日志目录（主进程入口调用；幂等，重复调用以最后一次为准） */
export function setStartupTraceDir(dir: string): void {
    injectedLogsDir = dir
}

/** 日志目录（未注入时回退默认 ~/.hclaw/logs，仅用于异常路径兜底） */
function getLogsDir(): string {
    return injectedLogsDir ?? path.join(os.homedir(), '.hclaw', 'logs')
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

/**
 * ── 事件循环饥饿看门狗 ──
 *
 * 25ms 心跳；若两次心跳间隔远大于 25ms，说明主线程被同步代码连续占用（Electron 主进程
 * 与浏览器进程同线程，期间渲染进程 spawn、ready-to-show 的 IPC 全部被推迟）。
 * 触发时记录 gapMs（饥饿时长）与 lastTraceLabel（饥饿前最后一个打点），
 * 从而把「窗口为什么晚出现」精确定位到某一次调用。
 */
let watchdogStarted = false
let lastWatchdogAt = 0
let lastTraceLabel = ''

function ensureWatchdog(): void {
    if (watchdogStarted) return
    watchdogStarted = true
    lastWatchdogAt = Date.now()
    const timer = setInterval(() => {
        const now = Date.now()
        const gap = now - lastWatchdogAt
        lastWatchdogAt = now
        if (gap > 150) {
            const culprit = lastTraceLabel
            trace('main:loop-stall', {gapMs: gap, lastLabel: culprit})
            // 还原：不让看门狗自身的打点覆盖「饥饿前最后一个业务打点」
            lastTraceLabel = culprit
        }
    }, 25)
    if (typeof timer.unref === 'function') timer.unref()
}

/** 记录一条启动打点（非阻塞、失败静默、永不抛出） */
export function trace(label: string, data?: Record<string, unknown>): void {
    try {
        const now = Date.now()
        lastTraceLabel = label
        ensureWatchdog()
        if (t0 === null) t0 = now

        let payload = data
        if (isFirstTrace) {
            isFirstTrace = false
            // 第一行附上 process.uptime()，便于标定「进程启动 → 首次打点」的耗时。
            // moduleGraphEvalMs = 从 startupAnchor（首条 import 求值）到本行的耗时，
            // 即「剩余主进程模块图求值」的耗时；它 + Electron 原生启动 ≈ 进程创建→首条打点。
            const anchor = (globalThis as typeof globalThis & {__hclawStartupAnchor?: number})
                .__hclawStartupAnchor
            payload = {
                uptime: process.uptime(),
                ...(typeof anchor === 'number' ? {moduleGraphEvalMs: +(now - anchor).toFixed(1)} : {}),
                ...(data ?? {}),
            }
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
