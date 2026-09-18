// @vitest-environment jsdom
/**
 * MemoPanel 作用域取数 / 项目徽章 / 组视图暂停拖拽测试（Task 18）
 *
 * 覆盖用例：
 * 1. 组视图：按作用域取数（loadForScope 收到组内成员路径 + group:<id>），每条显示项目徽章
 *    （文案 = 项目 basename，title = 完整路径）
 * 2. 单项目视图：不显示项目徽章
 * 3. 组视图暂停拖拽重排（D11）：无 Reorder 容器（无拖拽手柄），拖拽手势后不落库（updateItem 未被调用）
 * 4. 单项目视图可拖拽（回归）：Reorder 容器存在
 * 5. 面板标题显示当前作用域（组名 / 项目名）
 * 6. 作用域内项目的 memo_changed 推送 → 按最新作用域重新取数
 *
 * mock 约定：memoStore / conversationStore / projectGroupStore 按 mockZustandStore 模式；
 * electronAPI.openConfigWindow 以 vi.fn stub。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import type {MemoItem} from '@/shared/types/memo'
import type {ProjectGroupWithMembers} from '@/shared/types/projectGroup'

const PA = 'E:\\proj-a'
const PB = 'E:\\proj-b'

const h = vi.hoisted(() => {
    const memoState: Record<string, unknown> = {
        memos: [] as MemoItem[],
        loading: false,
        error: null,
        load: vi.fn(async () => {}),
        loadForScope: vi.fn(async () => {}),
        subscribeMemoChangedForScope: vi.fn(() => () => {}),
        create: vi.fn(async () => null),
        updateItem: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        removeMany: vi.fn(async () => {}),
        createSession: vi.fn(async () => null),
    }
    const useMemoStore: any = (selector?: (s: unknown) => unknown) => (selector ? selector(memoState) : memoState)
    useMemoStore.getState = () => memoState as never
    useMemoStore.setState = (partial: unknown) => {
        Object.assign(memoState, typeof partial === 'function' ? (partial as (s: unknown) => unknown)(memoState) : partial)
    }

    const convState: Record<string, unknown> = {
        currentWorkspacePath: 'E:\\proj-a',
        viewScope: {type: 'project', path: 'E:\\proj-a'},
        workspaces: {
            'E:\\proj-a': {lastOpenedAt: 1, conversations: [{id: 'conv-1'}]},
            'E:\\proj-b': {lastOpenedAt: 2, conversations: []},
        },
        setActiveConversation: vi.fn(),
    }
    const useConversationStore: any = (selector?: (s: unknown) => unknown) => (selector ? selector(convState) : convState)
    useConversationStore.getState = () => convState as never

    const groupState: {groups: ProjectGroupWithMembers[]} = {groups: []}
    const useProjectGroupStore: any = (selector?: (s: unknown) => unknown) => (selector ? selector(groupState) : groupState)
    useProjectGroupStore.getState = () => groupState as never

    const openConfigWindow = vi.fn(async () => {})
    /** 组视图新建默认项目的断言目标（R-BY）：mock openMemoCreateWindow 直接捕获入参 */
    const openMemoCreateWindow = vi.fn()

    return {useMemoStore, convState, useConversationStore, groupState, useProjectGroupStore, openConfigWindow, openMemoCreateWindow}
})

vi.mock('@/renderer/stores/memoStore', () => ({
    useMemoStore: h.useMemoStore,
    openMemoCreateWindow: h.openMemoCreateWindow,
}))
vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: h.useConversationStore,
}))
vi.mock('@/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: h.useProjectGroupStore,
}))
vi.mock('@/renderer/components/ConfirmDialog', () => ({
    confirm: vi.fn(async () => true),
}))

