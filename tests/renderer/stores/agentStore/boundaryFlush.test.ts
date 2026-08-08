import {describe, expect, it} from 'vitest'
import {shouldFlushOnBoundary} from '../../../../src/renderer/stores/agentStore/handlers/streamEvents'

describe('shouldFlushOnBoundary — 段边界检测', () => {
    it('thinking → 非 thinking 事件 = 段结束（应 flush）', () => {
        expect(shouldFlushOnBoundary('thinking', 'text')).toBe(true)
        expect(shouldFlushOnBoundary('thinking', 'tool_use')).toBe(true)
        expect(shouldFlushOnBoundary('thinking', 'tools_start')).toBe(true)
    })
    it('text → 非 text 事件 = 段结束（应 flush）', () => {
        expect(shouldFlushOnBoundary('text', 'thinking')).toBe(true)
        expect(shouldFlushOnBoundary('text', 'tool_use')).toBe(true)
    })
    it('同类型连续事件不触发', () => {
        expect(shouldFlushOnBoundary('thinking', 'thinking')).toBe(false)
        expect(shouldFlushOnBoundary('text', 'text')).toBe(false)
    })
    it('工具事件不触发（tool_result/tool_progress/tool_detail）', () => {
        expect(shouldFlushOnBoundary('tool_use', 'tool_result')).toBe(false)
        expect(shouldFlushOnBoundary('tool_result', 'tool_progress')).toBe(false)
    })
    it('done/error 不在此触发（由 handler 收尾统一 flush，防 endedAt 竞态）', () => {
        expect(shouldFlushOnBoundary('text', 'done')).toBe(false)
        expect(shouldFlushOnBoundary('thinking', 'error')).toBe(false)
        expect(shouldFlushOnBoundary(undefined, 'text')).toBe(false)
    })
    it('user_message_injected 不在此触发（由 handler 收尾统一 flush，防 endedAt 竞态）', () => {
        expect(shouldFlushOnBoundary('text', 'user_message_injected')).toBe(false)
        expect(shouldFlushOnBoundary('thinking', 'user_message_injected')).toBe(false)
    })
})
