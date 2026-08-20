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
        executingToolsMessage: null as string | {label: string; urgent: boolean} | null,
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

    it('status=streaming（phase=streaming）时不显示思考中指示器（已搬入气泡 statusNote）', () => {
        mockAgentState.agentState = {status: 'running', phase: 'streaming', mode: 'auto'}
        mockAgentState.executingToolsMessage = null
        mockAgentState.errorMessage = null
        mockAgentState.streamingMessageId = null
        render(<ThinkingIndicator />)
        expect(screen.queryByText('思考中')).toBeNull()
        // phase 有值时也不触发流式暂停指示器（防"思考中"误显示为"响应中..."）
        expect(screen.queryByText(/响应中/)).toBeNull()
    })

    it('工具执行状态（字符串）仍由左下角指示器显示', () => {
        mockAgentState.agentState = {status: 'running', phase: 'executing_tools', mode: 'auto'}
        mockAgentState.executingToolsMessage = '2 个工具 执行中...'
        mockAgentState.errorMessage = null
        render(<ThinkingIndicator />)
        expect(screen.getByText('2 个工具 执行中...')).toBeTruthy()
    })
})
