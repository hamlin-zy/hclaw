// @vitest-environment jsdom
/** 抽屉选中高亮中性化（spec §6.2：绿色只表达运行状态，当前项 = 中性灰） */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup, fireEvent} from '@testing-library/react'

const groupState = {
    groups: [
        {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
         members: [{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}]},
    ],
    load: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    dissolve: vi.fn(),
    remove: vi.fn(),
    assign: vi.fn(),
    reorderGroups: vi.fn(),
    reorderProjects: vi.fn(),
}

vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: (sel?: (s: typeof groupState) => unknown) => (sel ? sel(groupState) : groupState),
    projectGroupOf: () => null,
}))

const convState = {
    workspaces: {
        '/ws/a': {lastOpenedAt: 3, conversations: []},
        '/ws/b': {lastOpenedAt: 2, conversations: []},
        // /ws/c 不在组内 → 渲染为顶层项目行（= 当前工作区，作选中态断言对象）
        '/ws/c': {lastOpenedAt: 1, conversations: []},
        // /ws/d 同样不在组内、也不是当前工作区 → 第二条顶层项目行：有它在，"选中底色判定"
        // 才不会退化成"夹具里只有一条顶层行，所以怎么过滤都只剩一条"的恒真断言
        '/ws/d': {lastOpenedAt: 2, conversations: []},
    } as Record<string, {lastOpenedAt: number; conversations: unknown[]}>,
    currentWorkspacePath: '/ws/c',
    viewScope: {type: 'group', groupId: 'pg-a'} as any,
    setWorkspace: vi.fn(),
    setProjectGroupView: vi.fn(),
    focusProjectSegment: vi.fn(),
    removeWorkspace: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(async (): Promise<string | null> => null),
}

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: typeof convState) => unknown) => (sel ? sel(convState) : convState),
}))

vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({confirm: vi.fn(async () => true)}))

import {ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'

beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
        openFolderDialog: vi.fn(async () => null),
        openPath: vi.fn(),
    }
    convState.viewScope = {type: 'group', groupId: 'pg-a'}
    convState.currentWorkspacePath = '/ws/c'
})
afterEach(() => {
    delete (window as any).electronAPI
    cleanup()
})

const renderDrawer = () => {
    const drawerRef = {current: null as HTMLDivElement | null}
    render(<ProjectGroupDrawer drawerRef={drawerRef} search="" setSearch={() => {}} onClose={() => {}}/>)
}

/**
 * 选中底色的独立 token 判定：类名里**恰好出现** `bg-[var(--surface-muted)]` 这一项。
 * 不能用 `toContain('bg-[var(--surface-muted)]')` —— 非选中分支的
 * `hover:bg-[var(--surface-muted)]` 含同一子串，那种写法对两态都成立（恒真、无判别力）。
 */
const hasNeutralBg = (el: HTMLElement) => /(^|\s)bg-\[var\(--surface-muted\)\]/.test(el.className)

describe('抽屉当前项中性灰（§6.2）', () => {
    it('scoped 组头不含品牌绿（brand-muted / text-brand），用 surface-muted 中性灰', () => {
        renderDrawer()
        const header = document.querySelector('[data-name="group-block-header"][data-group-id="pg-a"]') as HTMLElement
        expect(hasNeutralBg(header)).toBe(true)
        expect(header.className).not.toContain('brand-muted')
        expect(header.className).not.toContain('text-brand')
    })

    it('面板成员行当前项通过中性灰表达（§6.2），不含品牌绿；未命中行不高亮', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        renderDrawer()
        fireEvent.focus(document.querySelector('[data-name="group-block-header"]') as HTMLElement)
        const hit = document.querySelector('[data-name="drawer-group-member-0"]') as HTMLElement
        expect(hit).toBeTruthy()
        // 独立 token 判定：hover:bg-[…] 不算选中底色
        expect(hasNeutralBg(hit)).toBe(true)
        expect(hit.className).toContain('text-[var(--text-primary)]')
        expect(hit.className).not.toContain('brand-muted')
        expect(hit.className).not.toContain('text-brand')
        // 未命中成员行保持默认（无选中底色）
        const miss = document.querySelector('[data-name="drawer-group-member-1"]') as HTMLElement
        expect(hasNeutralBg(miss)).toBe(false)
    })

    it('面板头行在「当前所在组」时也用中性灰（不引入品牌绿）', () => {
        renderDrawer()
        fireEvent.focus(document.querySelector('[data-name="group-block-header"]') as HTMLElement)
        const head = document.querySelector('[data-name="drawer-group-panel-header-pg-a"]') as HTMLElement
        expect(hasNeutralBg(head)).toBe(true)
        expect(head.className).not.toContain('brand-muted')
        expect(head.className).not.toContain('text-brand')
    })
    it('选中顶层项目行（= 当前工作区）中性灰 + 中性对勾，无品牌绿', () => {
        renderDrawer()
        const selected = Array.from(document.querySelectorAll('[data-name="top-project-row"]'))
            .filter(el => hasNeutralBg(el as HTMLElement))
        // 夹具里有两条顶层行（/ws/c 选中、/ws/d 未选中）：用 hasNeutralBg 过滤后必须恰好剩一条 ——
        // 判据若退回 includes('bg-[…]')，未选中行的 hover:bg-[…] 也会被算进来 → 此处会变 2
        expect(document.querySelectorAll('[data-name="top-project-row"]').length).toBe(2)
        expect(selected.length).toBe(1)
        expect(selected[0].className).not.toContain('brand-muted')
        expect(selected[0].className).not.toContain('text-brand')
        // 对勾：语义保留，只换中性色（不再 brand-primary）；用 polyline 锚定选中对勾图标
        const check = Array.from(selected[0].querySelectorAll('svg polyline'))
            .map(p => p.closest('svg'))[0]
        expect(check).toBeTruthy()
        expect(check!.getAttribute('class')).not.toContain('brand-primary')
        expect(check!.getAttribute('class')).toContain('text-[var(--text-secondary)]')
    })
})
