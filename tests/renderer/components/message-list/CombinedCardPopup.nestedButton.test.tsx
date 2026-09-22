// @vitest-environment jsdom
/**
 * CombinedCardPopup「button 嵌套 button」回归测试
 *
 * 缺陷场景：L1 聚合弹窗的工具子卡片，外层是 <button>（点击 = 打开 L2 弹窗 / 跳转子会话），
 * 其内部在 runtimeTaskId 存在时又渲染内层「跳转」<button>，构成 HTML 非法嵌套，React 运行时报
 * In HTML, <button> cannot be a descendant of <button>. This will cause a hydration error.
 *
 * 修复口径（与 ToolCallHeader.nestedButton.test.tsx 一致）：
 * 外层改为 <div role="button" tabIndex={0}>，保留 data-name 与 cursor-pointer，补键盘支持
 * （含冒泡守卫）与 focus-visible 焦点环（逐字复刻 globals.css 的 button:focus-visible）；
 * 注意本处外层是「动作按钮」而非展开开关，故不得加 aria-expanded。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, fireEvent} from '@testing-library/react'
import CombinedCardPopup from '../../../../src/renderer/components/message-list/compact-popup/CombinedCardPopup'

// ── store / UI 依赖 mock（复用 compactPopup.live.test.tsx 的可订阅 store 模式）──

// 轻量可订阅 store：保证被 memo 包裹的弹窗能因 store 更新而重渲染
const hoisted = vi.hoisted(() => {
    const mk = (initial: any) => {
        let state = initial
        const listeners = new Set<() => void>()
        return {
            get: () => state,
            replace: (s: any) => { state = s; listeners.forEach(l => l()) },
            subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
        }
    }
    return {agent: mk({}), conv: mk({}), tool: mk({states: {}})}
})

vi.mock('../../../../src/renderer/stores/agentStore', async () => {
    const React = await import('react')
    return {
        useAgentStore: (selector: (s: any) => unknown) => {
            const state = React.useSyncExternalStore(hoisted.agent.subscribe, hoisted.agent.get, hoisted.agent.get)
            return selector(state)
        },
    }
})

vi.mock('../../../../src/renderer/stores/conversationStore', async () => {
    const React = await import('react')
    const useConversationStore = (selector: (s: any) => unknown) => {
        const state = React.useSyncExternalStore(hoisted.conv.subscribe, hoisted.conv.get, hoisted.conv.get)
        return selector(state)
    }
    return {
        useConversationStore: Object.assign(useConversationStore, {
            getState: () => hoisted.conv.get(),
        }),
    }
})

vi.mock('../../../../src/renderer/stores/toolCallsStore', async () => {
    const React = await import('react')
    const useToolCallsStore = (selector: (s: any) => unknown) => {
        const state = React.useSyncExternalStore(hoisted.tool.subscribe, hoisted.tool.get, hoisted.tool.get)
        return selector(state)
    }
    return {
        useToolCallsStore: Object.assign(useToolCallsStore, {
            getState: () => hoisted.tool.get(),
        }),
    }
})

vi.mock('framer-motion', () => {
    const Passthrough = (props: any) => props.children ?? null
    const motion: any = new Proxy({}, {get: () => Passthrough})
    return {AnimatePresence: Passthrough, motion}
})

vi.mock('../../../../src/renderer/hooks/useDraggableDialog', () => ({
    useDraggableDialog: () => ({
        dialogRef: {current: null},
        position: {x: 0, y: 0},
        isDragging: false,
        handleDragStart: () => {},
    }),
}))

vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: (props: any) => props.children ?? null,
}))

vi.mock('../../../../src/renderer/components/icons', () => ({
    AgentIcon: () => null,
    SkillIcon: () => null,
    RemoveIcon: () => null,
}))

// ── 测试数据构造 ────────────────────────────────────────

const CARD_SEL = '[data-name="combined-card-popup-agent-card-button"]'
const JUMP_SEL = '[data-name="combined-card-popup-jump-to-session-button"]'

const PARENT_CONV = 'conv-parent'
const CHILD_CONV = 'child-conv-1'

/**
 * 构造「单个 agent 工具子卡片」场景。
 * 关键前提：运行时 taskId 必须有值，否则内层「跳转」按钮不渲染（断言会假通过）。
 */
