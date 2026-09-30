// @vitest-environment jsdom
/**
 * ToolCallHeader Agent 卡片点击语义测试
 *
 * 需求：当传入 onCardClick（Agent 卡片）时，卡片点击区改为「跳转」语义：
 * - 详情（normal）模式：点击/键盘触发 onCardClick，不再触发 onToggleExpanded，
 *   去掉展开箭头与 aria-expanded（已不可展开）。
 * - 简洁（compact）模式：卡片整体可点击，触发 onCardClick。
 * 不传 onCardClick 时（非 Agent 卡片）保持原有展开开关语义（由 nestedButton 测试覆盖）。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, fireEvent} from '@testing-library/react'
import ToolCallHeader from '../../../../src/renderer/components/message-list/ToolCallHeader'
import {SuccessIcon} from '../../../../src/renderer/components/icons'

const baseCfg = {
    color: 'text-[var(--success)]',
    bg: 'bg-[var(--success-muted)]',
    icon: SuccessIcon,
    label: '完成',
}

const TOGGLE_SEL = '[data-name="tool-call-header-toggle-expanded-button"]'
const CARD_CLICK_SEL = '[data-name="tool-call-header-card-click-button"]'

function buildProps(overrides: Record<string, unknown> = {}) {
    return {
        toolCall: {id: 'tc-1', name: 'agent', arguments: '{}', status: 'success'},
        expanded: false,
        onToggleExpanded: vi.fn(),
        onOpenViewer: vi.fn(),
        onJumpToSession: vi.fn(),
        onCardClick: vi.fn(),
        cfg: baseCfg,
        isRunning: false,
        hasProgress: false,
        progressPercent: 0,
        effectiveStatus: 'success',
        agentDisplayName: 'Implementer Agent',
        agentTypeLabel: null,
        skillDisplayName: null,
        mcpDisplayName: null,
        summary: null,
        terminalDisplay: null,
        isSubAgent: true,
        hasOutput: true,
        isCompact: false,
        ...overrides,
    } as any
}

describe('ToolCallHeader — Agent 卡片点击语义（normal）', () => {
    it('点击卡片非按钮区触发 onCardClick，不触发 onToggleExpanded', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector(TOGGLE_SEL) as HTMLElement)
        expect(props.onCardClick).toHaveBeenCalledTimes(1)
        expect(props.onToggleExpanded).not.toHaveBeenCalled()
    })

    it('键盘 Enter 触发 onCardClick', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector(TOGGLE_SEL) as HTMLElement, {key: 'Enter'})
        expect(props.onCardClick).toHaveBeenCalledTimes(1)
    })

    it('不再带 aria-expanded（已不可展开）', () => {
        const {container} = render(<ToolCallHeader {...buildProps()}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        expect(toggle.hasAttribute('aria-expanded')).toBe(false)
    })

    it('不再渲染展开箭头（▸/▾）', () => {
        const {container} = render(<ToolCallHeader {...buildProps()}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        expect(toggle.textContent).not.toContain('▸')
        expect(toggle.textContent).not.toContain('▾')
    })

    it('内层「跳转」按钮仍只触发 onJumpToSession，不触发 onCardClick', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector('[data-name="tool-call-header-jump-to-session-button"]') as HTMLElement)
        expect(props.onJumpToSession).toHaveBeenCalledTimes(1)
        expect(props.onCardClick).not.toHaveBeenCalled()
    })
})

describe('ToolCallHeader — Agent 卡片点击语义（compact）', () => {
    it('卡片整体可点击，触发 onCardClick', () => {
        const props = buildProps({isCompact: true})
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector(CARD_CLICK_SEL) as HTMLElement)
        expect(props.onCardClick).toHaveBeenCalledTimes(1)
    })

    it('键盘 Enter 触发 onCardClick', () => {
        const props = buildProps({isCompact: true})
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector(CARD_CLICK_SEL) as HTMLElement, {key: 'Enter'})
        expect(props.onCardClick).toHaveBeenCalledTimes(1)
    })

    it('内层「跳转」按钮点击只触发 onJumpToSession，不冒泡触发 onCardClick', () => {
        const props = buildProps({isCompact: true})
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector('[data-name="tool-call-header-jump-to-session-button"]') as HTMLElement)
        expect(props.onJumpToSession).toHaveBeenCalledTimes(1)
        expect(props.onCardClick).not.toHaveBeenCalled()
    })

    it('内层「查看」按钮点击只触发 onOpenViewer，不冒泡触发 onCardClick', () => {
        const props = buildProps({isCompact: true})
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector('[data-name="tool-call-header-button"]') as HTMLElement)
        expect(props.onOpenViewer).toHaveBeenCalledTimes(1)
        expect(props.onCardClick).not.toHaveBeenCalled()
    })

    it('内层按钮上按 Enter 不冒泡触发 onCardClick（事件源守卫）', () => {
        const props = buildProps({isCompact: true})
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector('[data-name="tool-call-header-jump-to-session-button"]') as HTMLElement, {key: 'Enter'})
        expect(props.onCardClick).not.toHaveBeenCalled()
    })
})

describe('ToolCallHeader — 非 Agent 卡片（无 onCardClick）保持原样', () => {
    it('normal 模式仍保留 aria-expanded 与展开箭头', () => {
        const {container} = render(<ToolCallHeader {...buildProps({onCardClick: undefined})}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expect(toggle.textContent).toContain('▸')
    })

    it('compact 模式无可点击卡片区', () => {
        const {container} = render(<ToolCallHeader {...buildProps({isCompact: true, onCardClick: undefined})}/>)
        expect(container.querySelector(CARD_CLICK_SEL)).toBeNull()
    })
})