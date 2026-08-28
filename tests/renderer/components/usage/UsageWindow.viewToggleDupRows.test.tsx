// @vitest-environment jsdom
// 复现测试：来回切换 按服务商/按模型，服务商明细第一条数据是否重复（每切换一次多一条）
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import UsageWindow from '../../../../src/renderer/components/usage/UsageWindow'
import {setUsdCnyRate} from '../../../../src/renderer/lib/format'
import {DEFAULT_USD_CNY_RATE} from '@shared/exchangeRate'
import type {GlobalUsageStats, UsageStatsQueryParams} from '@shared/types'

/** 模拟主进程 queryAggregated 输出：view=provider 已按服务商合并；view=model 原始 (provider,model) 行 */
function serverResult(params: UsageStatsQueryParams): GlobalUsageStats {
    const providerRows: GlobalUsageStats['breakdown'] = [
        // 真实 DB 形态：同名服务商两组（provider_id NULL / 非 NULL）→ 服务端 mergeByProvider 已合并为一行
        {key: 'OpenRouter', providerType: undefined as any, providerName: 'OpenRouter', providerId: '8a3b541c' as any, requestCount: 10, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0, totalTokens: 6000, costUsd: 0.6},
        // legacy 回填行形态：providerName 缺失、providerType = 历史 provider 字符串、key = 模型名
        {key: 'MiniMax-M2.7', providerType: 'MiniMax-官方', providerName: undefined as any, requestCount: 5, inputTokens: 500, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100, costUsd: 0.05},
    ]
    const modelRows: GlobalUsageStats['breakdown'] = [
        {key: 'z-ai/glm-5.3-flash', providerType: 'openai', providerName: 'OpenRouter', providerId: undefined as any, requestCount: 8, inputTokens: 800, outputTokens: 1600, cacheReadTokens: 2400, cacheWriteTokens: 0, totalTokens: 4800, costUsd: 0.5},
        {key: 'z-ai/glm-5.3-flash', providerType: 'openai', providerName: 'OpenRouter', providerId: '8a3b541c' as any, requestCount: 2, inputTokens: 200, outputTokens: 400, cacheReadTokens: 600, cacheWriteTokens: 0, totalTokens: 1200, costUsd: 0.1},
        {key: 'MiniMax-M2.7', providerType: 'MiniMax-官方', providerName: undefined as any, requestCount: 5, inputTokens: 500, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100, costUsd: 0.05},
    ]
    return {
        kpi: {totalTokens: 7100, totalCostUsd: 0.65, requestCount: 15, cacheHitRate: 0, totalOutputTokens: 2600, totalDecodeMs: 0, totalTtftMs: 0, ttftCount: 0, avgDecodeRate: null, avgTtftSeconds: null},
        trend: [{day: '2026-08-28 10:00', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000}],
        breakdown: params.view === 'provider' ? providerRows : modelRows,
    }
}

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        usageStatsQuery: vi.fn().mockImplementation((params: UsageStatsQueryParams) =>
            Promise.resolve(serverResult(params))),
        exchangeRateGet: vi.fn().mockImplementation(() =>
            new Promise((resolve) => setTimeout(() => resolve({rate: 7.2, date: null}), 0))),
        initialTheme: 'dark',
        onThemeChanged: vi.fn(),
        windowId: 'usage-window',
        windowControls: {
            minimize: vi.fn(), maximize: vi.fn(), close: vi.fn(),
            isMaximized: vi.fn().mockResolvedValue(false),
            onMaximizedChange: vi.fn().mockReturnValue(() => {}),
        },
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setUsdCnyRate(DEFAULT_USD_CNY_RATE)
})

describe('复现：视图来回切换 服务商明细重复行', () => {
    it('provider↔model 来回切换 4 次，服务商明细行数恒为 2', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('OpenRouter')).toBeTruthy())
        // 服务商明细：2 行（OpenRouter、MiniMax-官方）。用分区标题定位表格，避免 via 行文本歧义
        const rowsOf = (heading: '服务商明细' | '模型明细') => {
            const sec = screen.getByText(heading).closest('section')!
            return sec.querySelectorAll('tbody tr').length
        }
        const countRows = () => rowsOf('服务商明细')
        expect(countRows()).toBe(2)

        for (let i = 0; i < 4; i++) {
            fireEvent.click(screen.getByText('按模型'))
            await waitFor(() => expect(rowsOf('模型明细')).toBe(3))
            fireEvent.click(screen.getByText('按服务商'))
            await waitFor(() => expect(countRows()).toBeGreaterThan(0))
            console.error(`[toggle ${i + 1}] rows =`, countRows())
        }
        expect(countRows()).toBe(2)
        // 无 React 重复 key 警告
        expect(errorSpy.mock.calls.some(c => String(c[0]).includes('same key'))).toBe(false)
    })
})
