// @vitest-environment jsdom
/**
 * CollapsibleSection：trigger/expanded 引入后与既有非受控行为的等价性，以及本轮修复的回归护栏。
 * - 非受控路径与 **参考实现快照** `LegacyCollapsibleSection` 做 innerHTML 字节级比对。
 *   注意：该复制体**不是**「git 删除行的逐字保真」——它是一份会随设计变更**有意同步**两侧的
 *   参考快照（本轮 ring 色随全仓 color-mix 迁移即同步了它）。它拦住的是**结构性**回归
 *   （DOM 层级、className 顺序/内容、属性、状态文案），不负责 token 级回归。
 * - token 级回归由 `tests/renderer/tokenCompliance.capabilityPages.test.ts` 负责，不由本测试负责。
 * - noMargin prop：为 true 时不追加 mb-[var(--space-relaxed)]，非 trigger / trigger 两种模式均生效。
 */
import {describe, it, expect, vi} from 'vitest'
import {useState, type ReactNode} from 'react'
import {render, fireEvent, cleanup} from '@testing-library/react'
import {AnimatePresence, motion} from 'framer-motion'
import CollapsibleSection, {collapsibleTriggerKeyDown} from '../../../../src/renderer/components/common/CollapsibleSection'
import {collapse} from '../../../../src/renderer/lib/motionPresets'

/* ────────────────────────────────────────────────────────────
 * 参考实现快照（Legacy == Reference）
 *
 * 它不是「改动前的实现被冻结」，而是一份与 CollapsibleSection 结构平行的参考副本：
 * 设计变更若触及触发按钮/DOM 结构，**应有意**同步修改两侧，比对才有意义。
 * 两侧 diff 的价值在于抓「无意中改坏了渲染结构」，而非证明「与历史版本逐字节相同」。
 * ──────────────────────────────────────────────────────────── */
interface LegacyProps {
    title: string
    headerContent?: ReactNode
    children: ReactNode
    defaultExpanded?: boolean
    className?: string
    buttonClassName?: string
    contentClassName?: string
    onToggle?: (expanded: boolean) => void
    ariaLabel?: string
}

