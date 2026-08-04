// @vitest-environment jsdom
/**
 * ToolCallRenderer 倒计时集成测试
 *
 * 保护：bash 工具卡片在运行中且有超时信息时显示倒计时徽章。
 * 验证链路：toolCallsStore.runtimeState(timeoutMs+startedAt) → ToolCallRenderer → ToolCallHeader → ToolCountdown
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen} from '@testing-library/react'
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

describe('ToolCallRenderer 倒计时显示', () => {
    it('bash 运行中且有 timeoutMs+startedAt → 显示剩余倒计时', () => {
        const toolCall = {
            id: 'tc-bash-1',
            name: 'bash',
            arguments: {command: 'sleep 10'},
            status: 'running' as const,
        }
        // 模拟 handleToolStart 注册的 runtimeState：超时 30s，已开始 20s
        const startedAt = Date.now() - 20000
        useToolCallsStore.getState().registerToolCall('tc-bash-1', {
            status: 'running',
            startedAt,
            timeoutMs: 30000,
        })

        render(<ToolCallRenderer toolCall={toolCall as any}/>)

        // 30s - 20s = 剩余 10秒 → 括号紧凑格式 (10s)
        expect(screen.getByText('(10s)')).toBeTruthy()
    })

    it('bash 运行中但无超时信息（timeoutMs 缺失）→ 不显示倒计时', () => {
        const toolCall = {
            id: 'tc-bash-2',
            name: 'bash',
            arguments: {command: 'sleep 10'},
            status: 'running' as const,
        }
        // 无 timeoutMs（旧版本 worker 未注入超时信息）
        useToolCallsStore.getState().registerToolCall('tc-bash-2', {
            status: 'running',
            startedAt: Date.now() - 5000,
        })

        render(<ToolCallRenderer toolCall={toolCall as any}/>)

        expect(screen.queryByRole('timer')).toBeNull()
    })

    it('bash 已完成（非 running）→ 不显示倒计时', () => {
        const toolCall = {
            id: 'tc-bash-3',
            name: 'bash',
            arguments: {command: 'sleep 10'},
            status: 'success' as const,
            result: {output: 'done'},
        }

        render(<ToolCallRenderer toolCall={toolCall as any}/>)

        expect(screen.queryByRole('timer')).toBeNull()
    })
})
