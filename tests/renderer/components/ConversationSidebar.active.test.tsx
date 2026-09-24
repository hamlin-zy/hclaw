// @vitest-environment jsdom
/** 激活态—— 复用 recent 测试的 mock 口径 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup} from '@testing-library/react'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const convState = vi.hoisted(() => ({
    viewScope: {type: 'project', path: '/ws/a'} as any,
    currentWorkspacePath: '/ws/a' as string | null,
    activeConversationId: 'c-a1' as string | null,
    searchQuery: '', collapsedGroupIds: [] as string[], sectionWindowSizes: {} as Record<string, number>,
    singleViewWindowHintShown: false, gitBranches: {} as Record<string, string | null>, gitBranch: 'main',
    pendingFocusProject: null as string | null,
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: [{id: 'c-a1', title: 'a1', preview: '', createdAt: 5, updatedAt: 5, status: 'active'}]}},
    getScopedSections: vi.fn((): any[] => [{
        key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
        collapsed: false, count: 1, hasMore: false, rows: [{id: 'c-a1', indentLevel: 0, childCount: 0}],
    }]),
    expandSection: vi.fn(), dismissWindowHint: vi.fn(), toggleSectionCollapsed: vi.fn(),
    // 既有 mock 遗漏的 store action：激活会话被子会话窗口截掉时（rowById 查不到）组件会调用它
    expandChildParents: vi.fn(),
    focusProjectSegment: vi.fn(), clearFocusProject: vi.fn(), refreshVisibleBranches: vi.fn(async () => {}),
    setSearchQuery: vi.fn(), setProjectGroupView: vi.fn(), preloadConversation: vi.fn(async () => {}),
    openConversationInWorkspace: vi.fn(async () => {}), setActiveConversation: vi.fn(),
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign((sel: any) => sel(convState), {getState: () => convState}),
}))
const agentState = vi.hoisted(() => ({convAgentStates: {} as Record<string, any>, doneUnreadIds: {} as Record<string, number>, clearConvDoneUnread: vi.fn()}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({useAgentStore: (sel: any) => sel(agentState)}))
vi.mock('../../../src/renderer/stores/sidebarStore', async () => {
    // 透传真实 store：组件直接消费 useSidebarStore hook（Task 14 起），整体 mock 会落空
    const actual = await vi.importActual<Record<string, unknown>>('../../../src/renderer/stores/sidebarStore')
    return {...actual}
})
vi.mock('../../../src/renderer/stores/themeStore', () => ({useThemeStore: {getState: () => ({theme: 'light'})}}))
vi.mock('../../../src/renderer/services/newConversation', () => ({newConversation: vi.fn(async () => 'conv-new')}))

import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

beforeEach(() => {
    vi.clearAllMocks()
    useProjectGroupStore.setState({groups: []})
    ;(window as any).electronAPI = {projectManager: {openProjectManager: vi.fn()}}
})
afterEach(cleanup)

/**
 * 激活行 = 行根带 data-active="true" 的那一行。
 * 无 fallback：找不到即抛错，避免静默降级到「第一行」导致断言打在非激活元素上。
 */
const activeRow = (): HTMLElement => {
    const row = document.querySelector('[data-name="conversation-sidebar-item-row"][data-active="true"]')
    if (!row) {
        throw new Error(`未找到激活行（[data-active="true"]），实际渲染到的行：${
            document.querySelectorAll('[data-name="conversation-sidebar-item-row"]').length} 行`)
    }
    return row as HTMLElement
}

