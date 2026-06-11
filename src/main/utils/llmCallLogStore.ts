/**
 * LLM 调用日志存储
 *
 * 基于 llmCallBuffer 模块的缓冲写入，减少同步 I/O 阻塞
 */

import {BrowserWindow, ipcMain} from 'electron'
import type {LlmCallLog} from '@shared/types'
import {
    addToBuffer,
    clearLogs,
    createLlmLogsWindow as createWindow,
    flush,
    loadRecentLogs,
    setLogWindow
} from './llmCallBuffer'

let logWindow: BrowserWindow | null = null

/**
 * 添加 LLM 调用日志
 */
export function addLlmCallLog(log: Omit<LlmCallLog, 'id' | 'timestamp'>): LlmCallLog | null {
    return addToBuffer(log)
}

/**
 * 获取所有 LLM 调用日志
 */
export function getLlmCallLogs(): LlmCallLog[] {
    return loadRecentLogs(500)
}

/**
 * 清空所有 LLM 调用日志
 */
export function clearLlmCallLogs(): void {
    clearLogs()
}

/**
 * 设置日志窗口引用
 */
export function setLogWindowRef(win: BrowserWindow | null): void {
    logWindow = win
    setLogWindow(win)
}

/**
 * 注册 IPC handlers
 */
export function initLlmCallLogIPC(getMainWindow: () => BrowserWindow | null): void {
    ipcMain.handle('llm-call-logs:get', () => {
        return getLlmCallLogs()
    })

    ipcMain.handle('llm-call-logs:clear', () => {
        clearLlmCallLogs()
        return true
    })

    ipcMain.handle('open-llm-logs-window', () => {
        if (logWindow && !logWindow.isDestroyed()) {
            logWindow.focus()
            return
        }
        createWindow(getMainWindow)
    })
}

/**
 * 创建 LLM 日志窗口
 */
export {createLlmLogsWindow} from './llmCallBuffer'

/**
 * 刷新缓冲区到磁盘
 */
export {flush}
