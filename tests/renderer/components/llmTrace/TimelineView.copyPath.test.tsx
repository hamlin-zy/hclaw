// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {TimelineView} from '../../../../src/renderer/components/llmTrace/TimelineView'
import type {LlmCallRecord, LlmTraceProjection} from '../../../../src/renderer/components/llmTrace/types'

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
        ...overrides,
    }
}

const projection = (record: LlmCallRecord): LlmTraceProjection =>
    ({timeline: [{kind: 'call', record}], summary: [], summaryTokens: []})

const baseFilter = {status: 'all' as const, model: '', conversationId: ''}

beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
        value: {writeText: vi.fn().mockResolvedValue(undefined)},
        configurable: true,
    })
})

afterEach(() => {
    vi.restoreAllMocks()
    // @ts-expect-error 测试后清理 stub
    delete navigator.clipboard
})

describe('TimelineView 会话分组头部复制日志路径按钮', () => {
    it('有路径时渲染复制按钮，点击写入剪贴板并显示已复制反馈', async () => {
        render(
            <TimelineView projection={projection(makeRecord())} filter={baseFilter}
                onOpenDetail={() => {}}
                conversationPaths={new Map([['conv-a', 'C:\\root\\llm-calls\\conv-a']])} />,
        )
        const btn = screen.getByRole('button', {name: '复制路径'})
        fireEvent.click(btn)

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\root\\llm-calls\\conv-a')
        expect(await screen.findByRole('button', {name: '已复制'})).toBeTruthy()
    })

    it('无路径映射时不渲染复制按钮', () => {
        render(<TimelineView projection={projection(makeRecord())} filter={baseFilter} onOpenDetail={() => {}} />)
        expect(screen.queryByRole('button', {name: '复制路径'})).toBeNull()
    })
})
