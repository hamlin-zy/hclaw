/**
 * 用量统计独立窗口
 * 窗口创建、无边框、主题注入与窗口控制 IPC 统一由 windowFactory 处理；
 * 本模块只维护窗口单例与数据 IPC（usage-stats:query）。
 */
import {BrowserWindow, ipcMain} from 'electron'
import {createAppWindow} from './windowFactory'
import {llmUsageRepo} from '../repositories/sqlite/llmUsageRepository'
import {modelMetaRegistry} from '../modelMetaRegistry'
import type {GlobalUsageStats, TimeRange} from '@shared/types'

let usageWindow: BrowserWindow | null = null

export function createUsageWindow(): void {
    usageWindow = createAppWindow({
        id: 'usage-window',
        title: '用量统计',
        entryHtml: 'usage.html',
        width: 1200,
        height: 700,
        minWidth: 800,
        minHeight: 400,
    })
    usageWindow.on('closed', () => { usageWindow = null })
}

export function openUsageWindow(): void {
    if (usageWindow && !usageWindow.isDestroyed()) {
        usageWindow.focus()
        return
    }
    createUsageWindow()
}

/** 注册 IPC（main/index.ts 调用） */
export function initUsageStatsIPC(): void {
    ipcMain.handle('open-usage-stats-window', () => {
        openUsageWindow()
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
