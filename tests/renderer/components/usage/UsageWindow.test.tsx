// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import UsageWindow from '../../../../src/renderer/components/usage/UsageWindow'
import {setUsdCnyRate} from '../../../../src/renderer/lib/format'
import {DEFAULT_USD_CNY_RATE} from '@shared/exchangeRate'
import type {GlobalUsageStats} from '@shared/types'

const mockStats: GlobalUsageStats = {
    // 时序：350000 输出 / 3500000ms 解码 = 100 t/s；首字 2400ms ÷ 2 样本 = 1.2s（主进程 computeKpis 已算好 avg 字段）
    kpi: {totalTokens: 27790000, totalCostUsd: 12.88, requestCount: 267, cacheHitRate: 93, totalOutputTokens: 350000, totalDecodeMs: 3500000, totalTtftMs: 2400, ttftCount: 2, avgDecodeRate: 100, avgTtftSeconds: 1.2},
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

/** 断言最近一次查询参数 */
const lastQuery = (): any => api().usageStatsQuery.mock.calls.at(-1)[0]

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        usageStatsQuery: vi.fn().mockResolvedValue(mockStats),
        // 默认汇率 7.2 与 DEFAULT_USD_CNY_RATE 一致，保持既有 CNY 断言稳定；
        // 用 macrotask 延迟 resolve：同步渲染用例（无 waitFor）在 cleanup 后被 hook 的
        // cancelled 拦截，避免 "not wrapped in act" 警告；waitFor 用例仍会在轮询内 resolve
        exchangeRateGet: vi.fn().mockImplementation(() =>
            new Promise((resolve) => setTimeout(() => resolve({rate: 7.2, date: null}), 0))),
        initialTheme: 'dark',
        onThemeChanged: vi.fn(),
        // 通用窗口控制 API（独立窗口）
        windowId: 'usage-window',
        windowControls: {
            minimize: vi.fn(),
            maximize: vi.fn(),
            close: vi.fn(),
            isMaximized: vi.fn().mockResolvedValue(false),
            onMaximizedChange: vi.fn().mockReturnValue(() => {}),
        },
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    // 恢复 vi.spyOn（如 console.error），防止断言失败提前退出时泄漏到后续用例
    vi.restoreAllMocks()
    // 重置汇率模块变量：实时汇率同步用例会 setUsdCnyRate 污染全局，防泄漏到后续用例
    setUsdCnyRate(DEFAULT_USD_CNY_RATE)
})

