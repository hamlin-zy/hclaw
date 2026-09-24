// @vitest-environment jsdom
/**
 * 抽屉两层结构（R-30 恢复二级面板）：常态成员只在层 2 面板里，层 1 不再内联成员树；
 * 搜索态是唯一例外 —— 命中成员内联在层 1 组头之下（D2），且此态不开面板。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'
import {ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'
import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

beforeEach(() => {
    useProjectGroupStore.setState({
        groups: [{id: 'g1', name: '前端组', sortOrder: 0, createdAt: 1, updatedAt: 1,
                  members: [{projectPath: '/ws/a', groupOrder: 0}]}] as never,
    })
    ;(window as any).electronAPI = {
        openFolderDialog: vi.fn(async () => null),
        openPath: vi.fn(),
        workspace: {selectDirectory: vi.fn(async () => '/ws/new'), listWorkspaces: vi.fn(async () => [])},
        projectManager: {openProjectManager: vi.fn()},
    }
})
afterEach(() => {
    cleanup()
    delete (window as any).electronAPI
})

const q = (n: string, root: ParentNode = document) => root.querySelector(`[data-name="${n}"]`) as HTMLElement | null

const renderDrawer = (search = '') => render(
    <ProjectGroupDrawer drawerRef={{current: null}} search={search} setSearch={() => {}} onClose={() => {}}/>,
)

/** 焦点路径开面板：组头 onFocus 立即开（D4），同步可得 */
function openPanel() {
    fireEvent.focus(q('group-block-header')!)
    if (!q('drawer-group-panel')) throw new Error('焦点进组头后未打开二级面板')
}

describe('抽屉两层结构（层 1 组头 / 层 2 二级面板）', () => {
    it('R-30 负向：常态下组头之下没有内联成员树（成员不再全铺在一级抽屉里）', () => {
        renderDrawer()
        expect(q('group-block')).not.toBeNull()
        expect(q('group-block-header')).not.toBeNull()
        // 内联区、内联成员行、内联行主体、chevron 全部退场
        expect(q('group-member-list')).toBeNull()
        expect(q('group-member-row')).toBeNull()
        expect(q('group-member-open-g1-0')).toBeNull()
        expect(q('group-toggle')).toBeNull()
    })

    it('成员在二级面板里：焦点进组头即浮出面板（dialog），成员行随之出现', () => {
        renderDrawer()
        expect(q('drawer-group-panel')).toBeNull()
        openPanel()
        const panel = q('drawer-group-panel')!
        expect(panel.getAttribute('role')).toBe('dialog')
        expect(panel.getAttribute('aria-label')).toBe('项目组 前端组')
        expect(q('drawer-group-member-0', panel)).not.toBeNull()
    })

    it('「+ 加入本组」阻断组头行：不进组视图、不关抽屉、不触发拖拽（F17）', () => {
        const onClose = vi.fn()
        render(<ProjectGroupDrawer drawerRef={{current: null}} search="" setSearch={() => {}} onClose={onClose}/>)
        const groupsBefore = JSON.stringify(useProjectGroupStore.getState().groups)
        const scopeBefore = JSON.stringify(useConversationStore.getState().viewScope)
        const add = q('group-add-project')!
        // stopPropagation 生效时组头行的 beginDrag 不会被触发（拖拽态不出现 = 落点行不产生拖拽副作用）
        fireEvent.pointerDown(add)
        fireEvent.click(add)
        expect(onClose).not.toHaveBeenCalled()
        // 可观测后果：成员未加错/落库不发生 + 不进组视图
        expect(JSON.stringify(useProjectGroupStore.getState().groups)).toBe(groupsBefore)
        expect(JSON.stringify(useConversationStore.getState().viewScope)).toBe(scopeBefore)
    })

    it('「+ 加入本组」携带组名 aria-label（可访问名可读）', () => {
        renderDrawer()
        expect(q('group-add-project')!.getAttribute('aria-label')).toContain('前端组')
    })
})

describe('抽屉搜索态（D2：内联命中成员，面板不开）', () => {
    it('搜索态命中成员内联在层 1 组头之下，行主体是可聚焦的真按钮', () => {
        renderDrawer('ws')
        expect(q('group-member-list')).not.toBeNull()
        const row = q('group-member-row')!
        expect(row).not.toBeNull()
        // 两态分离（§5.8.5）：搜索态行不带拖拽契约（过滤后的列表不是稳定排序视图）
        expect(row.getAttribute('data-drag-row')).toBeNull()
        expect(row.getAttribute('data-index')).toBeNull()
        const open = q('group-member-open-g1-0')!
        expect(open.tagName).toBe('BUTTON')
        expect(open.textContent).toContain('/ws/a')
    })

    it('搜索态下 hover / 焦点进组头都不开面板（成员已在层 1 可见，面板只会遮住它们）', async () => {
        renderDrawer('ws')
        fireEvent.mouseEnter(q('group-block-header')!)
        fireEvent.focus(q('group-block-header')!)
        await new Promise((resolve) => setTimeout(resolve, 200)) // 越过 120ms 开面板延时
        expect(q('drawer-group-panel')).toBeNull()
        // 内联命中成员仍在
        expect(q('group-member-row')).not.toBeNull()
    })
})
