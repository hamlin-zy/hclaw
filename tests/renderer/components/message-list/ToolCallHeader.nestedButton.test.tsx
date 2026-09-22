// @vitest-environment jsdom
/**
 * ToolCallHeader「button 嵌套 button」回归测试
 *
 * 缺陷场景：normal（详细）模式下，外层展开开关是 <button>，其内部 metaSection
 * 又渲染了「查看」与「跳转」两个内层 <button>，构成 HTML 非法嵌套，React 运行时报
 * In HTML, <button> cannot be a descendant of <button>. This will cause a hydration error.
 *
 * 修复口径：外层改为 <div role="button" tabIndex={0}>，并补键盘支持与 focus-visible 焦点环；
 * 内层两个按钮结构与 stopPropagation 逻辑保持不变。
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
const VIEW_SEL = '[data-name="tool-call-header-button"]'
const JUMP_SEL = '[data-name="tool-call-header-jump-to-session-button"]'

/** normal 模式 + 同时命中内层两个按钮（查看 / 跳转）的 props */
function buildProps(overrides: Record<string, unknown> = {}) {
    return {
        toolCall: {id: 'tc-1', name: 'agent', arguments: '{}', status: 'success'},
        expanded: true,
        onToggleExpanded: vi.fn(),
        onOpenViewer: vi.fn(),
        onJumpToSession: vi.fn(),
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

describe('ToolCallHeader — 外层展开开关不得嵌套 button', () => {
    it('normal 模式无 button 嵌套 button', () => {
        const {container} = render(<ToolCallHeader {...buildProps()}/>)
        expect(container.querySelectorAll('button button')).toHaveLength(0)
    })

    it('normal 模式同时渲染出内层「查看」与「跳转」按钮（断言前提成立）', () => {
        const {container} = render(<ToolCallHeader {...buildProps()}/>)
        expect(container.querySelector(VIEW_SEL)).toBeTruthy()
        expect(container.querySelector(JUMP_SEL)).toBeTruthy()
    })

    it('compact 模式同样无 button 嵌套 button', () => {
        const {container} = render(<ToolCallHeader {...buildProps({isCompact: true})}/>)
        expect(container.querySelectorAll('button button')).toHaveLength(0)
    })
})

describe('ToolCallHeader — 外层展开开关语义', () => {
    it('是 div[role=button][tabindex=0] 且 aria-expanded 反映 expanded', () => {
        const {container} = render(<ToolCallHeader {...buildProps({expanded: true})}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        expect(toggle.tagName).toBe('DIV')
        expect(toggle.getAttribute('role')).toBe('button')
        expect(toggle.tabIndex).toBe(0)
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })

    it('expanded=false 时 aria-expanded 为 false', () => {
        const {container} = render(<ToolCallHeader {...buildProps({expanded: false})}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
    })

    it('外层开关不再有 button 祖先，内层跳转按钮也不再有任何 button 祖先', () => {
        const {container} = render(<ToolCallHeader {...buildProps()}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        const jump = container.querySelector(JUMP_SEL) as HTMLElement
        expect(toggle.closest('button')).toBeNull()
        // 注意：Element.closest 会匹配到自身，按钮自身即 button，故必须从父元素向上查祖先链
        expect(jump.parentElement!.closest('button')).toBeNull()
    })

    it('保留 data-name 锚点，且带 focus-visible 焦点环（走 CSS 变量）', () => {
        const {container} = render(<ToolCallHeader {...buildProps()}/>)
        const toggle = container.querySelector(TOGGLE_SEL) as HTMLElement
        expect(toggle).toBeTruthy()
        expect(toggle.className).toContain('focus-visible:[outline:2px_solid_var(--focus-ring)]')
        expect(toggle.className).toContain('focus-visible:[outline-offset:2px]')
    })
})

describe('ToolCallHeader — 外层展开开关交互', () => {
    it('Enter 触发一次 onToggleExpanded', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector(TOGGLE_SEL) as HTMLElement, {key: 'Enter'})
        expect(props.onToggleExpanded).toHaveBeenCalledTimes(1)
    })

    it('空格触发一次 onToggleExpanded', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector(TOGGLE_SEL) as HTMLElement, {key: ' '})
        expect(props.onToggleExpanded).toHaveBeenCalledTimes(1)
    })

    it('点击外层开关触发 onToggleExpanded', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector(TOGGLE_SEL) as HTMLElement)
        expect(props.onToggleExpanded).toHaveBeenCalledTimes(1)
    })

    it('内层「跳转」按钮上按 Enter 冒泡到外层时不得触发展开（首行守卫）', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector(JUMP_SEL) as HTMLElement, {key: 'Enter'})
        expect(props.onToggleExpanded).not.toHaveBeenCalled()
    })

    it('内层「查看」按钮上按空格冒泡到外层时不得触发展开', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.keyDown(container.querySelector(VIEW_SEL) as HTMLElement, {key: ' '})
        expect(props.onToggleExpanded).not.toHaveBeenCalled()
    })

    it('点击内层「跳转」按钮只调用 onJumpToSession，不触发展开', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector(JUMP_SEL) as HTMLElement)
        expect(props.onJumpToSession).toHaveBeenCalledTimes(1)
        expect(props.onToggleExpanded).not.toHaveBeenCalled()
    })

    it('点击内层「查看」按钮只调用 onOpenViewer，不触发展开', () => {
        const props = buildProps()
        const {container} = render(<ToolCallHeader {...props}/>)
        fireEvent.click(container.querySelector(VIEW_SEL) as HTMLElement)
        expect(props.onOpenViewer).toHaveBeenCalledTimes(1)
        expect(props.onToggleExpanded).not.toHaveBeenCalled()
    })
})
