// @vitest-environment jsdom
/** 段头五列栅格（spec §5.3.1 / V3 V12 V10）。
 *  折叠入口契约：项目图标按钮（section-project-icon）+ 项目名，图标颜色区分展开/折叠态。 */
import {describe, it, expect, afterEach} from 'vitest'
import {render, cleanup} from '@testing-library/react'
import {ConversationSectionHeader} from '../../../src/renderer/components/ConversationSectionHeader'

afterEach(cleanup)
const section = (over: Record<string, unknown> = {}) => ({
    key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
    collapsed: false, count: 12, hasMore: false, rows: [], ...over,
})
const renderHeader = (over: Record<string, unknown> = {}) => render(
    <ConversationSectionHeader section={section(over) as never}
        onToggleCollapsed={() => {}} onOpenProjectManager={() => {}} onNewConversation={() => {}}/>,
)

describe('段头栅格与语义', () => {
    it('容器为五列栅格（项目图标列 16px、分支列 fit-content(84px)、操作列 fit-content(46px) 可塌陷）', () => {
        const {container} = renderHeader()
        const root = container.querySelector('[data-name="conversation-section-header"]') as HTMLElement
        expect(root.className).toContain('grid-cols-[16px_minmax(0,1fr)_fit-content(84px)_44px_fit-content(46px)]')
        expect(root.className).toContain('gap-1.5')
        // 左缘对齐内容区：段头不再额外内缩（2026-09-30 用户反馈「项目左侧距卡片左边框太远」）
        expect(root.className).toContain('pl-0')
    })

    it('「N 条」紧邻项目段操作按钮（顺序契约：项目图标 → 项目名 → 分支 → 条数 → 操作）', () => {
        const {container} = renderHeader()
        const root = container.querySelector('[data-name="conversation-section-header"]') as HTMLElement
        // DOM 顺序即视觉顺序：条数必须在分支之后、且紧邻操作列（其下一个兄弟节点就是操作容器）——
        // 需求：会话条数靠近项目管理 / 新建会话按钮显示，不隔着空的分支占位
        const names = Array.from(root.children).map(el => (el as HTMLElement).dataset.name ?? 'actions')
        expect(names).toEqual([
            'section-project-icon', 'section-project-name', 'section-branch-badge', 'section-count', 'actions',
        ])
        const countIdx = names.indexOf('section-count')
        expect(root.children[countIdx + 1]).toBe(root.querySelector('[data-name="section-pm-button"]')!.parentElement)
        // 改前红：旧列序把条数排在分支之前（44px 列夹在项目名与分支之间）
    })

    it('「N 条」在折叠态与展开态都渲染（V12）', () => {
        const a = renderHeader()
        expect(a.container.querySelector('[data-name="section-count"]')?.textContent).toContain('12 条')
        cleanup()
        const b = renderHeader({collapsed: true})
        expect(b.container.querySelector('[data-name="section-count"]')?.textContent).toContain('12 条')
    })

    it('项目名为次级灰字 + 截断', () => {
        const {container} = renderHeader()
        const name = container.querySelector('[data-name="section-project-name"]') as HTMLElement
        expect(name.className).toContain('--text-secondary')
        expect(name.className).toContain('truncate')
    })

    it('项目图标颜色区分展开/折叠态（V10 迁移：chevron rotate → 图标色；2026-09-30 两态配色对调）', () => {
        const open = renderHeader()
        const iconOpen = open.container.querySelector('[data-name="section-project-icon"]') as HTMLElement
        expect(iconOpen.getAttribute('aria-expanded')).toBe('true')
        // 对调后：展开态 = 灰（与项目名同色系），折叠态 = 淡品牌色（退到背景暗示已收起）
        expect(iconOpen.style.color).toBe('var(--text-muted)')
        cleanup()
        const shut = renderHeader({collapsed: true})
        const iconShut = shut.container.querySelector('[data-name="section-project-icon"]') as HTMLElement
        expect(iconShut.getAttribute('aria-expanded')).toBe('false')
        expect(iconShut.style.color).toContain('color-mix')
        expect(iconShut.style.color).toContain('var(--brand-primary)')
        // 混色锚点必须落在背景侧（transparent）而不是白色：锚白只在浅色主题下「退到背景」，
        // 深色主题下会被提亮成高对比、使展开/折叠语义反转（2026-09-30 用户反馈）
        expect(iconShut.style.color).toContain('transparent')
        expect(iconShut.style.color).not.toContain('white')
    })

    it('项目图标按钮包含 aria-expanded 与 aria-label（无障碍与旧 chevron 口径对齐）', () => {
        const open = renderHeader()
        const iconOpen = open.container.querySelector('[data-name="section-project-icon"]') as HTMLElement
        expect(iconOpen.getAttribute('aria-label')).toBe('折叠 a')
        expect(iconOpen.getAttribute('aria-expanded')).toBe('true')
        cleanup()
        const shut = renderHeader({collapsed: true})
        const iconShut = shut.container.querySelector('[data-name="section-project-icon"]') as HTMLElement
        expect(iconShut.getAttribute('aria-label')).toBe('展开 a')
        expect(iconShut.getAttribute('aria-expanded')).toBe('false')
    })

    it('无分支时不占位：占位节点宽 0，84px 让给项目名（不再强制同构对齐）', () => {
        const {container} = renderHeader({gitBranch: null})
        expect(container.querySelector('[data-name="section-branch-badge"]')).toBeNull()
        // 分支列只在真有分支时占位（用户拍板 A）：无分支的项目段不再白占 84px 空轨道，
        // 弹性列吃满省下的宽度 —— 代价是「各段条数右缘严格对齐」不再保证
        const placeholder = container.querySelector('[data-name="section-branch-placeholder"]') as HTMLElement
        expect(placeholder).toBeTruthy()
        expect(placeholder.className).toContain('w-0')
        expect(placeholder.className).not.toContain('w-[84px]')
        expect((container.querySelector('[data-name="conversation-section-header"]') as HTMLElement).className)
            .toContain('grid-cols-[16px_minmax(0,1fr)_fit-content(84px)_44px_fit-content(46px)]')
        // 无分支时条数同样紧邻操作列（占位轨在条数左侧，不影响条数与按钮的相邻关系）
        const root = container.querySelector('[data-name="conversation-section-header"]') as HTMLElement
        const names = Array.from(root.children).map(el => (el as HTMLElement).dataset.name ?? 'actions')
        expect(names).toEqual([
            'section-project-icon', 'section-project-name', 'section-branch-placeholder', 'section-count', 'actions',
        ])
    })
})
