// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import UsageStatsDialog from '../../../../src/renderer/components/dialogs/UsageStatsDialog'

const mockData = {
    conversationCount: 6, parentCount: 1, childCount: 5,
    requestCount: 267, toolCallCount: 369,
    totalInputTokens: 1860000, totalOutputTokens: 349600, totalCacheReadTokens: 25576000, totalCacheWriteTokens: 0,
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
    window.dispatchEvent(new CustomEvent('hclaw:show-usage-stats', {
        detail: {convId: 'conv-1', title: '测试会话'},
    }))
}

describe('UsageStatsDialog 分组用量', () => {
    it('总计部分照常渲染（KPI/Token 明细/缓存/调用）', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('27.8M')).toBeTruthy())
        expect(screen.getByText('缓存命中率')).toBeTruthy()
        expect(screen.getByText('LLM 请求')).toBeTruthy()
        expect(screen.getByText('369 次')).toBeTruthy()
    })

    it('按服务商（默认）渲染分组卡片：占比 + 成本列', async () => {
        render(<UsageStatsDialog />)
        openDialog()
        await waitFor(() => expect(screen.getByText('分组用量')).toBeTruthy())
        // 服务商聚合：Deepseek-ant 合并两行（anthropic）、MiniMax 一行（openai）
        expect(screen.getByText('Deepseek-ant')).toBeTruthy()
        expect(screen.getByText('MiniMax')).toBeTruthy()
        // 成本列（Deepseek-ant = 10.71 + 2.17）
        expect(screen.getByText('$12.88')).toBeTruthy()
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
})
