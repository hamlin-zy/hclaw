// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import UsageWindow from '../../../../src/renderer/components/usage/UsageWindow'
import type {GlobalUsageStats} from '@shared/types'

const mockStats: GlobalUsageStats = {
    kpi: {totalTokens: 27790000, totalCostUsd: 12.88, requestCount: 267, cacheHitRate: 93},
    trend: [
        {day: '2026-08-10', inputTokens: 1000000, outputTokens: 200000, cacheReadTokens: 5000000},
        {day: '2026-08-11', inputTokens: 1200000, outputTokens: 240000, cacheReadTokens: 6000000},
    ],
    breakdown: [
        {key: 'anthropic', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 196, inputTokens: 1350000, outputTokens: 260000, cacheReadTokens: 22100000, cacheWriteTokens: 0, totalTokens: 23710000, costUsd: 10.71},
        {key: 'openai', providerType: 'openai', providerName: 'OpenAI', requestCount: 71, inputTokens: 510000, outputTokens: 90000, cacheReadTokens: 3500000, cacheWriteTokens: 0, totalTokens: 4100000, costUsd: 2.17},
    ],
}

/** 统一访问被 stub 的 electronAPI，消除测试体内重复的 `as any` 断言噪音 */
const api = (): any => window.electronAPI

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        usageStatsQuery: vi.fn().mockResolvedValue(mockStats),
        initialTheme: 'dark',
        onThemeChanged: vi.fn(),
        // 无边框窗口控制 API
        usageWindowMinimize: vi.fn(),
        usageWindowMaximize: vi.fn(),
        usageWindowClose: vi.fn(),
        usageWindowIsMaximized: vi.fn().mockResolvedValue(false),
        onUsageWindowMaximizedChange: vi.fn().mockReturnValue(() => {}),
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    // 恢复 vi.spyOn（如 console.error），防止断言失败提前退出时泄漏到后续用例
    vi.restoreAllMocks()
})

describe('UsageWindow 全局用量窗口', () => {
    it('渲染 KPI + 趋势柱状条 + 分组表', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        expect(screen.getByText('总成本')).toBeTruthy()
        expect(screen.getByText('$12.88')).toBeTruthy()
        // 趋势柱状条按天渲染
        expect(screen.getAllByTestId('trend-bar')).toHaveLength(2)
        // 分组表按服务商
        // 服务商名优先 providers.name（Deepseek-ant），而非 providers.type 规范名（Anthropic）
        expect(screen.getByText('Deepseek-ant')).toBeTruthy()
        expect(screen.queryByText('Anthropic')).toBeNull()
        expect(screen.getByText('OpenAI')).toBeTruthy()
        // 成本口径说明（圆圈问号）存在
        expect(screen.getByRole('img', {name: '成本口径说明'})).toBeTruthy()
    })

    it('切换视图（按模型）→ 重新查询', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        fireEvent.click(screen.getByText('按模型'))
        await waitFor(() => {
            expect(api().usageStatsQuery).toHaveBeenLastCalledWith({range: '7d', view: 'model'})
        })
    })

    it('切换时间范围 → 重新查询', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        fireEvent.click(screen.getByText('近 30 天'))
        await waitFor(() => {
            expect(api().usageStatsQuery).toHaveBeenLastCalledWith({range: '30d', view: 'provider'})
        })
    })

    it('按模型视图：同名模型跨服务商时 React key 唯一，不产生重复 key 警告', async () => {
        // 真实数据：deepseek-v4-flash 同时出现在 anthropic 与 openai 两个 provider_type 下
        const modelStats: GlobalUsageStats = {
            ...mockStats,
            breakdown: [
                {key: 'deepseek-v4-flash', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 332, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 1500, costUsd: 1},
                {key: 'deepseek-v4-flash', providerType: 'openai', providerName: 'GO-OpenAI', requestCount: 3, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, costUsd: 0.5},
            ],
        }
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        api().usageStatsQuery = vi.fn().mockResolvedValue(modelStats)
        render(<UsageWindow />)
        fireEvent.click(screen.getByText('按模型'))
        await waitFor(() => {
            expect(api().usageStatsQuery).toHaveBeenLastCalledWith({range: '7d', view: 'model'})
        })
        // 两行同名模型都应渲染，且不触发 React 重复 key 警告
        expect(screen.getAllByText('deepseek-v4-flash')).toHaveLength(2)
        const dupKeyWarning = errorSpy.mock.calls.some(c => String(c[0]).includes('same key'))
        expect(dupKeyWarning).toBe(false)
    })

    it('切换货币 → 美元/人民币换算（KPI + 明细成本列）', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('$12.88')).toBeTruthy())
        // 默认美元计价，无 CNY 换算说明
        expect(screen.queryByText('按 1 USD ≈ 7.2 CNY')).toBeNull()

        fireEvent.click(screen.getByTestId('currency-cny'))
        // 总成本：12.88 * 7.2 = 92.736 → ¥92.74
        await waitFor(() => expect(screen.getByText('¥92.74')).toBeTruthy())
        expect(screen.queryByText('$12.88')).toBeNull()
        expect(screen.getByText('按 1 USD ≈ 7.2 CNY')).toBeTruthy()
        // 明细成本列同样换算：10.71 → ¥77.11，2.17 → ¥15.62
        expect(screen.getByText('¥77.11')).toBeTruthy()
        expect(screen.getByText('¥15.62')).toBeTruthy()
    })

    it('窗口控制按钮 → 触发对应 IPC', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('$12.88')).toBeTruthy())
        fireEvent.click(screen.getByLabelText('最小化'))
        fireEvent.click(screen.getByLabelText('最大化'))
        fireEvent.click(screen.getByLabelText('关闭'))
        expect(api().usageWindowMinimize).toHaveBeenCalledTimes(1)
        expect(api().usageWindowMaximize).toHaveBeenCalledTimes(1)
        expect(api().usageWindowClose).toHaveBeenCalledTimes(1)
    })

    it('查询失败 → 显示错误提示', async () => {
        api().usageStatsQuery = vi.fn().mockRejectedValue(new Error('fail'))
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('统计数据加载失败')).toBeTruthy())
    })

    it('空 breakdown → 暂无用量数据', async () => {
        api().usageStatsQuery = vi.fn().mockResolvedValue({...mockStats, breakdown: []})
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('暂无用量数据')).toBeTruthy())
    })

    it('最大化状态 → 按钮在「最大化/还原」间切换', async () => {
        // 捕获主进程广播的最大化状态变更回调
        let maxChangedHandler: ((v: boolean) => void) | undefined
        api().onUsageWindowMaximizedChange = vi.fn((cb: (v: boolean) => void) => {
            maxChangedHandler = cb
            return () => {}
        })
        api().usageWindowIsMaximized = vi.fn().mockResolvedValue(false)

        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByLabelText('最大化')).toBeTruthy())
        expect(screen.queryByLabelText('还原')).toBeNull()

        // 模拟主进程推送 maximize 事件 → 图标切换为「还原」
        await act(async () => {
            maxChangedHandler!(true)
        })
        expect(screen.getByLabelText('还原')).toBeTruthy()
        expect(screen.queryByLabelText('最大化')).toBeNull()

        // 模拟 unmaximize → 切回「最大化」
        await act(async () => {
            maxChangedHandler!(false)
        })
        expect(screen.getByLabelText('最大化')).toBeTruthy()
        expect(screen.queryByLabelText('还原')).toBeNull()
    })
})
