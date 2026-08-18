/**
 * 用量统计独立窗口
 * 照 createLlmLogsWindow 模式：注入主题 + 注册 usage-stats:query IPC。
 * 无边框窗口参考主窗口 window.ts：非 macOS 用 frame:false + 自定义标题栏，
 * 窗口控制走本窗口专属 IPC（避免与主窗口 minimize/maximize/close 通道冲突）。
 */
import {BrowserWindow, ipcMain} from 'electron'
import path from 'path'
import os from 'os'
import {getAppIconPath} from './icon'
import {readThemeSetting} from './theme'
import {llmUsageRepo} from '../repositories/sqlite/llmUsageRepository'
import {modelMetaRegistry} from '../modelMetaRegistry'
import type {GlobalUsageStats, TimeRange} from '@shared/types'

let usageWindow: BrowserWindow | null = null

export function createUsageWindow(_getMainWindow: () => BrowserWindow | null): void {
    const iconPath = getAppIconPath()
    const {backgroundColor, rawTheme} = readThemeSetting()

    // 平台检测（与主窗口一致）
    const isMac = process.platform === 'darwin'
    let isWin11 = false
    if (process.platform === 'win32') {
        const winBuild = parseInt(os.release().split('.')[2] || '0', 10)
        isWin11 = winBuild >= 22000
    }

    usageWindow = new BrowserWindow({
        width: 1200,
        height: 700,
        minWidth: 800,
        minHeight: 400,
        icon: iconPath,
        backgroundColor: backgroundColor === 'dark' ? '#1e1e1e' : '#ffffff',

        // 无边框窗口（参考主窗口）：Windows/Linux 移除原生框架，macOS 保留交通灯
        ...(isMac
            ? {titleBarStyle: 'hiddenInset' as const}
            : {frame: false}
        ),
        transparent: false,
        roundedCorners: isMac || isWin11,

        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            additionalArguments: [
                `--hclaw-theme=${rawTheme}`,
                `--hclaw-win11=${isWin11 ? '1' : '0'}`,
                `--hclaw-darwin=${isMac ? '1' : '0'}`,
            ],
        },
        show: false,
        title: '用量统计',
    })

    usageWindow.setMenu(null)
    usageWindow.setMenuBarVisibility(false)
    usageWindow.once('ready-to-show', () => usageWindow?.show())
    usageWindow.on('closed', () => { usageWindow = null })

    // 最大化状态广播给渲染进程（更新最大化/还原按钮）
    usageWindow.on('maximize', () => usageWindow?.webContents.send('usage-window-maximized-changed', true))
    usageWindow.on('unmaximize', () => usageWindow?.webContents.send('usage-window-maximized-changed', false))

    const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--inspect')
    if (isDev) {
        usageWindow.loadURL('http://localhost:5173/usage.html')
        usageWindow.webContents.openDevTools({mode: 'detach'})
    } else {
        usageWindow.loadFile(path.join(__dirname, '../renderer/main_window/usage.html'))
    }
}

export function openUsageWindow(getMainWindow: () => BrowserWindow | null): void {
    if (usageWindow && !usageWindow.isDestroyed()) {
        usageWindow.focus()
        return
    }
    createUsageWindow(getMainWindow)
}

/** 注册 IPC（main/index.ts 调用） */
export function initUsageStatsIPC(getMainWindow: () => BrowserWindow | null): void {
    ipcMain.handle('open-usage-stats-window', () => {
        openUsageWindow(getMainWindow)
    })

    // 用量统计窗口专属窗口控制（避免与主窗口通道冲突）
    ipcMain.handle('usage-window:minimize', () => {
        usageWindow?.minimize()
    })

    ipcMain.handle('usage-window:maximize', () => {
        if (!usageWindow || usageWindow.isDestroyed()) return
        if (usageWindow.isMaximized()) {
            usageWindow.unmaximize()
        } else {
            usageWindow.maximize()
        }
    })

    ipcMain.handle('usage-window:close', () => {
        usageWindow?.close()
    })

    ipcMain.handle('usage-window:is-maximized', () => {
        return usageWindow?.isMaximized() ?? false
    })

    ipcMain.handle('usage-stats:query', (_event, params: {range: TimeRange; view: 'provider' | 'model'}) => {
        const breakdown = llmUsageRepo.queryAggregated(
            {range: params.range, view: params.view},
            (model) => modelMetaRegistry.getMeta(model),
        )
        const trend = llmUsageRepo.queryTrend({range: params.range})
        const allRows = llmUsageRepo.queryAggregated({range: params.range, view: 'model'}, (model) => modelMetaRegistry.getMeta(model))

        const totalTokens = allRows.reduce((s, b) => s + b.totalTokens, 0)
        const totalCostUsd = allRows.reduce((s, b) => s + b.costUsd, 0)
        const requestCount = allRows.reduce((s, b) => s + b.requestCount, 0)
        const inputTokens = allRows.reduce((s, b) => s + b.inputTokens, 0)
        const cacheReadTokens = allRows.reduce((s, b) => s + b.cacheReadTokens, 0)
        const cacheHitRate = inputTokens + cacheReadTokens > 0
            ? Math.round(cacheReadTokens / (inputTokens + cacheReadTokens) * 100)
            : null

        const result: GlobalUsageStats = {kpi: {totalTokens, totalCostUsd, requestCount, cacheHitRate}, trend, breakdown}
        return result
    })
}
