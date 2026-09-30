// @vitest-environment jsdom
/**
 * ToolCallRenderer Agent 卡片点击行为测试
 *
 * 需求：详情/简洁模式下，Agent 卡片点击非按钮区不再展开，而是跳转到目标子会话
 * （复用「跳转」按钮逻辑）；无 taskId（子会话未生成）时忽略点击、无反馈。
 * 非 Agent 卡片保持原行为不变（详情模式仍可展开）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, fireEvent} from '@testing-library/react'
import ToolCallRenderer from '../../../../src/renderer/components/message-list/ToolCallRenderer'
import {useToolCallsStore} from '../../../../src/renderer/stores/toolCallsStore'

const mockAgentState = vi.hoisted(() => ({
    messageDisplayMode: 'detailed',
    openToolPopup: vi.fn(),
    openCombinedPopup: vi.fn(),
}))

const mockConvState = vi.hoisted(() => ({
    activeConversationId: null as string | null,
    setActiveConversation: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: typeof mockConvState) => unknown) => selector(mockConvState),
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

const TOGGLE_SEL = '[data-name="tool-call-header-toggle-expanded-button"]'
const CARD_CLICK_SEL = '[data-name="tool-call-header-card-click-button"]'
const BODY_SEL = '[data-find-scope]'

beforeEach(() => {
    mockAgentState.messageDisplayMode = 'detailed'
    mockConvState.setActiveConversation.mockClear()
    useToolCallsStore.getState().clearAll()
})

describe('ToolCallRenderer — Agent 卡片点击（详情模式）', () => {
    it('有 taskId 时点击卡片非按钮区 → 跳转子会话，且不展开详情', () => {
        const tc = {
            id: 'agent-1', name: 'agent', arguments: {agent: 'Implementer'},
            status: 'success', taskId: 'child-1', result: {output: 'done'},
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        fireEvent.click(container.querySelector(TOGGLE_SEL) as HTMLElement)
        expect(mockConvState.setActiveConversation).toHaveBeenCalledWith('child-1')
        expect(container.querySelector(BODY_SEL)).toBeNull()
    })

    it('无 taskId 时点击卡片 → 忽略点击，不跳转也不展开', () => {
        const tc = {
            id: 'agent-2', name: 'agent', arguments: {agent: 'Implementer'}, status: 'running',
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        fireEvent.click(container.querySelector(TOGGLE_SEL) as HTMLElement)
        expect(mockConvState.setActiveConversation).not.toHaveBeenCalled()
        expect(container.querySelector(BODY_SEL)).toBeNull()
    })

    it('运行中有 taskId 时点击卡片 → 同样跳转（运行中/完成态一致）', () => {
        const tc = {
            id: 'agent-3', name: 'agent', arguments: {agent: 'Implementer'},
            status: 'running', taskId: 'child-3',
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        fireEvent.click(container.querySelector(TOGGLE_SEL) as HTMLElement)
        expect(mockConvState.setActiveConversation).toHaveBeenCalledWith('child-3')
    })

    it('非 Agent 卡片（bash）详情模式仍可点击展开（回归保护）', () => {
        const tc = {
            id: 'bash-1', name: 'bash', arguments: {command: 'echo hi'},
            status: 'success', result: {output: 'hi'},
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        expect(container.querySelector(BODY_SEL)).toBeNull()
        fireEvent.click(container.querySelector(TOGGLE_SEL) as HTMLElement)
        expect(container.querySelector(BODY_SEL)).not.toBeNull()
        expect(mockConvState.setActiveConversation).not.toHaveBeenCalled()
    })
})

describe('ToolCallRenderer — Agent 卡片点击（简洁模式）', () => {
    beforeEach(() => {
        mockAgentState.messageDisplayMode = 'compact'
    })

    it('有 taskId 时点击卡片非按钮区 → 跳转子会话', () => {
        const tc = {
            id: 'agent-c1', name: 'agent', arguments: {agent: 'Implementer'},
            status: 'success', taskId: 'child-c1', result: {output: 'done'},
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        fireEvent.click(container.querySelector(CARD_CLICK_SEL) as HTMLElement)
        expect(mockConvState.setActiveConversation).toHaveBeenCalledWith('child-c1')
    })

    it('无 taskId 时点击卡片 → 忽略点击，不跳转', () => {
        const tc = {
            id: 'agent-c2', name: 'agent', arguments: {agent: 'Implementer'}, status: 'running',
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        fireEvent.click(container.querySelector(CARD_CLICK_SEL) as HTMLElement)
        expect(mockConvState.setActiveConversation).not.toHaveBeenCalled()
    })

    it('非 Agent 卡片（bash）简洁模式无可点击卡片区（回归保护）', () => {
        const tc = {
            id: 'bash-c1', name: 'bash', arguments: {command: 'echo hi'},
            status: 'success', result: {output: 'hi'},
        }
        const {container} = render(<ToolCallRenderer toolCall={tc as any}/>)
        expect(container.querySelector(CARD_CLICK_SEL)).toBeNull()
    })
})