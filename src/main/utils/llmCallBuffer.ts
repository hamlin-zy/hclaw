/**
 * LLM 调用日志缓冲模块
 *
 * 内存缓冲用于日志窗口实时推送，写入采用每次追加（低频低量，开销可忽略）。
 * 日志格式：JSONL（每行一个 JSON 对象）
 */

import fs from 'fs'
import path from 'path'
import {app, BrowserWindow, ipcMain} from 'electron'
import {randomUUID} from 'crypto'
import type {LlmCallLog} from '@shared/types'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'

const CONFIG_KEY = 'llmLogEnabled'

/** 惰性获取日志文件路径（避免在 app 就绪前访问） */
function getLogFile(): string {
    return path.join(app.getPath('userData'), 'logs', 'llm-calls.jsonl')
}

let buffer: LlmCallLog[] = []
let logWindow: BrowserWindow | null = null

/**
 * 获取日志开关状态
 */
export function isLlmLogEnabled(): boolean {
    return systemSettingsRepo.getJson<boolean>(CONFIG_KEY) ?? false
}

/**
 * 设置日志开关状态
 */
export function setLlmLogEnabled(enabled: boolean): void {
    systemSettingsRepo.setJson(CONFIG_KEY, enabled)
    // 如果关闭，清空缓冲区
    if (!enabled) {
        flush()
    }
}

/**
 * 添加日志到缓冲区
 */
export function addToBuffer(entry: Omit<LlmCallLog, 'id' | 'timestamp'>): LlmCallLog | null {
    // 检查开关状态
    if (!isLlmLogEnabled()) {
        return null
    }

    const log: LlmCallLog = {
        ...entry,
        id: randomUUID(),
        timestamp: Date.now(),
    }

    buffer.unshift(log)

    // 通知日志窗口
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('llm-call-log', log)
    }

    // 每次写入立即落盘（低频低量，appendFileSync 开销可忽略）；buffer 仅用于
    // 窗口实时推送，退出时 flush 兜底。此前「buffer 满 100 才刷盘」会导致
    // 低量日志滞留内存，进程不退出时日志文件为空。
    flush()

    return log
}

/**
 * 刷新缓冲区到磁盘
 */
export function flush(): void {
    if (buffer.length === 0) return

    try {
        const dir = path.dirname(getLogFile())
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true})
        }

        const lines = buffer.map(b => JSON.stringify(b)).join('\n') + '\n'
        fs.appendFileSync(getLogFile(), lines, 'utf-8')
        buffer = []
    } catch (err) {
        console.error('[llmCallBuffer] flush failed:', err)
    }
}

/**
 * 设置日志窗口引用
 */
export function setLogWindow(win: BrowserWindow | null): void {
    logWindow = win
    if (win === null) {
        flush() // 窗口关闭时刷盘
    }
}

/**
 * 加载最近的日志（从文件末尾读取）
 */
export function loadRecentLogs(limit: number = 500): LlmCallLog[] {
    try {
        if (!fs.existsSync(getLogFile())) return []

        const content = fs.readFileSync(getLogFile(), 'utf-8')
        const lines = content.trim().split('\n').filter(Boolean)
        const logs: LlmCallLog[] = []

        for (let i = lines.length - 1; i >= 0 && logs.length < limit; i--) {
            try {
                logs.unshift(JSON.parse(lines[i]))
            } catch {
                // 忽略解析错误
            }
        }

        return logs
    } catch {
        return []
    }
}

/**
 * 清空所有日志
 */
export function clearLogs(): void {
    buffer = []
    try {
        if (fs.existsSync(getLogFile())) {
            fs.unlinkSync(getLogFile())
        }
    } catch {
        // 忽略删除错误
    }
}

/**
 * 检查是否需要迁移旧格式日志
 */
function migrateIfNeeded(): void {
    const oldFile = path.join(app.getPath('userData'), 'logs', 'llm-calls.json')
    const newFile = getLogFile()

    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
        try {
            const content = fs.readFileSync(oldFile, 'utf-8')
            const logs: LlmCallLog[] = JSON.parse(content)

            // 写入 JSONL 格式
            const lines = logs.map(l => JSON.stringify(l)).join('\n') + '\n'
            fs.writeFileSync(newFile, lines, 'utf-8')

            // 删除旧文件
            fs.unlinkSync(oldFile)
            console.log('[llmCallBuffer] Migration completed: llm-calls.json -> llm-calls.jsonl')
        } catch (err) {
            console.error('[llmCallBuffer] migration failed:', err)
        }
    }
}

/**
 * 注册日志开关 IPC handlers
 */
export function initLlmLogIPC(): void {
    // 迁移旧格式日志（此时 app 已 ready）
    migrateIfNeeded()

    // 注册退出前刷盘
    app.on('before-quit', flush)

    ipcMain.handle('llm-log:enabled', () => {
        return isLlmLogEnabled()
    })

    ipcMain.handle('llm-log:toggle', (_event, enabled: boolean) => {
        setLlmLogEnabled(enabled)
        return true
    })
}