beforeEach(() => {
    vi.stubGlobal('electronAPI', {openConfigWindow: h.openConfigWindow})
})
afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    h.convState.currentWorkspacePath = PA
    h.convState.viewScope = {type: 'project', path: PA}
    h.convState.workspaces = {
        [PA]: {lastOpenedAt: 1, conversations: [{id: 'conv-1'}]},
        [PB]: {lastOpenedAt: 2, conversations: []},
    }
    h.groupState.groups = []
    h.useMemoStore.setState({
        memos: [],
        // 个别用例会替换订阅实现（捕获 handler），此处复位保证用例互不影响
        subscribeMemoChangedForScope: vi.fn(() => () => {}),
    })
})

import MemoPanel from '@/renderer/components/memo/MemoPanel'

const item = (id: string, workspacePath: string, over: Partial<MemoItem> = {}): MemoItem => ({
    id,
    workspacePath,
    content: `memo-${id}`,
    title: `memo-${id}`,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    status: 'active',
    ...over,
})

const group = (id: string, name: string, paths: string[]): ProjectGroupWithMembers => ({
    id,
    name,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    members: paths.map((projectPath, i) => ({projectPath, groupOrder: i})),
})

/** 组视图：viewScope 指向组 + 组数据（成员顺序即渲染顺序） */
function enterGroupView(paths = [PA, PB]) {
    h.convState.viewScope = {type: 'group', groupId: 'pg-a'}
    h.groupState.groups = [group('pg-a', '小组A', paths)]
}

describe('MemoPanel · 作用域取数', () => {
    it('组视图按组内成员路径取数（scopeKey = group:<id>）', () => {
        enterGroupView()
        render(<MemoPanel/>)
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenCalledWith([PA, PB], 'group:pg-a')
    })

    it('单项目视图按当前项目取数（scopeKey = project:<path>）', () => {
        render(<MemoPanel/>)
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenCalledWith([PA], `project:${PA}`)
    })

    it('组不存在（已解散）→ 回退当前项目单段', () => {
        h.convState.viewScope = {type: 'group', groupId: 'pg-gone'}
        h.groupState.groups = []
        render(<MemoPanel/>)
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenCalledWith([PA], 'group:pg-gone')
    })

    it('作用域内项目的 memo_changed 推送 → 按最新作用域重新取数；作用域外忽略', () => {
        let handler: ((p: {workspacePath: string}) => void) | undefined
        h.useMemoStore.getState().subscribeMemoChangedForScope = vi.fn((getPaths: () => string[], cb: () => void) => {
            handler = (p) => { if (getPaths().includes(p.workspacePath)) cb() }
            return () => {}
        })
        enterGroupView()
        render(<MemoPanel/>)
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenCalledTimes(1)

        handler!({workspacePath: PB})
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenCalledTimes(2)
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenLastCalledWith([PA, PB], 'group:pg-a')

        handler!({workspacePath: 'E:\\other'})
        expect(h.useMemoStore.getState().loadForScope).toHaveBeenCalledTimes(2)
    })
})

describe('MemoPanel · 项目徽章（组视图）', () => {
    it('组视图每条显示项目徽章：文案 = 项目 basename，title = 完整路径', () => {
        enterGroupView()
        h.useMemoStore.setState({memos: [item('m1', PA), item('m2', PB)]})
        render(<MemoPanel/>)

        const badges = screen.getAllByTestId('memo-project-badge')
        expect(badges.map((b) => b.textContent)).toEqual(['proj-a', 'proj-b'])
        expect(badges.map((b) => b.getAttribute('title'))).toEqual([PA, PB])
    })

    it('单项目视图不显示项目徽章', () => {
        h.useMemoStore.setState({memos: [item('m1', PA), item('m2', PA)]})
        render(<MemoPanel/>)
        expect(screen.queryAllByTestId('memo-project-badge')).toHaveLength(0)
    })
})

