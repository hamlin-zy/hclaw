// @vitest-environment jsdom
/**
 * 助手气泡「继续」按钮测试
 *
 * 契约（方案 B′）：
 * - 按钮**总是**出现在最后一条助手消息的气泡操作区（复制按钮左侧）；
 * - 仅据信号调整视觉权重（highlight → 品牌色高亮；否则弱化），不用信号当显示开关；
 * - 点击 = 发送一条内容为「继续」的用户消息（走 startAgent 同链路）；
 * - agent 运行中禁用（与 RetryButton 一致）。
 *
 * 高亮判定：lastDoneReason 非 undefined 且非 'completed' || turnLimitNotice 存在
 *          || tasks 中存在 pending/running。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        loadedMessages: [] as any[],
        activeConversationId: 'conv-1' as string | null,
        hasMoreMap: {} as Record<string, boolean>,
        loadingMoreMap: {} as Record<string, boolean>,
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        streamingMessageId: null as string | null,
        agentState: {status: 'idle', phase: 'idle', mode: 'auto'} as {status: string; phase: string; mode: string},
        errorMessage: null as string | null,
        isThinkingAfterTools: false,
        startAgent: vi.fn(),
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: Object.assign(
        (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
        {getState: () => mockAgentState},
    ),
}))

const USER_MESSAGE = {id: 'user-1', role: 'user', content: '跑个长任务', timestamp: 1}
const ASSISTANT_1 = {id: 'assist-1', role: 'assistant', content: '第一段产出', timestamp: 2}
const ASSISTANT_2 = {id: 'assist-2', role: 'assistant', content: '第二段产出', timestamp: 3}

beforeEach(() => {
    mockAgentState.convAgentStates = {}
    mockAgentState.agentState = {status: 'idle', phase: 'idle', mode: 'auto'}
    mockAgentState.startAgent = vi.fn()
    mockConversationState.messagesMap = {}
    vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    })
    vi.stubGlobal('MutationObserver', class {
        observe() {}
        disconnect() {}
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    Element.prototype.scrollIntoView = vi.fn() as any
    Element.prototype.scrollTo = vi.fn() as any
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** 渲染 MessageList（可注入 per-conv 状态与顶层 agent 状态） */
function renderWith(messages: any[], convData: Record<string, any> = {}, topStatus = 'idle') {
    mockConversationState.messagesMap = {'conv-1': messages}
    mockAgentState.convAgentStates = {'conv-1': {agentState: {status: topStatus, phase: 'idle', mode: 'auto'}, ...convData}}
    mockAgentState.agentState = {status: topStatus, phase: 'idle', mode: 'auto'}
    return render(<MessageList conversationId="conv-1"/>)
}

function continueButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('[data-name="message-actions-continue-button"]')) as HTMLButtonElement[]
}

/** 去掉 hover: 前缀的类（hover 公共色含 brand-primary，不能算「高亮态」） */
function baseClass(btn: HTMLElement): string {
    return btn.className.split(/\s+/).filter(c => c && !c.startsWith('hover:')).join(' ')
}

describe('助手气泡「继续」按钮', () => {
    it('最后一条助手消息：存在继续按钮', () => {
        renderWith([USER_MESSAGE, ASSISTANT_1])
        expect(continueButtons()).toHaveLength(1)
    })

    it('更早的助手消息：不带继续按钮（只有最后一条挂）', () => {
        renderWith([USER_MESSAGE, ASSISTANT_1, ASSISTANT_2])
        const btns = continueButtons()
        expect(btns).toHaveLength(1)
        // 仅挂在最后一条助手消息所在行
        expect(btns[0].closest('[data-msg-idx]')?.getAttribute('data-msg-idx')).toBe('2')
    })

    it('点击：调 startAgent({conversationId, message: "继续"})', () => {
        renderWith([USER_MESSAGE, ASSISTANT_1])
        fireEvent.click(continueButtons()[0])
        expect(mockAgentState.startAgent).toHaveBeenCalledWith({conversationId: 'conv-1', message: '继续'})
    })

    it('agent 运行中：按钮禁用', () => {
        renderWith([USER_MESSAGE, ASSISTANT_1], {}, 'running')
        expect(continueButtons()[0].disabled).toBe(true)
    })

    it('lastDoneReason=error → 高亮；=completed → 弱化', () => {
        renderWith([USER_MESSAGE, ASSISTANT_1], {lastDoneReason: 'error'})
        expect(baseClass(continueButtons()[0])).toContain('brand-primary')

        document.body.innerHTML = ''
        renderWith([USER_MESSAGE, ASSISTANT_1], {lastDoneReason: 'completed'})
        expect(baseClass(continueButtons()[0])).not.toContain('brand-primary')
    })

    it('tasks 有 pending → 高亮；turnLimitNotice 存在 → 高亮', () => {
        renderWith([USER_MESSAGE, ASSISTANT_1], {tasks: [{id: 't1', status: 'pending'}]})
        expect(baseClass(continueButtons()[0])).toContain('brand-primary')

        document.body.innerHTML = ''
        renderWith([USER_MESSAGE, ASSISTANT_1], {turnLimitNotice: {turns: 500, maxTurns: 500}})
        expect(baseClass(continueButtons()[0])).toContain('brand-primary')
    })
})
