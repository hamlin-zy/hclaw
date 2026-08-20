// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import UsageStatsDialog from '../../../../src/renderer/components/dialogs/UsageStatsDialog'

const mockData = {
    conversationCount: 6, parentCount: 1, childCount: 5,
    requestCount: 267, toolCallCount: 369,
    totalInputTokens: 1860000, totalOutputTokens: 349600, totalCacheReadTokens: 25576000, totalCacheWriteTokens: 0,
    // 时序：349600 输出 / 3496000ms 解码 = 100 t/s；首字 2400ms ÷ 2 样本 = 1.2s
    totalDecodeMs: 3496000, totalTtftMs: 2400, ttftCount: 2,
    breakdown: [
        {key: 'claude-sonnet-4', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 168, inputTokens: 1220000, outputTokens: 240000, cacheReadTokens: 20800000, cacheWriteTokens: 0, totalTokens: 22260000, costUsd: 10.71},
        {key: 'claude-opus-4', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 28, inputTokens: 130000, outputTokens: 20000, cacheReadTokens: 1300000, cacheWriteTokens: 0, totalTokens: 1450000, costUsd: 2.17},
        {key: 'gpt-4o', providerType: 'openai', providerName: 'MiniMax', requestCount: 71, inputTokens: 510000, outputTokens: 90000, cacheReadTokens: 3500000, cacheWriteTokens: 0, totalTokens: 4100000, costUsd: 2.17},
    ],
}

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        conversationUsageStats: vi.fn().mockResolvedValue(mockData),
        initialTheme: 'dark',
        onThemeChanged: vi.fn(),
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function openDialog() {
    act(() => {
        window.dispatchEvent(new CustomEvent('hclaw:show-usage-stats', {
            detail: {convId: 'conv-1', title: '测试会话'},
        }))
    })
}