function LegacyCollapsibleSection({
    title,
    headerContent,
    children,
    defaultExpanded = true,
    className = '',
    buttonClassName = '',
    contentClassName = '',
    onToggle,
    ariaLabel,
}: LegacyProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded)

    const handleToggle = () => {
        const next = !isExpanded
        setIsExpanded(next)
        onToggle?.(next)
    }

    // 注：下方 button 的 ring 色 token 已跟随全仓 color-mix 迁移
    // （`[var(--x)]/NN` 在 Tailwind 3.4 下零产出）——参考快照与 CollapsibleSection.tsx
    // 的 class 串**有意保持逐字节一致**；两侧若出现真实差异，即是需要人工判断的结构变更。
    return (
        <div className={`mb-[var(--space-relaxed)] ${className}`}>
            <button
                onClick={handleToggle}
                aria-expanded={isExpanded}
                aria-label={`${ariaLabel ?? title} ${isExpanded ? '收起' : '展开'}`}
                className={`flex items-center gap-[var(--space-snug)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] ${buttonClassName}`}
                data-name="collapsible-section-button">
                <svg
                    className={`w-3 h-3 transition-transform duration-200 ease-out ${isExpanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                >
                    <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className="font-medium">{title}</span>
                {headerContent}
            </button>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        {...collapse}
                        transition={{duration: 0.2, ease: 'easeInOut'}}
                        className={`overflow-hidden ${contentClassName}`}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

const CASES: Array<{name: string; props: Partial<LegacyProps>}> = [
    {name: '最小 props（默认展开）', props: {}},
    {name: 'defaultExpanded=false', props: {defaultExpanded: false}},
    {name: '带 headerContent', props: {headerContent: <span data-x="hc">3</span>}},
    {name: '带 ariaLabel + 全部 className + onToggle', props: {ariaLabel: '分组', className: '!mb-0', buttonClassName: 'btn-x', contentClassName: 'content-x', onToggle: () => {}}},
    {name: 'defaultExpanded=false + className', props: {defaultExpanded: false, className: '!mb-0'}},
]

describe('CollapsibleSection / 非受控路径与参考实现快照结构等价', () => {
    for (const {name, props} of CASES) {
        it(`${name}：innerHTML 完全一致`, () => {
            const shared = {title: '标题X', children: <div data-testid="child">内容</div>, ...props}
            const legacy = render(<LegacyCollapsibleSection {...shared} />)
            const legacyHtml = legacy.container.innerHTML
            cleanup()
            const current = render(<CollapsibleSection {...shared} />)
            const currentHtml = current.container.innerHTML
            expect(currentHtml).toBe(legacyHtml)
            cleanup()
        })
    }

    it('未传 trigger 时渲染 data-name="collapsible-section-button" 的 button，且外层保留 mb-[var(--space-relaxed)]', () => {
        const {container} = render(<CollapsibleSection title="T"><i/></CollapsibleSection>)
        const root = container.firstElementChild as HTMLElement
        expect(root.className.split(/\s+/)).toContain('mb-[var(--space-relaxed)]')
        const btn = container.querySelector('[data-name="collapsible-section-button"]')
        expect(btn).toBeTruthy()
        expect(btn!.tagName).toBe('BUTTON')
        cleanup()
    })

    it('aria-expanded / aria-label 文案 / chevron 旋转 随状态正确', () => {
        const {container} = render(<CollapsibleSection title="T" defaultExpanded={false}><i/></CollapsibleSection>)
        let btn = container.querySelector('[data-name="collapsible-section-button"]') as HTMLButtonElement
        expect(btn.getAttribute('aria-expanded')).toBe('false')
        expect(btn.getAttribute('aria-label')).toBe('T 展开')
        let svg = btn.querySelector('svg')!
        expect(svg.className.baseVal ?? svg.getAttribute('class')).not.toContain('rotate-90')

        fireEvent.click(btn)
        btn = container.querySelector('[data-name="collapsible-section-button"]') as HTMLButtonElement
        expect(btn.getAttribute('aria-expanded')).toBe('true')
        expect(btn.getAttribute('aria-label')).toBe('T 收起')
        svg = btn.querySelector('svg')!
        expect(svg.getAttribute('class')).toContain('rotate-90')
        cleanup()
    })

    it('ariaLabel 覆盖 title 作为 aria-label 前缀', () => {
        const {container} = render(<CollapsibleSection title="T" ariaLabel="分组" defaultExpanded={false}><i/></CollapsibleSection>)
        const btn = container.querySelector('[data-name="collapsible-section-button"]') as HTMLButtonElement
        expect(btn.getAttribute('aria-label')).toBe('分组 展开')
        cleanup()
    })

    it('非受控点击调用 onToggle(next) 且内部状态翻转', () => {
        const onToggle = vi.fn()
        const {container} = render(<CollapsibleSection title="T" defaultExpanded={false} onToggle={onToggle}><div data-testid="child"/></CollapsibleSection>)
        expect(container.querySelector('[data-testid="child"]')).toBeNull()
        fireEvent.click(container.querySelector('[data-name="collapsible-section-button"]')!)
        expect(onToggle).toHaveBeenCalledTimes(1)
        expect(onToggle).toHaveBeenCalledWith(true)
        expect(container.querySelector('[data-testid="child"]')).toBeTruthy()
        cleanup()
    })

    it('未传 trigger 时 className 仍追加到根元素（旧行为）', () => {
        const {container} = render(<CollapsibleSection title="T" className="extra-cls"><i/></CollapsibleSection>)
        const root = container.firstElementChild as HTMLElement
        expect(root.className).toBe('mb-[var(--space-relaxed)] extra-cls')
        cleanup()
    })
})

describe('CollapsibleSection / 受控路径', () => {
    it('受控 expanded=false：点击不改变内部渲染，但回调收到 !expanded', () => {
        const onToggle = vi.fn()
        const {container} = render(
            <CollapsibleSection title="T" expanded={false} onToggle={onToggle}><div data-testid="child"/></CollapsibleSection>,
        )
        expect(container.querySelector('[data-testid="child"]')).toBeNull()
        // 受控模式使用 trigger 时外部按钮；此处未传 trigger → 仍走默认按钮
        fireEvent.click(container.querySelector('[data-name="collapsible-section-button"]')!)
        expect(onToggle).toHaveBeenCalledWith(true)
        // 未回传新值 → 仍为折叠
        expect(container.querySelector('[data-testid="child"]')).toBeNull()
        cleanup()
    })

    it('受控 expanded=true：已展开，点击回调收到 false', () => {
        const onToggle = vi.fn()
        const {container} = render(
            <CollapsibleSection title="T" expanded onToggle={onToggle}><div data-testid="child"/></CollapsibleSection>,
        )
        expect(container.querySelector('[data-testid="child"]')).toBeTruthy()
        fireEvent.click(container.querySelector('[data-name="collapsible-section-button"]')!)
        expect(onToggle).toHaveBeenCalledWith(false)
        cleanup()
    })

    it('传入 trigger 时替换默认按钮（trigger 内不产生 collapsible-section-button）', () => {
        const {container} = render(
            <CollapsibleSection title="T" expanded={false} trigger={<div data-name="my-trigger">hdr</div>}><i/></CollapsibleSection>,
        )
        expect(container.querySelector('[data-name="collapsible-section-button"]')).toBeNull()
        expect(container.querySelector('[data-name="my-trigger"]')).toBeTruthy()
        cleanup()
    })

    it('trigger={undefined} 与不传等价（走默认按钮分支）', () => {
        const {container} = render(<CollapsibleSection title="T" trigger={undefined}><i/></CollapsibleSection>)
        expect(container.querySelector('[data-name="collapsible-section-button"]')).toBeTruthy()
        cleanup()
    })

    it('trigger={null} 会退化为不渲染 trigger 且不渲染按钮（边界：null !== undefined）', () => {
        const {container} = render(<CollapsibleSection title="T" trigger={null}><i/></CollapsibleSection>)
        // null 不是 undefined → 走 trigger 分支 → 什么都不渲染
        expect(container.querySelector('[data-name="collapsible-section-button"]')).toBeNull()
        cleanup()
    })
})

describe('CollapsibleSection / noMargin（消除 !mb-0 抽象泄漏）', () => {
    it('noMargin 未传（默认）：根元素保留 mb-[var(--space-relaxed)]', () => {
        const {container} = render(<CollapsibleSection title="T"><i/></CollapsibleSection>)
        const root = container.firstElementChild as HTMLElement
        expect(root.className.split(/\s+/)).toContain('mb-[var(--space-relaxed)]')
        cleanup()
    })

    it('noMargin=true（非 trigger 模式）：根元素无 mb-[var(--space-relaxed)]', () => {
        const {container} = render(<CollapsibleSection title="T" noMargin><i/></CollapsibleSection>)
        const root = container.firstElementChild as HTMLElement
        expect(root.className).not.toContain('mb-[var(--space-relaxed)]')
        cleanup()
    })

    it('noMargin=true（trigger 模式）：根元素无 mb-[var(--space-relaxed)]，且 className 仍可追加', () => {
        const {container} = render(
            <CollapsibleSection title="T" noMargin className="extra-cls" expanded={false} trigger={<div data-name="t2">h</div>}><i/></CollapsibleSection>,
        )
        const root = container.firstElementChild as HTMLElement
        expect(root.className).not.toContain('mb-[var(--space-relaxed)]')
        expect(root.className).toContain('extra-cls')
        cleanup()
    })

    it('noMargin 未传 + trigger 模式：仍保留默认下边距', () => {
        const {container} = render(
            <CollapsibleSection title="T" expanded={false} trigger={<div data-name="t3">h</div>}><i/></CollapsibleSection>,
        )
        const root = container.firstElementChild as HTMLElement
        expect(root.className.split(/\s+/)).toContain('mb-[var(--space-relaxed)]')
        cleanup()
    })
})

describe('collapsibleTriggerKeyDown helper', () => {
    it('Enter 触发 toggle', () => {
        const toggle = vi.fn()
        const el = {}
        const e = {key: 'Enter', target: el, currentTarget: el, preventDefault: vi.fn()}
        collapsibleTriggerKeyDown(toggle)(e as never)
        expect(toggle).toHaveBeenCalledTimes(1)
        expect(e.preventDefault).toHaveBeenCalled()
    })

    it('Space 触发 toggle 并 preventDefault（防滚动）', () => {
        const toggle = vi.fn()
        const el = {}
        const e = {key: ' ', target: el, currentTarget: el, preventDefault: vi.fn()}
        collapsibleTriggerKeyDown(toggle)(e as never)
        expect(toggle).toHaveBeenCalledTimes(1)
        expect(e.preventDefault).toHaveBeenCalled()
    })

    it('内层元素冒泡上来的事件（target !== currentTarget）不触发 toggle', () => {
        const toggle = vi.fn()
        const e = {key: 'Enter', target: {x: 1}, currentTarget: {x: 2}, preventDefault: vi.fn()}
        collapsibleTriggerKeyDown(toggle)(e as never)
        expect(toggle).not.toHaveBeenCalled()
    })

    it('其它按键不触发 toggle', () => {
        const toggle = vi.fn()
        const el = {}
        const e = {key: 'a', target: el, currentTarget: el, preventDefault: vi.fn()}
        collapsibleTriggerKeyDown(toggle)(e as never)
        expect(toggle).not.toHaveBeenCalled()
    })
})
