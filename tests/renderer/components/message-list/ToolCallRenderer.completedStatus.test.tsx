// @vitest-environment jsdom
/**
 * ToolCallRenderer 完成态状态刷新回归测试
 *
 * 缺陷场景：详细模式下工具执行完成，卡片状态仍显示「执行中」，
 * 切换会话再切回（组件重挂载）后才变成「成功」。
 *
 * 根因：memo 的比较函数只对比 toolCallsStore 的运行时状态，未对比消息内
 * 静态 toolCall。tool_result 到达时 handleToolResult 先 setToolResult 再
 * clearToolCall 删除运行时 key——此后比较函数读取的是「当前」store 快照，
 * 两侧同为 undefined，被误判为相等而 bail out，running → success 的 props
 * 变化（消息重建后的新 toolCall 对象）永远不会触发重渲染。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, act} from '@testing-library/react'
import ToolCallRenderer, {UltraCompactToolGroup} from '../../../../src/renderer/components/message-list/ToolCallRenderer'
import {useToolCallsStore} from '../../../../src/renderer/stores/toolCallsStore'

const mockAgentState = vi.hoisted(() => ({
    messageDisplayMode: 'detailed',
    openToolPopup: vi.fn(),
    openCombinedPopup: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: unknown) => unknown) => selector({activeConversationId: null}),
}))

vi.mock('../../../../src/renderer/stores/mcpStore', () => ({
    useMcpStore: (selector: (s: unknown) => unknown) => selector({mcpServers: []}),
}))

vi.mock('../../../../src/renderer/stores/modelSchemeStore', () => ({
    useModelSchemeStore: (selector: (s: unknown) => unknown) => selector({schemes: [], activeSchemeId: null}),
}))

vi.mock('../../../../src/renderer/stores/llmStore', () => ({
    useLLMStore: {getState: () => ({providers: []})},
}))

beforeEach(() => {
    mockAgentState.messageDisplayMode = 'detailed'
    useToolCallsStore.getState().clearAll()
})

describe('ToolCallRenderer 完成态状态刷新', () => {
    it('运行时 key 被清除后，props 的 running → success 仍应刷新为「成功」', () => {
        const runningTc = {
            id: 'tc-done-1',
            name: 'bash',
            arguments: {command: 'echo hi'},
            status: 'running' as const,
        }
        // 运行中：注册运行时状态（与真实流程一致）
        useToolCallsStore.getState().registerToolCall('tc-done-1', {
            status: 'running',
            startedAt: Date.now(),
        })

        const {rerender} = render(<ToolCallRenderer toolCall={runningTc as any}/>)
        expect(screen.getByText('执行中')).toBeTruthy()

        // 模拟 handleToolResult：先置结果，再立即清理运行时 key
        act(() => {
            useToolCallsStore.getState().setToolResult('tc-done-1', {success: true, output: 'hi'})
            useToolCallsStore.getState().clearToolCall('tc-done-1')
        })
        // 消息重建后传入新的 toolCall 对象（status=success），引用已变化
        const doneTc = {
            ...runningTc,
            status: 'success' as const,
            result: {output: 'hi'},
        }
        act(() => {
            rerender(<ToolCallRenderer toolCall={doneTc as any}/>)
        })

        expect(screen.queryByText('执行中')).toBeNull()
        expect(screen.getByText('成功')).toBeTruthy()
    })

    it('运行时 key 被清除后，props 的 running → error 应刷新为「失败」', () => {
        const runningTc = {
            id: 'tc-done-2',
            name: 'bash',
            arguments: {command: 'false'},
            status: 'running' as const,
        }
        useToolCallsStore.getState().registerToolCall('tc-done-2', {
            status: 'running',
            startedAt: Date.now(),
        })

        const {rerender} = render(<ToolCallRenderer toolCall={runningTc as any}/>)
        act(() => {
            useToolCallsStore.getState().setToolResult('tc-done-2', {success: false, output: '', error: 'boom'})
            useToolCallsStore.getState().clearToolCall('tc-done-2')
        })
        const doneTc = {
            ...runningTc,
            status: 'error' as const,
            result: {output: '', error: 'boom'},
        }
        act(() => {
            rerender(<ToolCallRenderer toolCall={doneTc as any}/>)
        })

        expect(screen.queryByText('执行中')).toBeNull()
        expect(screen.getByText('失败')).toBeTruthy()
    })

    it('简洁模式（compact）存在同一缺陷：运行时 key 清除后 props 终态应刷新', () => {
        mockAgentState.messageDisplayMode = 'compact'
        const runningTc = {
            id: 'tc-done-compact',
            name: 'bash',
            arguments: {command: 'echo hi'},
            status: 'running' as const,
        }
        useToolCallsStore.getState().registerToolCall('tc-done-compact', {
            status: 'running',
            startedAt: Date.now(),
        })

        const {rerender} = render(<ToolCallRenderer toolCall={runningTc as any}/>)
        expect(screen.getByText('执行中')).toBeTruthy()

        act(() => {
            useToolCallsStore.getState().setToolResult('tc-done-compact', {success: true, output: 'hi'})
            useToolCallsStore.getState().clearToolCall('tc-done-compact')
        })
        const doneTc = {
            ...runningTc,
            status: 'success' as const,
            result: {output: 'hi'},
        }
        act(() => {
            rerender(<ToolCallRenderer toolCall={doneTc as any}/>)
        })

        expect(screen.queryByText('执行中')).toBeNull()
        expect(screen.getByText('成功')).toBeTruthy()
    })

    it('极简模式（ultra-compact）工具组：完成态刷新为成功，不残留运行中脉冲', () => {
        const runningTc = {
            id: 'tc-done-uc',
            name: 'bash',
            arguments: {command: 'echo hi'},
            status: 'running' as const,
            timeoutMs: 30000,
        }
        useToolCallsStore.getState().registerToolCall('tc-done-uc', {
            status: 'running',
            startedAt: Date.now(),
            timeoutMs: 30000,
        })

        const {rerender, container} = render(<UltraCompactToolGroup toolCalls={[runningTc] as any}/>)
        // 运行中：状态圆点带脉冲动画
        const dotRunning = container.querySelector('button span')
        expect(dotRunning?.className).toContain('animate-pulse')

        // 模拟 handleToolResult：先置结果，再立即清理运行时 key
        act(() => {
            useToolCallsStore.getState().setToolResult('tc-done-uc', {success: true, output: 'hi'})
            useToolCallsStore.getState().clearToolCall('tc-done-uc')
        })
        // 消息重建后传入新的 toolCalls 数组（元素为 status=success 的新对象）
        const doneTc = {
            ...runningTc,
            status: 'success' as const,
            result: {output: 'hi'},
        }
        act(() => {
            rerender(<UltraCompactToolGroup toolCalls={[doneTc] as any}/>)
        })

        // 完成态：圆点转为成功色且不再脉冲
        const dotDone = container.querySelector('button span')
        expect(dotDone?.className).toContain('bg-[var(--success)]')
        expect(dotDone?.className).not.toContain('animate-pulse')
    })
})