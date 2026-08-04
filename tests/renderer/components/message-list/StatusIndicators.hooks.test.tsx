// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen} from '@testing-library/react'
import {ThinkingIndicator} from '../../../../src/renderer/components/message-list/StatusIndicators'

// ── 依赖 mock：静态 agent store（selector 每次返回同一引用） ──
const {mockAgentState} = vi.hoisted(() => ({
    mockAgentState: {
        convAgentStates: {},
        agentState: {status: 'idle', phase: 'idle', mode: 'auto'} as { status: string; phase: string; mode: string },
        isThinkingAfterTools: false,
        runningToolCount: 0,
        streamingMessageId: null,
        errorMessage: null,
        executingToolsMessage: null,
    },
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) =>
        selector(mockAgentState),
    setState: (patch: unknown) => Object.assign(mockAgentState, patch),
}))

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('StatusIndicators hooks 稳定性（Task 8/9 修复条件 Hook 后的回归）', () => {
    it('无 conversationId 连续渲染不抛错（Hook 顺序稳定）', () => {
        const {rerender} = render(<ThinkingIndicator />)
        expect(() => rerender(<ThinkingIndicator />)).not.toThrow()
    })

    it('有 conversationId 渲染不抛错', () => {
        expect(() => render(<ThinkingIndicator conversationId="conv-1" />)).not.toThrow()
    })

    it('idle 状态不显示指示器', () => {
        mockAgentState.agentState = {status: 'idle', phase: 'idle', mode: 'auto'}
        mockAgentState.executingToolsMessage = null
        mockAgentState.errorMessage = null
        const {container} = render(<ThinkingIndicator />)
        expect(container.querySelector('[role="status"]')).toBeNull()
    })

    it('status=streaming（phase=streaming）时显示思考中指示器', () => {
        mockAgentState.agentState = {status: 'running', phase: 'streaming', mode: 'auto'}
        mockAgentState.executingToolsMessage = null
        mockAgentState.errorMessage = null
        render(<ThinkingIndicator />)
        expect(screen.getByText('思考中')).toBeTruthy()
    })
})