describe('UsageWindow 全局用量窗口', () => {
    it('默认条件：今天 / 按服务商 / 人民币', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        // 查询参数：today + provider + hour 粒度（今天按小时）
        expect(lastQuery()).toEqual({range: 'today', view: 'provider', granularity: 'hour'})
        // 默认人民币：总成本 12.88 USD × 7.2 = ¥92.736（formatCost 保留 5 位小数）
        expect(screen.getByText('¥92.73600')).toBeTruthy()
        expect(screen.queryByText('$12.88')).toBeNull()
        // 默认选中"今天"（分段按钮激活态）
        expect(screen.getByTestId('range-today').className).toContain('bg-[var(--surface-elevated)]')
        // 趋势标题：按小时
        expect(screen.getByText('按小时')).toBeTruthy()
    })

    it('同步主进程实时汇率：CNY 成本换算与口径文案跟随实时值（向右键菜单弹窗看齐）', async () => {
        api().exchangeRateGet.mockResolvedValue({rate: 7.4, date: '2026-08-21'})
        render(<UsageWindow />)
        // 实时汇率驱动重渲染：12.88 USD × 7.4 = ¥95.312（非默认 7.2 的 ¥92.736）
        await waitFor(() => expect(screen.getByText('¥95.31200')).toBeTruthy())
        // KPI 下方汇率标注（usdCnyRate state 更新可能在下一帧，用 waitFor 等待）
        await waitFor(() => expect(screen.getByText('按 1 USD ≈ 7.40 CNY')).toBeTruthy())
        // InfoTip 口径文案嵌入实时汇率（3 处：工具栏 / 总成本 / 分组表头）
        expect(screen.getAllByText(/人民币按 1 USD ≈ 7\.40 CNY 实时汇率折算/).length).toBe(3)
    })

    it('时间按钮顺序：今天 → 昨天 → 近7天 → 近30天 → 自定义', async () => {
        render(<UsageWindow />)
        // flush 汇率同步的异步 resolve（macrotask），避免 setState 落在 act 外产生警告
        await act(async () => { await new Promise(r => setTimeout(r, 0)) })
        // 过滤栏（UsageFilterBar）的 ThemedSelect 触发器文本可能为「全部」，与时间分段
        // 按钮文本碰撞——限定在分段控件容器内查询（以 range-today 为锚点）
        const labels = ['今天', '昨天', '近 7 天', '近 30 天', '自定义']
        const seg = screen.getByTestId('range-today').parentElement!
        const buttons = Array.from(seg.querySelectorAll('button'))
        const rangeButtons = labels.map(l => buttons.find(b => b.textContent === l))
        const indexes = rangeButtons.map(b => buttons.indexOf(b!))
        // 顺序递增
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
        expect(indexes[0]).toBeLessThan(indexes[1])
        expect(indexes[4]).toBeGreaterThan(indexes[3])
    })

    it('渲染 KPI + 趋势柱状条 + 分组表', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        expect(screen.getByText('总成本')).toBeTruthy()
        // 时序 KPI：平均吞吐 = Σ输出 ÷ Σ解码时长；平均首字 = Σ首字 ÷ 样本数
        // （明细表新增同名列头，getByText 会多匹配，故取首个即 KPI 区域）
        expect(screen.getAllByText('平均吞吐')[0]).toBeTruthy()
        expect(screen.getByText('100 t/s')).toBeTruthy()
        expect(screen.getAllByText('平均首字')[0]).toBeTruthy()
        expect(screen.getByText('1.2s')).toBeTruthy()
        // 趋势柱状条按小时粒度渲染（mock 为 day 格式时兼容回退 MM-DD 标签）
        expect(screen.getAllByTestId('trend-bar')).toHaveLength(2)
        // 分组表按服务商
        // 服务商名优先 providers.name（Deepseek-ant），而非 providers.type 规范名（Anthropic）
        expect(screen.getByText('Deepseek-ant')).toBeTruthy()
        expect(screen.queryByText('Anthropic')).toBeNull()
        expect(screen.getByText('OpenAI')).toBeTruthy()
        // 成本口径说明（圆圈问号）存在：工具栏 + 总成本 KPI + 表头成本列，共 3 处
        expect(screen.getAllByRole('img', {name: '成本口径说明'}).length).toBeGreaterThanOrEqual(3)
        // 数据口径提示：客户端侧统计，非服务商账单
        expect(screen.getByText('统计数据为客户端侧记录，仅供对照，实际用量以服务商官网为准')).toBeTruthy()
    })

    it('无时序数据 → 平均吞吐/首字显示 —', async () => {
        api().usageStatsQuery = vi.fn().mockResolvedValue({
            ...mockStats,
            kpi: {...mockStats.kpi, totalOutputTokens: 0, totalDecodeMs: 0, totalTtftMs: 0, ttftCount: 0, avgDecodeRate: null, avgTtftSeconds: null},
        })
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getAllByText('平均吞吐').length).toBeGreaterThan(0))
        // KPI 平均吞吐、平均首字为占位符；明细表每行新增 会话/平均会话成本/平均首字/平均吞吐 四列占位符（2 行 × 4 = 8），共 10 处 —
        expect(screen.getAllByText('—')).toHaveLength(10)
    })

    it('切换视图（按模型）→ 重新查询', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        fireEvent.click(screen.getByText('按模型'))
        await waitFor(() => {
            expect(lastQuery()).toEqual({range: 'today', view: 'model', granularity: 'hour'})
        })
    })

    it('切换时间范围（近 30 天）→ 按天粒度重新查询', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        fireEvent.click(screen.getByText('近 30 天'))
        await waitFor(() => {
            expect(lastQuery()).toEqual({range: '30d', view: 'provider', granularity: 'day'})
        })
        // 趋势标题切换为按天
        expect(screen.getByText('按天')).toBeTruthy()
    })

    it('点击昨天 → range=yesterday + 按小时粒度', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        // 「全部」范围已被「昨天」取代；用 testid 定位避免与过滤栏下拉选项文本碰撞
        fireEvent.click(screen.getByTestId('range-yesterday'))
        await waitFor(() => {
            expect(lastQuery()).toEqual({range: 'yesterday', view: 'provider', granularity: 'hour'})
        })
    })

    it('自定义范围：点击自定义 → 显示日期选择器；选择范围 → 带 customStart/customEnd 查询', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        // 初始不显示日期选择器
        expect(screen.queryByTestId('custom-range-picker')).toBeNull()
        fireEvent.click(screen.getByText('自定义'))
        // 显示开始/结束日期输入（默认最近 7 天）
        expect(screen.getByTestId('custom-range-picker')).toBeTruthy()
        const start = screen.getByTestId('custom-start') as HTMLInputElement
        const end = screen.getByTestId('custom-end') as HTMLInputElement
        expect(start.value).toBeTruthy()
        expect(end.value).toBeTruthy()
        // 修改开始日 2026-08-10：end 仍为默认（今天）→ 跨度 >1 天 → 按天
        fireEvent.change(start, {target: {value: '2026-08-10'}})
        await waitFor(() => {
            expect(lastQuery()).toMatchObject({range: 'custom', customStart: '2026-08-10', granularity: 'day'})
        })
        // 修改结束日 2026-08-11：10 ~ 11 相邻两天（≤1 天）→ 按小时
        fireEvent.change(end, {target: {value: '2026-08-11'}})
        await waitFor(() => {
            expect(lastQuery()).toMatchObject({range: 'custom', customStart: '2026-08-10', customEnd: '2026-08-11', granularity: 'hour'})
        })
        // 跨度 >1 天（10 ~ 13）→ 按天
        fireEvent.change(end, {target: {value: '2026-08-13'}})
        await waitFor(() => {
            expect(lastQuery()).toMatchObject({range: 'custom', customStart: '2026-08-10', customEnd: '2026-08-13', granularity: 'day'})
        })
    })

    it('自定义范围同日 → 按小时粒度', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalled())
        fireEvent.click(screen.getByText('自定义'))
        fireEvent.change(screen.getByTestId('custom-start'), {target: {value: '2026-08-10'}})
        fireEvent.change(screen.getByTestId('custom-end'), {target: {value: '2026-08-10'}})
        await waitFor(() => {
            expect(lastQuery()).toMatchObject({range: 'custom', granularity: 'hour'})
        })
        expect(screen.getByText('按小时')).toBeTruthy()
    })

    it('刷新按钮 → 靠右显示并重新拉取数据', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalledTimes(1))
        const refreshBtn = screen.getByRole('button', {name: '刷新'})
        // 刷新按钮位于工具栏（存在即可；ml-auto 布局由 CSS 保证）
        expect(refreshBtn).toBeTruthy()
        fireEvent.click(refreshBtn)
        await waitFor(() => expect(api().usageStatsQuery).toHaveBeenCalledTimes(2))
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
            expect(lastQuery()).toMatchObject({range: 'today', view: 'model'})
        })
        // 两行同名模型都应渲染，且不触发 React 重复 key 警告
        expect(screen.getAllByText('deepseek-v4-flash')).toHaveLength(2)
        const dupKeyWarning = errorSpy.mock.calls.some(c => String(c[0]).includes('same key'))
        expect(dupKeyWarning).toBe(false)
    })

    it('切换货币 → 美元/人民币换算（KPI + 明细成本列）', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('¥92.73600')).toBeTruthy())
        // 默认人民币计价，显示汇率说明
        expect(screen.getByText('按 1 USD ≈ 7.20 CNY')).toBeTruthy()
        // 明细成本列人民币：10.71 → ¥77.112，2.17 → ¥15.624
        expect(screen.getByText('¥77.11200')).toBeTruthy()
        expect(screen.getByText('¥15.62400')).toBeTruthy()

        fireEvent.click(screen.getByTestId('currency-usd'))
        await waitFor(() => expect(screen.getByText('$12.88000')).toBeTruthy())
        expect(screen.queryByText('¥92.73600')).toBeNull()
        expect(screen.getByText('$10.71000')).toBeTruthy()
        expect(screen.getByText('$2.17000')).toBeTruthy()
    })

    it('平均会话成本列：成本 ÷ 会话数；会话数为 0 显示 —，且可按该列排序', async () => {
        const stats: GlobalUsageStats = {
            ...mockStats,
            breakdown: [
                {key: 'anthropic', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 196, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 10.71, conversationCount: 2},
                {key: 'openai', providerType: 'openai', providerName: 'OpenAI', requestCount: 71, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 2.17, conversationCount: 0},
            ],
        }
        api().usageStatsQuery = vi.fn().mockResolvedValue(stats)
        render(<UsageWindow />)
        // 10.71 / 2 = 5.355 USD → 人民币 38.556
        await waitFor(() => expect(screen.getByText('¥38.55600')).toBeTruthy())
        // 会话数为 0 → 平均会话成本占位符（成本列仍有 ¥15.62400）
        const tbody = screen.getByText('OpenAI').closest('tbody')!
        const openAiRow = Array.from(tbody.querySelectorAll('tr')).find(tr => tr.textContent!.includes('OpenAI'))!
        expect(openAiRow.textContent).toContain('—')
        // 排序：首次点击降序 → 均值高者（Deepseek-ant）在前
        fireEvent.click(screen.getByText('平均会话成本'))
        expect(tbody.querySelectorAll('tr')[0].textContent).toContain('Deepseek-ant')
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

    it('自身不渲染窗口控制按钮（标题栏由 ConfigDialogWindow 统一壳提供）', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('¥92.73600')).toBeTruthy())
        expect(screen.queryByLabelText('最小化')).toBeNull()
        expect(screen.queryByLabelText('最大化')).toBeNull()
        expect(screen.queryByLabelText('还原')).toBeNull()
        expect(screen.queryByLabelText('关闭')).toBeNull()
    })
})