describe('会话行激活态', () => {
    it('激活行无左侧竖条（border-left-width 为 0 或不含 border-l 类）', () => {
        render(<ConversationList/>)
        const row = activeRow()
        const cls = row.className
        expect(cls).not.toMatch(/\bborder-l(-\[|\b)/)
        expect(getComputedStyle(row).borderLeftWidth === '0px' || !cls.includes('border-l')).toBe(true)
    })

    it('激活行底色走 --act-bg，且不含绿色类/绿色令牌', () => {
        render(<ConversationList/>)
        const cls = activeRow().className
        expect(cls).toContain('--act-bg')
        expect(cls).not.toMatch(/text-brand|bg-brand|--info|emerald|green/)
    })

    // 判别力补强：竖条是 before: 伪元素、品牌色走令牌，二者都不在「绿色/竖条类名」的字面捕获范围内，
    // 故单列一条直接断言，避免竖条回潮时静默变绿。
    it('激活行不含品牌竖条伪元素与品牌色令牌，文字走 --text-primary', () => {
        render(<ConversationList/>)
        const cls = activeRow().className
        expect(cls).not.toMatch(/before:/)
        expect(cls).not.toMatch(/--brand-primary/)
        expect(cls).toContain('--text-primary')
    })

    // 判别力补强：激活态的四重表达里，绿色图标容器与绿/品牌文字都不在行根 class 上，
    // 故对行内整个子树做一次字面扫描，避免它们单独回潮时全部用例仍绿。
    it('激活行子树内无绿色类与品牌色类（图标容器 / 标题 / 时间一并收敛）', () => {
        render(<ConversationList/>)
        const html = activeRow().innerHTML
        expect(html).not.toMatch(/green|--brand-primary|text-brand/)
    })
})

describe('行背景范围（V13）', () => {
    // V13 前半句「激活底块左缘距会话图标 8px」的适用范围：**仅 indentLevel = 0 的行**
    // （该行不写内联 paddingLeft，间距 = px-2 的 8px）。
    // 缩进行的图标起点由行内联 paddingLeft 决定，底块左缘距图标 = 内联 base(8px) + 16 * n px
    // （n = indentLevel；1 级子会话 = 24px，远非 8px。本改造前内联 base 为 16px，当时为 16 + 16n）。
    // 这是既有架构偏差：缩进压在行内 padding 上，须待 spec §5.5 的 .kids 等价容器化后才能满足 8px，
    // 不属本任务改动面，此处仅登记。
    it('indentLevel = 0 的行带 8px 左右外边距（背景块不贴侧栏左缘）', () => {
        render(<ConversationList/>)
        const row = activeRow()
        expect(row.className).toContain('mx-2')
    })

    it('项目视图下子会话行的缩进比父行多 1 级，且内边距引用 --indent-step', () => {
        // 覆盖 mock 实现（而非仅调用记录）：在 finally 里精确还原，避免污染同文件其它用例
        const originalSections = convState.getScopedSections.getMockImplementation()
        const originalWorkspaces = convState.workspaces
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
            collapsed: false, count: 2, hasMore: false,
            rows: [
                {kind: 'conv', id: 'c-a1', indentLevel: 0, childCount: 1},
                {kind: 'conv', id: 'c-a1c', parentConvId: 'c-a1', indentLevel: 1, childCount: 0},
            ],
        }])
        // 子行渲染除祖先链展开外还要求段窗口内有该会话摘要（workspaces 查得到才不跳过）
        // 子会话摘要带 parentConvId（默认 mock 的会话元素类型未声明该字段，故此处按 mock 口径做断言）
        convState.workspaces = {
            '/ws/a': {
                lastOpenedAt: 1,
                conversations: [
                    {id: 'c-a1', title: 'a1', preview: '', createdAt: 5, updatedAt: 5, status: 'active'},
                    {id: 'c-a1c', title: 'a1c', preview: '', createdAt: 6, updatedAt: 6, status: 'active', parentConvId: 'c-a1'},
                ],
            },
        } as any
        try {
            render(<ConversationList/>)
            const rows = Array.from(document.querySelectorAll('[data-name="conversation-sidebar-item-row"]')) as HTMLElement[]
            // 父行（激活会话自身有子会话）由 store 驱动的展开逻辑默认展开 → 父行 + 子行共两行
            expect(rows.length).toBe(2)
            const depth = (el: HTMLElement) => Number(el.getAttribute('data-indent') ?? '0')
            expect(depth(rows[1]) - depth(rows[0])).toBe(1)
            // jsdom 不加载项目 CSS → 直接读源文件文本断言令牌（口径同 SessionIcon.spec.test.tsx）
            const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/globals.css'), 'utf8')
            expect(css).toMatch(/--indent-step:\s*16px/)
            // 内边距必须真的引用该变量：data-indent 只证明属性被写，不证明缩进用它
            expect(rows[1].style.paddingLeft).toContain('var(--indent-step)')
            // 总偏移锁定（本用例唯一的判别性断言）：内容起点 = mx-2 的 8px + 内联 base 8px + 1 * step
            // = 32px，与改造前（无 mx-2、内联 base 16px + 1 * step）逐字一致。
            // 判别力：内联 base 改回 16px 时 mx-2 引入的 8px 外移无人补偿，本行即刻变红。
            expect(rows[1].style.paddingLeft).toContain('calc(8px + 1 * var(--indent-step))')
            // indentLevel === 0 保持既有行为：不写内联内边距
            expect(rows[0].getAttribute('style') ?? '').not.toContain('padding-left')
        } finally {
            if (originalSections) convState.getScopedSections.mockImplementation(originalSections)
            convState.workspaces = originalWorkspaces
        }
    })
})

