// @vitest-environment jsdom
/**
 * RepoGroupCard 迁移到 CollapsibleSection 后的折叠语义、批量按钮冒泡、DOM 合法性与 a11y 回归护栏。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, fireEvent, cleanup, waitFor} from '@testing-library/react'
import {AnimatePresence, motion} from 'framer-motion'
import RepoGroupCard from '../../../../src/renderer/components/repo/RepoGroupCard'

const repo = {
    id: 'owner/repo',
    name: 'repo',
    source: 'git',
    capabilities: {skills: [], agents: [], plugins: []},
}

const child = <div data-testid="child">子项</div>

afterEach(() => cleanup())

describe('RepoGroupCard / 受控折叠语义', () => {
    it('初始 collapsed=true → 不渲染 children，aria-expanded=false', () => {
        const {container, queryByTestId} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        expect(header).toBeTruthy()
        expect(header.getAttribute('aria-expanded')).toBe('false')
        expect(queryByTestId('child')).toBeNull()
    })

    it('点击页头 → children 立即渲染（展开方向无退场延迟）', async () => {
        const {container, queryByTestId} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        fireEvent.click(header)
        expect(queryByTestId('child')).toBeTruthy()
        const header2 = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        expect(header2.getAttribute('aria-expanded')).toBe('true')
    })

    it('展开后再点击折叠：记录 jsdom 下 AnimatePresence 退场是否即时卸载 children', async () => {
        const {container, queryByTestId} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        fireEvent.click(container.querySelector('[data-name="repo-group-card-header"]')!)
        expect(queryByTestId('child')).toBeTruthy()

        fireEvent.click(container.querySelector('[data-name="repo-group-card-header"]')!)
        const immediatelyGone = queryByTestId('child') === null
        // 记录现象（不强制断言方向）——交由报告如实呈现
        // eslint-disable-next-line no-console
        console.log('[VERIFY] children removed synchronously on collapse:', immediatelyGone)
        // aria 状态必须立即翻转
        expect((container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
        // 动画结束后（或立即）应卸载
        await waitFor(() => expect(queryByTestId('child')).toBeNull(), {timeout: 3000})
    })
})

describe('RepoGroupCard / 折叠退场延迟是否为回归（对照改动前结构）', () => {
    // 改动前 RepoGroupCard 的折叠结构（复刻 git diff 删除行）
    function LegacyCollapseBody({collapsed, children}: {collapsed: boolean; children: React.ReactNode}) {
        return (
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.div initial={{opacity: 0, height: 0}} animate={{opacity: 1, height: 'auto'}} exit={{opacity: 0, height: 0}}
                        transition={{duration: 0.2, ease: 'easeInOut'}} style={{overflow: 'hidden'}}>
                        <div className="p-2 space-y-1.5 border-t border-[var(--border-muted)]">{children}</div>
                    </motion.div>
                )}
            </AnimatePresence>
        )
    }

    it('改动前：折叠时 children 同样不会同步卸载（退场延迟是既有行为）', () => {
        const {queryByTestId, rerender} = render(
            <LegacyCollapseBody collapsed={false}><div data-testid="legacy-child"/></LegacyCollapseBody>,
        )
        expect(queryByTestId('legacy-child')).toBeTruthy()
        rerender(<LegacyCollapseBody collapsed><div data-testid="legacy-child"/></LegacyCollapseBody>)
        // 与迁移后一致：不是同步卸载
        // eslint-disable-next-line no-console
        console.log('[VERIFY] legacy children removed synchronously:', queryByTestId('legacy-child') === null)
        expect(queryByTestId('legacy-child')).not.toBeNull()
    })
})

describe('RepoGroupCard / 批量按钮不冒泡切换折叠', () => {
    it('点击批量按钮不改变折叠状态，且触发 onToggleBatch', async () => {
        const onToggleBatch = vi.fn(async () => {})
        const agents = [{id: 'a1', enabled: false}, {id: 'a2', enabled: false}]
        const {container, queryByTestId} = render(
            <RepoGroupCard
                repo={repo}
                skillCount={0}
                agentCount={2}
                agents={agents}
                onToggleBatch={onToggleBatch}
            >{child}</RepoGroupCard>,
        )
        const batchBtn = container.querySelector('[data-name="agents-dialog-batch-toggle-button"]') as HTMLButtonElement
        expect(batchBtn).toBeTruthy()
        // 初始折叠
        expect(queryByTestId('child')).toBeNull()

        fireEvent.click(batchBtn)
        // 折叠状态不变
        expect(queryByTestId('child')).toBeNull()
        expect((container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
        await waitFor(() => expect(onToggleBatch).toHaveBeenCalledTimes(1))
        expect(onToggleBatch).toHaveBeenCalledWith(['a1', 'a2'], true)
    })

    it('【本轮新增】键盘：内层批量按钮上的 Enter / Space 不触发外层折叠', () => {
        const onToggleBatch = vi.fn(async () => {})
        const agents = [{id: 'a1', enabled: false}, {id: 'a2', enabled: false}]
        const {container, queryByTestId} = render(
            <RepoGroupCard
                repo={repo}
                skillCount={0}
                agentCount={2}
                agents={agents}
                onToggleBatch={onToggleBatch}
            >{child}</RepoGroupCard>,
        )
        const batchBtn = container.querySelector('[data-name="agents-dialog-batch-toggle-button"]') as HTMLButtonElement
        expect(queryByTestId('child')).toBeNull()

        fireEvent.keyDown(batchBtn, {key: 'Enter'})
        fireEvent.keyDown(batchBtn, {key: ' '})
        // 外层折叠状态不变
        expect(queryByTestId('child')).toBeNull()
        expect((container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    })

    it('batchType 回退到 skills 时 data-name 为 skills-dialog-batch-toggle-button', () => {
        const {container} = render(
            <RepoGroupCard
                repo={repo}
                skillCount={2}
                agentCount={0}
                skills={[{id: 's1', enabled: false}]}
                onToggleBatch={vi.fn(async () => {})}
            >{child}</RepoGroupCard>,
        )
        expect(container.querySelector('[data-name="skills-dialog-batch-toggle-button"]')).toBeTruthy()
    })
})

describe('RepoGroupCard / DOM content model 与旧选择器', () => {
    it('不存在 button 嵌套 button', () => {
        const {container} = render(
            <RepoGroupCard
                repo={repo}
                skillCount={0}
                agentCount={1}
                agents={[{id: 'a1', enabled: true}]}
                onToggleBatch={vi.fn(async () => {})}
            >{child}</RepoGroupCard>,
        )
        expect(container.querySelectorAll('button button').length).toBe(0)
        expect(container.querySelectorAll('button a, a button').length).toBe(0)
    })

    it('页头 trigger 是 div（非 button），批量 button 的最近 button 祖先为 null', () => {
        const {container} = render(
            <RepoGroupCard
                repo={repo}
                skillCount={0}
                agentCount={1}
                agents={[{id: 'a1', enabled: true}]}
                onToggleBatch={vi.fn(async () => {})}
            >{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        expect(header.tagName).toBe('DIV')
        const batchBtn = container.querySelector('[data-name="agents-dialog-batch-toggle-button"]') as HTMLElement
        expect(batchBtn.parentElement!.closest('button')).toBeNull()
    })

    it('旧的 repo-group-card-collapse-button 已不存在', () => {
        const {container} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        expect(container.querySelector('[data-name="repo-group-card-collapse-button"]')).toBeNull()
    })

    it('a11y：页头 div 具备 role=button 与 tabIndex=0（可聚焦、可被辅助技术识别）', () => {
        const {container} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        expect(header.getAttribute('role')).toBe('button')
        expect(header.getAttribute('tabindex')).toBe('0')
        // aria-expanded / aria-label 挂在 role=button 的元素上才会被暴露
        expect(header.getAttribute('aria-expanded')).toBe('false')
        expect(header.getAttribute('aria-label')).toBe('展开分组')
    })

    it('【本轮新增】键盘：Enter 可切换折叠', () => {
        const {container, queryByTestId} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        expect(queryByTestId('child')).toBeNull()

        fireEvent.keyDown(header, {key: 'Enter'})
        expect(queryByTestId('child')).toBeTruthy()
        expect((container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('true')

        fireEvent.keyDown(container.querySelector('[data-name="repo-group-card-header"]')!, {key: 'Enter'})
        expect((container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    })

    it('【本轮新增】键盘：Space 可切换折叠且 preventDefault 防滚动', () => {
        const {container, queryByTestId} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        expect(queryByTestId('child')).toBeNull()

        const notPrevented = fireEvent.keyDown(header, {key: ' '})
        // fireEvent 返回 false 代表 preventDefault 被调用
        expect(notPrevented).toBe(false)
        expect(queryByTestId('child')).toBeTruthy()
        expect((container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement).getAttribute('aria-expanded')).toBe('true')
    })

    it('【本轮新增】其它按键不触发折叠切换', () => {
        const {container, queryByTestId} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const header = container.querySelector('[data-name="repo-group-card-header"]') as HTMLElement
        fireEvent.keyDown(header, {key: 'a'})
        expect(queryByTestId('child')).toBeNull()
        expect(header.getAttribute('aria-expanded')).toBe('false')
    })

    it('【本轮新增】noMargin：CollapsibleSection 根不携带 mb-[var(--space-relaxed)]，且已无 !mb-0 hack', () => {
        const {container} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        const root = container.firstElementChild as HTMLElement
        // motion.div 外层
        const csRoot = root.firstElementChild as HTMLElement
        expect(csRoot.className).not.toContain('mb-[var(--space-relaxed)]')
        expect(csRoot.className).not.toContain('!mb-0')
    })
})

describe('RepoGroupCard / 版本控件显隐（hideVersionControl）', () => {
    it('默认（不传 prop）→ 渲染仓库版本控件（下拉 + 同步按钮）', () => {
        const {container} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0}>{child}</RepoGroupCard>,
        )
        expect(container.querySelector('[aria-label="仓库版本"]')).toBeTruthy()
        expect(container.querySelector('[data-name="repo-sync-versions-button"]')).toBeTruthy()
    })

    it('传 hideVersionControl → 移除整个版本控件，但页头/折叠等其余结构不受影响', () => {
        const {container} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0} hideVersionControl>{child}</RepoGroupCard>,
        )
        expect(container.querySelector('[aria-label="仓库版本"]')).toBeNull()
        expect(container.querySelector('[data-name="repo-sync-versions-button"]')).toBeNull()
        // 防假阴性：卡片页头仍渲染
        expect(container.querySelector('[data-name="repo-group-card-header"]')).toBeTruthy()
    })

    it('显式 hideVersionControl={false} → 仍渲染版本控件（三态语义）', () => {
        const {container} = render(
            <RepoGroupCard repo={repo} skillCount={1} agentCount={0} hideVersionControl={false}>{child}</RepoGroupCard>,
        )
        expect(container.querySelector('[aria-label="仓库版本"]')).toBeTruthy()
    })
})