function setup(opts: {status?: string; taskId?: string | null} = {}) {
    const status = opts.status ?? 'running'
    const taskId = opts.taskId === undefined ? CHILD_CONV : opts.taskId
    const agentTc: any = {id: 'tc-agent', name: 'agent', arguments: {agent: 'Implementer Agent'}, status}

    const openToolPopup = vi.fn()
    hoisted.agent.replace({
        combinedPopupData: {
            items: [{type: 'tools', toolCalls: [agentTc]}],
            toolCalls: [agentTc],
            thinkCount: 0,
        },
        closeCombinedPopup: vi.fn(),
        openToolPopup,
    })

    const setActiveConversation = vi.fn()
    hoisted.conv.replace({
        activeConversationId: PARENT_CONV,
        messagesMap: {},
        setActiveConversation,
    })

    hoisted.tool.replace({
        states: {[agentTc.id]: {status, ...(taskId ? {taskId} : {})}},
    })

    return {agentTc, openToolPopup, setActiveConversation}
}

beforeEach(() => {
    setup()
})

// ── 1. 非法嵌套 ─────────────────────────────────────────

describe('CombinedCardPopup — 工具子卡片不得嵌套 button', () => {
    it('前提成立：runtimeTaskId 有值时内层「跳转」按钮确实渲染', () => {
        const {container} = render(<CombinedCardPopup/>)
        expect(container.querySelectorAll(CARD_SEL)).toHaveLength(1)
        expect(container.querySelector(JUMP_SEL)).toBeTruthy()
    })

    it('前提必要条件：runtimeTaskId 缺失时内层「跳转」按钮不渲染', () => {
        setup({taskId: null})
        const {container} = render(<CombinedCardPopup/>)
        expect(container.querySelector(JUMP_SEL)).toBeNull()
    })

    it('无 button 嵌套 button', () => {
        const {container} = render(<CombinedCardPopup/>)
        expect(container.querySelector(JUMP_SEL)).toBeTruthy()
        expect(container.querySelectorAll('button button')).toHaveLength(0)
    })

    it('内层「跳转」按钮没有任何 button 祖先', () => {
        const {container} = render(<CombinedCardPopup/>)
        const jump = container.querySelector(JUMP_SEL) as HTMLElement
        // 注意：Element.closest 会匹配到自身，按钮自身即 button，故必须从父元素向上查祖先链
        expect(jump.parentElement!.closest('button')).toBeNull()
    })
})

// ── 2. 外层元素语义 ─────────────────────────────────────

describe('CombinedCardPopup — 外层工具子卡片语义', () => {
    it('是 div[role=button][tabindex=0]', () => {
        const {container} = render(<CombinedCardPopup/>)
        const card = container.querySelector(CARD_SEL) as HTMLElement
        expect(card.tagName).toBe('DIV')
        expect(card.getAttribute('role')).toBe('button')
        expect(card.tabIndex).toBe(0)
    })

    it('保留 data-name 锚点、cursor-pointer 与 focus-visible 焦点环（走 CSS 变量）', () => {
        const {container} = render(<CombinedCardPopup/>)
        const card = container.querySelector(CARD_SEL) as HTMLElement
        expect(card.className).toContain('cursor-pointer')
        expect(card.className).toContain('focus-visible:[outline:2px_solid_var(--focus-ring)]')
        expect(card.className).toContain('focus-visible:[outline-offset:2px]')
    })

    it('外层是动作按钮而非展开开关：不得有 aria-expanded', () => {
        const {container} = render(<CombinedCardPopup/>)
        const card = container.querySelector(CARD_SEL) as HTMLElement
        expect(card.hasAttribute('aria-expanded')).toBe(false)
    })

    it('外层不再有 button 祖先', () => {
        const {container} = render(<CombinedCardPopup/>)
        const card = container.querySelector(CARD_SEL) as HTMLElement
        expect(card.parentElement!.closest('button')).toBeNull()
    })
})

