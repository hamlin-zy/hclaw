/**
 * 用量统计窗口
 * 窗口创建、无边框、主题注入与窗口控制 IPC 统一由 windowFactory + configWindow 注册表处理；
 * 本模块只负责打开入口与数据 IPC（usage-stats:query）。
 */
import {ipcMain} from 'electron'
import {openConfigWindow} from './configWindow'
import {llmUsageRepo} from '../repositories/sqlite/llmUsageRepository'
import {modelMetaPriceSource} from '../modelMetaRegistry'
import {buildCustomPriceEntries} from './customPriceEntries'
import {computeKpis} from '@shared/llmUsage'
import type {GlobalUsageStats, UsageStatsQueryParams} from '@shared/types'

export function openUsageWindow(): void {
    openConfigWindow('usage')
}

/** 注册 IPC（main/index.ts 调用） */
export function initUsageStatsIPC(): void {
    ipcMain.handle('open-usage-stats-window', () => {
        openUsageWindow()
    })

    ipcMain.handle('usage-stats:query', (_event, params: UsageStatsQueryParams) => {
        const {range, view, customStart, customEnd, granularity} = params
        // 自定义定价 entries（providers × models，仅含已配置 pricing 的模型）；行级 provider-aware 取价
        const customPrices = buildCustomPriceEntries()
        // provider / model 双视图一次底层扫描（消除重复行扫描），输出与分别调用两次完全一致
        const {model: allRows, provider: providerRows} = llmUsageRepo.queryAggregatedBoth(
            {range, customStart, customEnd},
            modelMetaPriceSource,
            customPrices,
        )
        const breakdown = view === 'provider' ? providerRows : allRows
        const trend = llmUsageRepo.queryTrend({range, customStart, customEnd, granularity})

        // KPI 原始累加值：单次遍历汇总（平均吞吐/首字由 computeKpis 统一口径，渲染层直接消费 kpi 字段）
        const totals = {
            totalTokens: 0, totalCostUsd: 0, requestCount: 0, inputTokens: 0,
            cacheReadTokens: 0, totalOutputTokens: 0, totalDecodeMs: 0, totalTtftMs: 0, ttftCount: 0,
        }
        for (const b of allRows) {
            totals.totalTokens += b.totalTokens
            totals.totalCostUsd += b.costUsd
            totals.requestCount += b.requestCount
            totals.inputTokens += b.inputTokens
            totals.cacheReadTokens += b.cacheReadTokens
            totals.totalOutputTokens += b.outputTokens
            totals.totalDecodeMs += b.decodeMs ?? 0
            totals.totalTtftMs += b.ttftMs ?? 0
            totals.ttftCount += b.ttftCount ?? 0
        }
        // KPI 统一口径（弹窗 / 窗口共用 computeKpis）：缓存命中率 + 平均吞吐 + 平均首字
        const kpis = computeKpis({inputTokens: totals.inputTokens, outputTokens: totals.totalOutputTokens, cacheReadTokens: totals.cacheReadTokens, totalDecodeMs: totals.totalDecodeMs, totalTtftMs: totals.totalTtftMs, ttftCount: totals.ttftCount})

        const result: GlobalUsageStats = {
            kpi: {
                ...totals, cacheHitRate: kpis.cacheHitRate,
                avgDecodeRate: kpis.avgDecodeRate, avgTtftSeconds: kpis.avgTtftSeconds,
            },
            trend, breakdown,
        }
        return result
    })
}
