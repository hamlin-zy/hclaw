// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import LlmLogsWindow from '../../../src/renderer/components/LlmLogsWindow'
import type {LlmCallRecord, LlmTraceProjection} from '../../../src/renderer/components/llmTrace/types'

/** 统一访问被 stub 的 electronAPI，避免 window.electronAPI 可空类型的 TS 报错 */
const api = (): any => window.electronAPI

/** 最小可用 LlmCallRecord（index.jsonl envelope 字段对齐 shared 定义） */
function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
    return {
        id: 'rec-1',
        ts: Date.parse('2025-01-01T10:00:00'),
        conversationId: 'conv-a',
        turn: 1,
        step: 1,
        attempt: 0,
        context: 'main',
        provider: 'anthropic',
        model: 'claude-test',
        apiStyle: 'anthropic',
        status: 'ok',
        firstByteMs: 120,
        totalMs: 800,
        reqFile: 'req-1.json',
        resFile: 'res-1.json',
        ...overrides,
    }
}

/** 空投影 */
const emptyProjection = (): LlmTraceProjection => ({timeline: [], summary: [], summaryTokens: []})

/** 单条 conv-b 调用的投影；用 model 区分「同一会话的新旧两次响应」 */
function projectionWithConvB(model: string): LlmTraceProjection {
    return {
        timeline: [{kind: 'call', record: makeRecord({conversationId: 'conv-b', model})}],
        summary: [{
            provider: 'anthropic', model,
            calls: 1, errors: 0, aborts: 0, retries: 0,
            avgTotalMs: 800, p95TotalMs: 800, avgFirstByteMs: 120,
        }],
        summaryTokens: [],
    }
}

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        initialTheme: 'dark',
        windowId: 'llm-logs',
        windowControls: {
            minimize: vi.fn(),
            maximize: vi.fn(),
            close: vi.fn(),
            isMaximized: vi.fn().mockResolvedValue(false),
            onMaximizedChange: vi.fn().mockReturnValue(() => {}),
        },
        // llmTrace 系列 preload API（Task 7 契约）
        getLlmTraceProjection: vi.fn().mockResolvedValue(emptyProjection()),
        getLlmTraceFile: vi.fn().mockResolvedValue(null),
        listLlmTraceConversations: vi.fn().mockResolvedValue([]),
        toggleLlmTrace: vi.fn().mockResolvedValue(undefined),
        clearLlmTrace: vi.fn().mockResolvedValue(undefined),
        onLlmTraceRecord: vi.fn().mockReturnValue(() => {}),
        onLlmTraceEvent: vi.fn().mockReturnValue(() => {}),
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('LlmLogsWindow 对话框形态组件（标题栏由 ConfigDialogWindow 统一壳提供）', () => {
    it('自身不渲染窗口控制按钮（由统一壳负责）', async () => {
        render(<LlmLogsWindow/>)
        expect(screen.queryByRole('button', {name: '关闭'})).toBeNull()
        expect(screen.queryByRole('button', {name: '最小化'})).toBeNull()
    })

    it('初始停止态：状态灯显示未录制，顶栏含导出/清空，时间线空态提示', async () => {
        render(<LlmLogsWindow/>)
        expect(await screen.findByRole('button', {name: /未录制/})).toBeTruthy()
        expect(screen.getByRole('button', {name: '导出'})).toBeTruthy()
        expect(screen.getByRole('button', {name: '清空'})).toBeTruthy()
        expect(screen.getByText('LLM 调用日志')).toBeTruthy()
        expect(screen.getByText('暂无符合条件的调用记录')).toBeTruthy()
    })

    it('projection 数据加载后渲染时间线节点（conversation 分组 + 调用行 + 摘要卡）', async () => {
        const record = makeRecord()
        api().getLlmTraceProjection = vi.fn().mockResolvedValue({
            timeline: [{kind: 'call', record}],
            summary: [{
                provider: 'anthropic', model: 'claude-test',
                calls: 1, errors: 0, aborts: 0, retries: 0,
                avgTotalMs: 800, p95TotalMs: 800, avgFirstByteMs: 120,
            }],
            summaryTokens: [],
        } satisfies LlmTraceProjection)
        render(<LlmLogsWindow/>)

        expect(await screen.findByText('conv-a')).toBeTruthy()
        expect(screen.getByText('Turn 1')).toBeTruthy()
        expect(screen.getAllByText('claude-test').length).toBeGreaterThan(0) // 调用行 model chip + 下拉 option
        expect(screen.getByText('总调用')).toBeTruthy()
        expect(screen.getByText('1')).toBeTruthy() // 总调用统计卡数值
        expect(api().getLlmTraceProjection).toHaveBeenCalled()
    })

    it('点击录制状态灯触发 toggleLlmTrace 并切换到录制中', async () => {
        render(<LlmLogsWindow/>)
        const toggleBtn = await screen.findByRole('button', {name: /未录制/})
        fireEvent.click(toggleBtn)

        expect(api().toggleLlmTrace).toHaveBeenCalledWith(true)
        expect(await screen.findByRole('button', {name: /录制中/})).toBeTruthy()
    })

    it('拉投影的乱序响应：旧请求后返回被丢弃，界面只来自最新一次请求', async () => {
        let resolveStale!: (v: LlmTraceProjection) => void
        let resolveLatest!: (v: LlmTraceProjection) => void
        const stalePromise = new Promise<LlmTraceProjection>(r => { resolveStale = r })
        const latestPromise = new Promise<LlmTraceProjection>(r => { resolveLatest = r })
        const projectionSpy = vi.fn()
            .mockReturnValueOnce(stalePromise)  // 首屏全量拉取：先发出，后返回
            .mockReturnValueOnce(latestPromise) // 切换会话后的定向拉取：后发出，先返回
        api().getLlmTraceProjection = projectionSpy
        api().listLlmTraceConversations = vi.fn().mockResolvedValue([{id: 'conv-b', title: '会话B'}])

        render(<LlmLogsWindow/>)
        // 会话列表就绪后切到 conv-b，触发第二次拉取
        fireEvent.click(await screen.findByLabelText('按会话过滤'))
        fireEvent.click(await screen.findByRole('option', {name: '会话B'}))
        await waitFor(() => expect(projectionSpy).toHaveBeenCalledTimes(2))

        // 新请求先返回 —— 界面应采纳它
        await act(async () => { resolveLatest(projectionWithConvB('latest-model')) })
        expect(screen.getByText('latest-model')).toBeTruthy()

        // 旧请求后返回 —— 必须整包丢弃，不得回退界面
        await act(async () => { resolveStale(projectionWithConvB('stale-model')) })
        expect(screen.queryByText('stale-model')).toBeNull()
        expect(screen.getByText('latest-model')).toBeTruthy()
    })
})