describe('MemoPanel · 拖拽重排开关', () => {
    it('组视图暂停拖拽：无 Reorder 容器，拖拽手势后不落库（updateItem 未被调用）', () => {
        enterGroupView()
        h.useMemoStore.setState({memos: [item('m1', PA), item('m2', PB)]})
        render(<MemoPanel/>)

        expect(screen.queryByTestId('memo-reorder-list')).toBeNull()
        // 即便在条目上走一遍拖拽手势，也不产生 sortIndex 落库
        const row = screen.getAllByTestId('memo-item')[0]
        fireEvent.pointerDown(row, {clientX: 10, clientY: 10, button: 0, pointerId: 1})
        fireEvent.pointerMove(row, {clientX: 10, clientY: 60, pointerId: 1})
        fireEvent.pointerUp(row, {clientX: 10, clientY: 60, pointerId: 1})
        expect(h.useMemoStore.getState().updateItem).not.toHaveBeenCalled()
    })

    it('单项目视图可拖拽（回归）：Reorder 容器存在', () => {
        h.useMemoStore.setState({memos: [item('m1', PA), item('m2', PA)]})
        render(<MemoPanel/>)
        expect(screen.getByTestId('memo-reorder-list')).toBeTruthy()
    })
})

describe('MemoPanel · 标题作用域', () => {
    it('组视图标题显示组名', () => {
        enterGroupView()
        render(<MemoPanel/>)
        expect(screen.getByTestId('memo-panel-title').textContent).toBe('备忘录 · 小组A')
    })

    it('单项目视图标题显示项目名', () => {
        render(<MemoPanel/>)
        expect(screen.getByTestId('memo-panel-title').textContent).toBe('备忘录 · proj-a')
    })
})

// ── Task 19 / R-BY：组视图新建备忘录的默认项目 ──
describe('MemoPanel · 组视图新建默认项目', () => {
    const clickNew = () => fireEvent.click(screen.getByLabelText('新建备忘录 (Ctrl+Shift+N)'))

    it('组视图：仍调用 openMemoCreateWindow，且带的是回退值 currentWorkspacePath（解析已收口到 store）', () => {
        enterGroupView([PA, PB])
        h.convState.currentWorkspacePath = PA
        // 组内最近活跃项目是 PB（updatedAt 更大）——但解析不在此处做，面板应原样传回退值 PA。
        // 端到端「解析后项目」断言落在 tests/renderer/stores/memoStore.scope.test.ts。
        h.convState.workspaces = {
            [PA]: {lastOpenedAt: 9, conversations: [{id: 'c1', createdAt: 999, updatedAt: 100}]},
            [PB]: {lastOpenedAt: 1, conversations: [{id: 'c2', createdAt: 1, updatedAt: 900}]},
        }
        render(<MemoPanel/>)

        clickNew()
        expect(h.openMemoCreateWindow).toHaveBeenCalledWith(PA)
        expect(h.openMemoCreateWindow).not.toHaveBeenCalledWith(PB)
    })

    it('组视图：作用域内完全没有会话 → 回退 currentWorkspacePath', () => {
        enterGroupView([PA, PB])
        h.convState.currentWorkspacePath = PA
        h.convState.workspaces = {
            [PA]: {lastOpenedAt: 1, conversations: []},
            [PB]: {lastOpenedAt: 2, conversations: []},
        }
        render(<MemoPanel/>)

        clickNew()
        expect(h.openMemoCreateWindow).toHaveBeenCalledWith(PA)
    })

    it('单项目视图（回归）：仍传 currentWorkspacePath，不受组内最近活跃影响', () => {
        h.convState.currentWorkspacePath = PA
        h.convState.workspaces = {
            [PA]: {lastOpenedAt: 1, conversations: [{id: 'c1', updatedAt: 1}]},
            [PB]: {lastOpenedAt: 9, conversations: [{id: 'c2', updatedAt: 900}]},
        }
        render(<MemoPanel/>)

        clickNew()
        expect(h.openMemoCreateWindow).toHaveBeenCalledWith(PA)
    })
})
