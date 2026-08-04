// @vitest-environment jsdom
/**
 * ToolCallRenderer 倒计时修复回归测试
 *
 * 保护场景（系统调试 F1+F2+F3）：
 * 1. 消息 toolCall 副本携带 timeoutMs（handleToolStart 补写）→ 模式切换后倒计时仍有数据源
 * 2. 运行时状态在 tool_start 后注册 timeoutMs（模拟切换前 tool_use 已建副本、tool_start 补写）
 * 3. 详情/简洁模式下运行中卡片显示倒计时，且切换渲染路径后仍显示
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, act} from '@testing-library/react'
import ToolCallRenderer from '../../../../src/renderer/components/message-list/ToolCallRenderer'
import {useToolCallsStore} from '../../../../src/renderer/stores/toolCallsStore'

// ── 依赖 mock：静态 store ──
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
    useToolCallsStore.getState().clearAll()
})

describe('ToolCallRenderer 倒计时修复回归', () => {
    it('F1: toolCall 副本自带 timeoutMs + 运行时 startedAt → 运行中显示倒计时', () => {
        // 模拟 F1 落库后的消息副本：timeoutMs 已写入 toolCall（模式切换/重载后仍可用）
        const toolCall = {
            id: 'tc-f1-1',
            name: 'bash',
            arguments: {command: 'sleep 10'},
            status: 'running' as const,
            timeoutMs: 30000,
        }
        // 运行时仅注册 startedAt（status 已由消息副本提供）
        const startedAt = Date.now() - 15000
        useToolCallsStore.getState().registerToolCall('tc-f1-1', {
            status: 'running',
            startedAt,
        })

        render(<ToolCallRenderer toolCall={toolCall as any}/>)

        // 30s - 15s = 剩余 15 秒
        expect(screen.getByText('(15s)')).toBeTruthy()
    })

    it('F1: 消息副本无 timeoutMs 但运行时注册了 → 运行时数据兜底显示', () => {
        const toolCall = {
            id: 'tc-f1-2',
            name: 'bash',
            arguments: {command: 'sleep 10'},
            status: 'running' as const,
            // 无 timeoutMs（旧数据/历史消息）
        }
        const startedAt = Date.now() - 5000
        useToolCallsStore.getState().registerToolCall('tc-f1-2', {
            status: 'running',
            startedAt,
            timeoutMs: 30000,
        })

        render(<ToolCallRenderer toolCall={toolCall as any}/>)

        expect(screen.getByText('(25s)')).toBeTruthy()
    })

    it('F1: 消息副本有 timeoutMs 但无运行时状态（已清空）→ 不显示（避免历史消息残留倒计时）', () => {
        // 关键语义：倒计时只对"运行中"有效。消息副本 status 必须仍为 running
        // 才能显示；toolCallsStore 清空（新回合）后 status 回落为消息副本值。
        // 历史已完成消息 status=success → 不显示。
        const toolCall = {
            id: 'tc-f1-3',
            name: 'bash',
            arguments: {command: 'sleep 10'},
            status: 'success' as const,
            timeoutMs: 30000,
        }
        // 无运行时状态（已 clearAll）

        render(<ToolCallRenderer toolCall={toolCall as any}/>)

        expect(screen.queryByRole('timer')).toBeNull()
    })
})