describe('UsageStatsDialog 分组用量', () => {
    it('总计部分照常渲染（KPI/Token 明细/缓存/调用）', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        expect(screen.getByText('缓存命中率')).toBeTruthy()
        // 时序 KPI：平均吞吐 = Σ输出 ÷ Σ解码时长；平均首字 = Σ首字 ÷ 样本数
        expect(screen.getByText('平均吞吐')).toBeTruthy()
        expect(screen.getByText('100 t/s')).toBeTruthy()
        expect(screen.getByText('平均首字')).toBeTruthy()
        expect(screen.getByText('1.2s')).toBeTruthy()
        expect(screen.getByText('LLM 请求')).toBeTruthy()
        expect(screen.getByText('工具调用')).toBeTruthy()
        expect(screen.getByText('267 次')).toBeTruthy()
        expect(screen.getByText('369 次')).toBeTruthy()
    })

    it('弹窗宽度 560px（加宽）', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        expect(screen.getByRole('dialog').className).toContain('w-[560px]')
    })

    it('默认条件：按服务商 + 人民币', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        // 默认人民币：Deepseek-ant 聚合成本 12.88 × 7.2 = ¥92.74
        expect(screen.getByText('¥92.74')).toBeTruthy()
        expect(screen.queryByText('$12.88')).toBeNull()
        // 默认按服务商：Deepseek-ant 合并两行（anthropic）、MiniMax 一行（openai）
        expect(screen.getByText('Deepseek-ant')).toBeTruthy()
        expect(screen.getByText('MiniMax')).toBeTruthy()
    })

    it('LLM 请求与工具调用在一行显示（同一 grid 容器）', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        const llmLabel = screen.getByText('LLM 请求')
        const toolLabel = screen.getByText('工具调用')
        // 两个 StatRow 的父级是同一个 grid（grid-cols-2 一行两列）
        expect(llmLabel.closest('div.grid')).toBe(toolLabel.closest('div.grid'))
        expect(llmLabel.closest('div.grid')!.className).toContain('grid-cols-2')
    })

    it('Token 明细 / 缓存 / 调用每一项均带边框', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        // Token 明细：输入/输出两项（分组卡片中也有同名标签，取第一处 = 明细区）
        for (const label of ['输入', '输出']) {
            const row = screen.getAllByText(label)[0]!.closest('div.flex')
            expect(row!.className).toContain('rounded-lg border')
            expect(row!.className).toContain('bg-[var(--surface-muted)]')
        }
        // 缓存：缓存命中（分组卡片中也有同名标签，取第一处 = 缓存区）
        const cacheRow = screen.getAllByText('缓存命中')[0]!.closest('div.flex')
        expect(cacheRow!.className).toContain('rounded-lg border')
        // 调用：LLM 请求 / 工具调用
        const llmRow = screen.getByText('LLM 请求').closest('div.flex')
        expect(llmRow!.className).toContain('rounded-lg border')
        const toolRow = screen.getByText('工具调用').closest('div.flex')
        expect(toolRow!.className).toContain('rounded-lg border')
    })

    it('缓存写入 > 0 → 显示缓存写入行（带边框）', async () => {
        ;(window.electronAPI as any).conversationUsageStats.mockResolvedValue({
            ...mockData,
            totalCacheWriteTokens: 5000,
        })
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('缓存写入')).toBeTruthy())
        const writeRow = screen.getByText('缓存写入').closest('div.flex')
        expect(writeRow!.className).toContain('rounded-lg border')
        expect(screen.getByText('5.0k')).toBeTruthy()
    })

    it('无时序数据 → 平均吞吐/首字显示 —', async () => {
        ;(window.electronAPI as any).conversationUsageStats.mockResolvedValue({
            ...mockData,
            totalDecodeMs: 0, totalTtftMs: 0, ttftCount: 0,
        })
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('平均吞吐')).toBeTruthy())
        // 平均吞吐、平均首字两个 KPI 均为占位符（缓存命中率仍为 93%）
        expect(screen.getAllByText('—')).toHaveLength(2)
    })

    it('按服务商（默认）渲染分组卡片：占比 + 成本列', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        // 数据口径提示：客户端侧统计，非服务商账单
        expect(screen.getByText('统计数据为客户端侧记录，仅供对照，实际用量以服务商官网为准')).toBeTruthy()
        // 成本列（Deepseek-ant = 10.71 + 2.17，默认人民币）
        expect(screen.getByText('¥92.74')).toBeTruthy()
        // 占比
        expect(screen.getByText('85%')).toBeTruthy()
    })

    it('切换按模型 → 渲染模型分组（模型名 + 服务商小字）', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        fireEvent.click(screen.getByText('按模型'))
        await waitFor(() => expect(screen.getByText('claude-sonnet-4')).toBeTruthy())
        expect(screen.getByText('claude-opus-4')).toBeTruthy()
        expect(screen.getByText('gpt-4o')).toBeTruthy()
        // 服务商小字：providers.name（两个 anthropic 模型卡均为 Deepseek-ant）
        expect(screen.getAllByText('Deepseek-ant')).toHaveLength(2)
        expect(screen.getByText('MiniMax')).toBeTruthy()
    })

    it('切换美元 → 成本列按美元显示；切回人民币按汇率换算', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('¥92.74')).toBeTruthy())

        fireEvent.click(screen.getByText('$ 美元'))
        // Deepseek-ant 聚合成本 12.88
        await waitFor(() => expect(screen.getByText('$12.88')).toBeTruthy())
        expect(screen.queryByText('¥92.74')).toBeNull()

        fireEvent.click(screen.getByText('¥ 人民币'))
        // 12.88 * 7.2 = 92.736 → ¥92.74
        await waitFor(() => expect(screen.getByText('¥92.74')).toBeTruthy())
        expect(screen.queryByText('$12.88')).toBeNull()
    })

    it('空 breakdown → 不渲染分组区块', async () => {
        ;(window.electronAPI as any).conversationUsageStats.mockResolvedValue({
            ...mockData,
            breakdown: [],
        })
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        expect(screen.queryByText('分组用量')).toBeNull()
    })

    it('切换货币 → 分组成本列美元/人民币换算', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        // 默认人民币：服务商聚合 Deepseek-ant = 12.88 → ¥92.74；MiniMax = 2.17 → ¥15.62
        expect(screen.getByText('¥92.74')).toBeTruthy()
        expect(screen.getByText('¥15.62')).toBeTruthy()

        fireEvent.click(screen.getByText('$ 美元'))
        await waitFor(() => expect(screen.queryByText('¥92.74')).toBeNull())
        expect(screen.getByText('$12.88')).toBeTruthy()
        expect(screen.getByText('$2.17')).toBeTruthy()

        fireEvent.click(screen.getByText('¥ 人民币'))
        await waitFor(() => expect(screen.queryByText('$12.88')).toBeNull())
        expect(screen.getByText('¥92.74')).toBeTruthy()
    })

    it('按模型视图下切换货币 → 单模型成本换算', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        fireEvent.click(screen.getByText('按模型'))
        await waitFor(() => expect(screen.getByText('claude-sonnet-4')).toBeTruthy())
        // 默认人民币：claude-sonnet-4 = 10.71 → ¥77.11
        expect(screen.getByText('¥77.11')).toBeTruthy()

        fireEvent.click(screen.getByText('$ 美元'))
        // 10.71 * 7.2 = 77.112 → ¥77.11
        await waitFor(() => expect(screen.queryByText('¥77.11')).toBeNull())
        expect(screen.getByText('$10.71')).toBeTruthy()
    })

    it('拖动头部 → 弹窗位置跟随（可拖动）', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        const dialog = screen.getByRole('dialog')
        // 等待 hook 居中定位完成（rAF 异步，初始 0px → 居中坐标）
        await waitFor(() => expect(dialog.style.left).not.toBe('0px'))
        const startLeft = parseInt(dialog.style.left, 10)
        const startTop = parseInt(dialog.style.top, 10)
        // 拖动手柄 = 弹窗头部（第一个子元素），鼠标 +50/+20
        const header = dialog.firstElementChild as HTMLElement
        fireEvent.mouseDown(header, {clientX: 500, clientY: 400})
        fireEvent.mouseMove(document, {clientX: 550, clientY: 420})
        fireEvent.mouseUp(document)
        await waitFor(() => {
            expect(parseInt(dialog.style.left, 10)).toBe(startLeft + 50)
            expect(parseInt(dialog.style.top, 10)).toBe(startTop + 20)
        })
    })
})
