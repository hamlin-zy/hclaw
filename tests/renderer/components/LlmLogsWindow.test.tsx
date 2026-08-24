// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
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
})
