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
    flush,
    loadRecentLogs,
    setLogWindow
} from './llmCallBuffer'
import {openConfigWindow} from './configWindow'

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
 * 设置日志窗口引用（窗口创建/复用时由 openConfigWindow onCreated 回传）
 */
export function setLogWindowRef(win: BrowserWindow | null): void {
    setLogWindow(win)
}

/**
 * 注册 IPC handlers
 */
export function initLlmCallLogIPC(): void {
    ipcMain.handle('llm-call-logs:get', () => {
        return getLlmCallLogs()
    })

    ipcMain.handle('llm-call-logs:clear', () => {
        clearLlmCallLogs()
        return true
    })

    ipcMain.handle('open-llm-logs-window', () => {
        openConfigWindow('llm-logs', (win) => {
            setLogWindowRef(win)
            // 窗口关闭时置空缓冲模块的推送引用，避免向已销毁窗口发送
            // 窗口复用时本回调会重复执行，仅在尚无 closed 监听时挂载，避免监听器累积
            if (win.listenerCount('closed') === 0) {
                win.once('closed', () => setLogWindow(null))
            }
        })
    })
}

/**
 * 刷新缓冲区到磁盘
 */
export {flush}
