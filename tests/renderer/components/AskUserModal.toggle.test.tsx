// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import AskUserModal from '../../../src/renderer/components/AskUserModal'

// ── 依赖 mock ──
const {mockAgentState} = vi.hoisted(() => ({
    mockAgentState: {
        agentState: {status: 'running', phase: 'streaming', mode: 'auto'} as { status: string; phase: string; mode: string },
        pendingQuestion: null as { question: string; options?: string[]; multiSelect?: boolean; requestId?: string } | null,
        answerQuestion: vi.fn(),
        clearPendingQuestion: vi.fn(),
    },
}))

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) =>
        selector(mockAgentState),
}))

vi.mock('../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: () => 'light',
}))

// MarkdownRenderer 依赖 react-markdown + react-syntax-highlighter，jsdom 下成本高，
// 简化 mock 为纯文本容器（AskUserModal 只透传 question 内容）
vi.mock('../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: ({children}: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

beforeEach(() => {
    mockAgentState.pendingQuestion = {
        question: '请选择您的偏好？',
        options: ['选项A', '选项B', '选项C'],
        multiSelect: true,
    }
    mockAgentState.agentState = {status: 'running', phase: 'streaming', mode: 'auto'}
    mockAgentState.answerQuestion.mockClear()
    // jsdom 未实现 HTMLDialogElement 相关滚动，但不影响本组件
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('AskUserModal 多选 toggle（Task 4 改写的 toggleOption 分支）', () => {
    it('多选模式点击选项 → 选中；再次点击 → 取消选中', () => {
        render(<AskUserModal />)
        const btnA = screen.getByText('选项A')
        fireEvent.click(btnA)
        // 选中后点击"确认发送"应能提交（canSubmit 依赖 selectedOptions）
        const submit = screen.getByText('确认发送')
        expect((submit as HTMLButtonElement).disabled).toBe(false)
        // 再次点击取消选中 → 无选中项，提交按钮禁用（输入框为空）
        fireEvent.click(btnA)
        expect((submit as HTMLButtonElement).disabled).toBe(true)
    })

    it('多选模式可同时选中多个选项', () => {
        render(<AskUserModal />)
        fireEvent.click(screen.getByText('选项A'))
        fireEvent.click(screen.getByText('选项B'))
        const submit = screen.getByText('确认发送')
        expect((submit as HTMLButtonElement).disabled).toBe(false)
        // 提交时 answerQuestion 收到以顿号连接的多选答案
        fireEvent.click(submit)
        expect(mockAgentState.answerQuestion).toHaveBeenCalledWith('选项A、选项B')
    })

    it('单选模式点击已选项再次点击 → 取消（回到空选择）', () => {
        mockAgentState.pendingQuestion = {
            question: '单选问题',
            options: ['S1', 'S2'],
            multiSelect: false,
        }
        render(<AskUserModal />)
        const s1 = screen.getByText('S1')
        fireEvent.click(s1)
        const submit = screen.getByText('确认发送')
        expect((submit as HTMLButtonElement).disabled).toBe(false)
        fireEvent.click(s1)
        expect((submit as HTMLButtonElement).disabled).toBe(true)
    })
})