describe('父行弱提示（§5.2.3）', () => {
    // 判别力：父行只在「子会话被激活」这一态下提亮，本节用例的断言对象是
    // data-parent-of-active="true" 的那一行，不含 fallback。
    // 用例改写了 hoisted mock 的三处模块级状态（activeConversationId / getScopedSections 实现 /
    // workspaces 的会话数组），全部在 finally 精确还原 —— beforeEach 只 clearAllMocks，
    // 不清实现也不重置数据，裸改会让同文件后续用例读到污染态。
    it('子会话激活时父行仅提亮、不铺底色（§5.2.3）', () => {
        const originalActiveId = convState.activeConversationId
        const originalSections = convState.getScopedSections.getMockImplementation()
        const originalConversations = convState.workspaces['/ws/a'].conversations
        const originalLength = originalConversations.length
        try {
            convState.activeConversationId = 'c-a1c'
            // 刻意模拟「激活会话被窗口截掉」的形态：本节 rows 未带 kind: 'conv'
            // （生产 rows 与 Task 3 用例均带），于是 rowById 查不到激活会话，
            // 组件改走 expandChildParents 兜底路径 —— 这正是该形态要覆盖的分支，非疏漏。
            convState.getScopedSections.mockReturnValue([{
                key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
                collapsed: false, count: 2, hasMore: false,
                rows: [
                    {id: 'c-a1', indentLevel: 0, childCount: 1, childIds: ['c-a1c']},
                    {id: 'c-a1c', parentConvId: 'c-a1', indentLevel: 1, childCount: 0},
                ],
            }])
            // 子会话摘要须落在 workspaces 里（渲染按 id 查摘要，查不到整行跳过）；
            // mock 的会话元素类型未声明 parentConvId，故按 mock 口径 as any（先例见上方 Task 3 用例）
            convState.workspaces['/ws/a'].conversations.push({id: 'c-a1c', title: 'kid', preview: '', createdAt: 6, updatedAt: 6, parentConvId: 'c-a1', status: 'active'} as any)
            render(<ConversationList/>)
            // 子行确实渲染（父行由「激活会话的祖先链保持展开」驱动，非断言放宽的产物）
            expect(document.querySelectorAll('[data-name="conversation-sidebar-item-row"]').length).toBe(2)
            const parent = document.querySelector('[data-parent-of-active="true"]') as HTMLElement | null
            expect(parent).not.toBeNull()
            expect(parent!.className).toContain('--text-primary')
            expect(parent!.className).not.toContain('--act-bg')
            // 行根（containerClass）的 text token 会被子元素的显式色全部覆盖：图标容器 text-gray-400、
            // 标题 div text-gray-600、时间戳 text-gray-400，因此行根断言不足以守住「父行看得见提亮」。
            // 唯一可见的提亮落在标题 div 的 showAsActiveAncestor 支路上，故直接对该元素断言。
            // 选择器用 data-name（与同组件 conversation-sidebar-item-row / -rename-input /
            // recent-item-project-badge 的约定一致），不用 div[title] 这类位置耦合写法。
            const titleEl = parent!.querySelector('[data-name="conversation-sidebar-item-title"]') as HTMLElement | null
            expect(titleEl).not.toBeNull()
            expect(titleEl!.className).toContain('--text-primary')
            // 激活行不是自己的祖先：两态的层级差 = 激活行（底色+提亮）/ 父行（仅提亮）
            expect(parent!.getAttribute('data-active')).toBeNull()
            expect(parent!.getAttribute('data-indent')).toBe('0')
            expect(activeRow().className).toContain('--act-bg')
        } finally {
            convState.activeConversationId = originalActiveId
            if (originalSections) convState.getScopedSections.mockImplementation(originalSections)
            originalConversations.length = originalLength
        }
    })
})