// ── 3. 交互 ─────────────────────────────────────────────

describe('CombinedCardPopup — 外层工具子卡片键盘交互', () => {
    it('Enter 触发 handleCardClick（运行中 + taskId → 跳转子会话）', () => {
        const {setActiveConversation, openToolPopup} = setup()
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.keyDown(container.querySelector(CARD_SEL) as HTMLElement, {key: 'Enter'})
        expect(setActiveConversation).toHaveBeenCalledTimes(1)
        expect(setActiveConversation).toHaveBeenCalledWith(CHILD_CONV)
        expect(openToolPopup).not.toHaveBeenCalled()
    })

    it('空格触发 handleCardClick（运行中 + taskId → 跳转子会话）', () => {
        const {setActiveConversation, openToolPopup} = setup()
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.keyDown(container.querySelector(CARD_SEL) as HTMLElement, {key: ' '})
        expect(setActiveConversation).toHaveBeenCalledTimes(1)
        expect(openToolPopup).not.toHaveBeenCalled()
    })

    it('已完成状态按 Enter 走打开 L2 弹窗路径', () => {
        const {openToolPopup, setActiveConversation} = setup({status: 'success'})
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.keyDown(container.querySelector(CARD_SEL) as HTMLElement, {key: 'Enter'})
        expect(openToolPopup).toHaveBeenCalledTimes(1)
        expect(setActiveConversation).not.toHaveBeenCalled()
    })

    it('点击外层触发 handleCardClick', () => {
        const {setActiveConversation} = setup()
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.click(container.querySelector(CARD_SEL) as HTMLElement)
        expect(setActiveConversation).toHaveBeenCalledTimes(1)
    })
})

// ── 4. 内层按钮与冒泡守卫 ───────────────────────────────

describe('CombinedCardPopup — 内层「跳转」按钮与冒泡守卫', () => {
    it('内层按钮上按 Enter 冒泡到外层时不得触发外层动作（已完成状态）', () => {
        const {openToolPopup, setActiveConversation} = setup({status: 'success'})
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.keyDown(container.querySelector(JUMP_SEL) as HTMLElement, {key: 'Enter'})
        // 守卫（e.target !== e.currentTarget）失效时，外层 onKeyDown 会走 handleCardClick → openToolPopup
        expect(openToolPopup).not.toHaveBeenCalled()
        expect(setActiveConversation).not.toHaveBeenCalled()
    })

    it('内层按钮上按空格冒泡到外层时不得触发外层动作（已完成状态）', () => {
        const {openToolPopup, setActiveConversation} = setup({status: 'success'})
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.keyDown(container.querySelector(JUMP_SEL) as HTMLElement, {key: ' '})
        expect(openToolPopup).not.toHaveBeenCalled()
        expect(setActiveConversation).not.toHaveBeenCalled()
    })

    it('点击内层按钮只跳转子会话，不打开 L2 弹窗', () => {
        const {setActiveConversation, openToolPopup} = setup()
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.click(container.querySelector(JUMP_SEL) as HTMLElement)
        expect(setActiveConversation).toHaveBeenCalledTimes(1)
        expect(setActiveConversation).toHaveBeenCalledWith(CHILD_CONV)
        expect(openToolPopup).not.toHaveBeenCalled()
    })

    it('点击内层按钮（已完成状态）也不会触发打开 L2 弹窗', () => {
        const {setActiveConversation, openToolPopup} = setup({status: 'success'})
        const {container} = render(<CombinedCardPopup/>)
        fireEvent.click(container.querySelector(JUMP_SEL) as HTMLElement)
        expect(setActiveConversation).toHaveBeenCalledTimes(1)
        expect(openToolPopup).not.toHaveBeenCalled()
    })
})