describe('明细表：服务商列 / 模型ID 表头 / 全列排序', () => {
    const modelBreakdown = [
        {key: 'deepseek-v4-flash', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 332, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 1500, costUsd: 1},
        {key: 'glm-5.3-flash', providerType: 'openai', providerName: 'OpenRouter', requestCount: 3, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, costUsd: 0.5},
    ]

    it('模型视图：首列表头为「模型ID」，新增独立「服务商」列显示 providerName', async () => {
        api().usageStatsQuery = vi.fn().mockResolvedValue({...mockStats, breakdown: modelBreakdown})
        render(<UsageWindow />)
        fireEvent.click(screen.getByText('按模型'))
        await waitFor(() => expect(screen.getAllByText('deepseek-v4-flash')).toHaveLength(1))
        // 表头：模型ID（替代原「名称」）+ 服务商
        // 过滤栏也有「服务商」标签文本，表头断言限定在 thead 内
        expect(screen.getByText('模型ID')).toBeTruthy()
        const thead = screen.getByText('模型ID').closest('thead')!
        expect(Array.from(thead.querySelectorAll('th')).some(th => th.textContent === '服务商')).toBeTruthy()
        // 服务商列独立展示（不再走 via 小字），旧「via」文案不再出现
        expect(screen.getByText('OpenRouter')).toBeTruthy()
        expect(screen.queryByText(/via /)).toBeNull()
        // 服务商视图表头仍为「服务商」（首列即服务商名）
        fireEvent.click(screen.getByText('按服务商'))
        await waitFor(() => expect(screen.getByText('Deepseek-ant')).toBeTruthy())
    })

    it('全列排序：数值列首次点击降序、再点升序；文本列升序', async () => {
        render(<UsageWindow />)
        await waitFor(() => expect(screen.getByText('Deepseek-ant')).toBeTruthy())
        const firstRowText = () =>
            screen.getByText('Deepseek-ant').closest('tbody')!.querySelectorAll('tr')[0].textContent!
        // 默认（服务端顺序）Deepseek-ant（23.7M tokens）在前
        expect(firstRowText()).toContain('Deepseek-ant')
        // 合计列首次点击 → 降序 → 顺序不变
        fireEvent.click(screen.getByText('合计'))
        expect(firstRowText()).toContain('Deepseek-ant')
        // 再点 → 升序 → OpenAI（4.1M）在前
        fireEvent.click(screen.getByText('合计'))
        expect(firstRowText()).toContain('OpenAI')
        // 首列（服务商，文本列）点击 → 升序（D < O）→ Deepseek-ant 在前
        // 「服务商」文本与过滤栏标签碰撞，取 thead 内的表头元素
        const providerHeader = () => screen.getAllByText('服务商').find(el => el.closest('thead'))!
        fireEvent.click(providerHeader())
        expect(firstRowText()).toContain('Deepseek-ant')
        // 再点 → 降序 → OpenAI 在前
        fireEvent.click(providerHeader())
        expect(firstRowText()).toContain('OpenAI')
    })
})