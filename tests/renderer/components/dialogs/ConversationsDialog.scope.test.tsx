// @vitest-environment jsdom
/**
 * ConversationsDialog — 级联筛选（项目组 + 项目）与跨项目行为（Task 20）
 *
 * 覆盖：
 * 1. 默认加载 scope = {scope:'all'}（跨项目全貌），且不依赖 currentWorkspacePath
 * 2. 选组 → {scope:'group', groupId, workspacePaths:[组成员路径]}
 * 3. 「未分组」→ {scope:'group', groupId:'__ungrouped__', workspacePaths: 顶层项目路径}
 *    （主进程不查 workspaces.group_id，组范围完全由渲染端 workspacePaths 驱动）
 * 4. 选项目 → {scope:'project', workspacePath}
 * 5. 表格「项目」列（表头顺序 + 单元格 basename / title 完整路径）
 * 6. 跨项目批量删除：子会话总数按**各会话所属项目**分别解析（不把全部选中 id 传给每个项目）
 * 7. 时间快捷选择作用于**当前筛选结果**
 * 8. 级联数据不可用 → 降级为「只有全部项目」，不抛错
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react'
import type {ConversationStatsScope} from '@shared/types/conversationStats'
import type {ConversationWithStats} from '@shared/types'
import type {ProjectGroupWithMembers} from '@shared/types/projectGroup'

const h = vi.hoisted(() => {
    const listWithStats = vi.fn<(scope: ConversationStatsScope) => Promise<ConversationWithStats[]>>(async () => [])
    const groupList = vi.fn(async () => [] as unknown[])
    const workspaceList = vi.fn(async () => [] as unknown[])
    // 只需确认文案，不关心其余选项 → 只声明用到的字段
    const confirmMock = vi.fn<(opts: {message: string}) => Promise<boolean>>(async () => true)
    /** 会话 store 桩：组件只用 (s) => s.deleteConversations 取删除动作、getState() 取 workspaces */
    const store = {
        currentWorkspacePath: '/ws/a' as string | null,
        workspaces: {} as Record<string, {lastOpenedAt: number; conversations: unknown[]}>,
        loadConversations: vi.fn(async () => {}),
        deleteConversations: vi.fn<(ids: string[]) => Promise<void>>(async () => {}),
    }
    return {listWithStats, groupList, workspaceList, confirmMock, store}
})

// 真实 confirm 依赖 window 事件 + 用户点击才会 resolve，删除确认文案必须打桩后取出
vi.mock('../../../../src/renderer/components/ConfirmDialog', () => ({confirm: h.confirmMock}))
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (sel?: (s: typeof h.store) => unknown) => (sel ? sel(h.store) : h.store),
        {getState: () => h.store},
    ),
}))

import ConversationsDialog from '../../../../src/renderer/components/dialogs/ConversationsDialog'

const WA = '/ws/a'
const WB = '/ws/b'

type Row = ConversationWithStats

const row = (over: Partial<Row>): Row => ({
    id: 'c1',
    title: '会话',
    workspacePath: WA,
    createdAt: 1,
    updatedAt: 1,
    preview: '',
    status: 'active',
    messageCount: 1,
    blockCount: 1,
    ...over,
})

const pg = (id: string, name: string, paths: string[]): ProjectGroupWithMembers => ({
    id,
    name,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    members: paths.map((projectPath, groupOrder) => ({projectPath, groupOrder})),
})

const ws = (path: string) => ({id: `ws-${path}`, path, name: path, createdAt: 1, updatedAt: 1})

function stubApi(opts: {
    /** 会话列表返回值；给函数时按 scope 返回（模拟主进程按范围过滤） */
    conversations?: Row[] | ((scope: ConversationStatsScope) => Row[])
    groups?: ProjectGroupWithMembers[]
    workspaces?: Array<{id: string; path: string; name: string; createdAt: number; updatedAt: number}>
    /** 模拟 project-group:list 抛错（降级用例） */
    groupsFail?: boolean
    /** 模拟 workspace:list 抛错（降级用例） */
    workspacesFail?: boolean
} = {}) {
    h.listWithStats.mockImplementation(async (scope: ConversationStatsScope) =>
        typeof opts.conversations === 'function' ? opts.conversations(scope) : (opts.conversations ?? []))
    h.groupList.mockResolvedValue(opts.groups ?? [])
    h.workspaceList.mockResolvedValue(opts.workspaces ?? [])
    vi.stubGlobal('electronAPI', {
        conversationListWithStats: h.listWithStats,
        projectGroup: {
            list: opts.groupsFail ? vi.fn(async () => { throw new Error('project-group:list 失败') }) : h.groupList,
        },
        workspace: {
            list: opts.workspacesFail ? vi.fn(async () => { throw new Error('workspace:list 失败') }) : h.workspaceList,
        },
    })
}

/** 等筛选下拉渲染出来（首屏加载态没有它），可选校验某个 option 已出现（级联数据到位） */
async function selectEl(name: string, optionValue?: string): Promise<HTMLSelectElement> {
    return await waitFor(() => {
        const el = document.querySelector(`[data-name="${name}"]`) as HTMLSelectElement | null
        expect(el).toBeTruthy()
        if (optionValue !== undefined) {
            expect(Array.from(el!.options).map((o) => o.value)).toContain(optionValue)
        }
        return el!
    })
}

async function checkboxesOf(count: number): Promise<HTMLInputElement[]> {
    return await waitFor(() => {
        const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
        expect(boxes).toHaveLength(count)
        return boxes
    })
}

beforeEach(() => {
    h.store.currentWorkspacePath = WA
    h.store.workspaces = {}
    vi.clearAllMocks()
    stubApi({})
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

describe('ConversationsDialog — scope 推导（级联筛选）', () => {
    it('默认加载：{scope:"all"}（不施加范围，直接看跨项目全貌）', async () => {
        stubApi({conversations: [row({id: 'c1'})]})
        render(<ConversationsDialog/>)
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({scope: 'all'}))
    })

    it('store 尚未解析出当前项目时仍以 {scope:"all"} 加载（不再以 currentWorkspacePath 为前置）', async () => {
        h.store.currentWorkspacePath = null
        stubApi({conversations: []})
        render(<ConversationsDialog/>)
        await waitFor(() => expect(h.store.loadConversations).toHaveBeenCalled())
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({scope: 'all'}))
    })

    it('选组 → {scope:"group", groupId, workspacePaths:[组成员路径]}', async () => {
        stubApi({
            conversations: [row({id: 'c1'})],
            groups: [pg('pg-a', '组A', [WA])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)
        const groupSelect = await selectEl('conversations-group-filter', 'pg-a')
        fireEvent.change(groupSelect, {target: {value: 'pg-a'}})
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({
            scope: 'group',
            groupId: 'pg-a',
            workspacePaths: [WA],
        }))
    })

    it('「未分组」→ {scope:"group", groupId:"__ungrouped__", workspacePaths: 顶层项目路径}', async () => {
        stubApi({
            conversations: [row({id: 'c1'})],
            groups: [pg('pg-a', '组A', [WA])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)
        const groupSelect = await selectEl('conversations-group-filter', '__ungrouped__')
        fireEvent.change(groupSelect, {target: {value: '__ungrouped__'}})
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({
            scope: 'group',
            groupId: '__ungrouped__',
            workspacePaths: [WB],
        }))
    })

    it('「未分组」且无顶层项目 → 空路径数组，不报错（空态仍可切回筛选）', async () => {
        stubApi({
            conversations: (scope) => (scope.scope === 'group' && scope.workspacePaths.length === 0 ? [] : [row({id: 'c1'})]),
            groups: [pg('pg-a', '组A', [WA, WB])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)
        const groupSelect = await selectEl('conversations-group-filter', '__ungrouped__')
        fireEvent.change(groupSelect, {target: {value: '__ungrouped__'}})
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({
            scope: 'group',
            groupId: '__ungrouped__',
            workspacePaths: [],
        }))
        // 空列表不白屏、不抛错：空态 + 筛选条仍在（否则筛出空结果后无法切回）
        await waitFor(() => expect(screen.getByText('暂无会话')).toBeTruthy())
        expect(document.querySelector('[data-name="conversations-group-filter"]')).toBeTruthy()
    })

    it('选项目 → {scope:"project", workspacePath}', async () => {
        stubApi({
            conversations: [row({id: 'c1'})],
            groups: [pg('pg-a', '组A', [WA])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)
        const projectSelect = await selectEl('conversations-project-filter', WB)
        fireEvent.change(projectSelect, {target: {value: WB}})
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({
            scope: 'project',
            workspacePath: WB,
        }))
    })

    it('选「未归属」→ {scope:"unassigned"}（workspacePath 为空的会话）', async () => {
        stubApi({
            conversations: [row({id: 'c1', workspacePath: ''})],
            groups: [pg('pg-a', '组A', [WA])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)
        const projectSelect = await selectEl('conversations-project-filter', '__unassigned__')
        fireEvent.change(projectSelect, {target: {value: '__unassigned__'}})
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({scope: 'unassigned'}))
    })

    it('级联数据均不可用 → 降级为「只有全部项目」，不抛错', async () => {
        stubApi({conversations: [row({id: 'c1'})], groupsFail: true, workspacesFail: true})
        render(<ConversationsDialog/>)
        const projectSelect = await selectEl('conversations-project-filter')
        expect(Array.from(projectSelect.options).map((o) => o.value)).toEqual(['', '__unassigned__'])
        expect(projectSelect.options[0].textContent).toBe('全部项目')
        expect(projectSelect.options[1].textContent).toBe('未归属')
        const groupSelect = await selectEl('conversations-group-filter')
        expect(Array.from(groupSelect.options).map((o) => o.value)).toEqual([''])
        await waitFor(() => expect(h.listWithStats).toHaveBeenCalledWith({scope: 'all'}))
    })
})

describe('ConversationsDialog — 项目列', () => {
    it('「项目」列插在标题列之后；单元格 = basename，title = 完整路径', async () => {
        stubApi({conversations: [row({id: 'c1', workspacePath: WA})]})
        render(<ConversationsDialog/>)
        await waitFor(() => expect(
            document.querySelector('[data-name="conversations-dialog-project-cell"]'),
        ).toBeTruthy())

        const header = screen.getByText('标题').parentElement!
        expect(Array.from(header.children).map((el) => el.textContent))
            .toEqual(['', '标题', '项目', '消息数', 'Block 数', '最后更新'])

        const cell = document.querySelector('[data-name="conversations-dialog-project-cell"]') as HTMLElement
        expect(cell.textContent).toBe('a')
        expect(cell.getAttribute('title')).toBe(WA)
    })
})

describe('ConversationsDialog — 跨项目批量删除', () => {
    it('子会话总数按各会话所属项目分别解析（不把全部选中 id 传给每个项目）', async () => {
        const c1 = row({id: 'c1', workspacePath: WA})
        const c2 = row({id: 'c2', workspacePath: WA, parentConvId: 'c1'})
        const c3 = row({id: 'c3', workspacePath: WB})
        const c4 = row({id: 'c4', workspacePath: WB, parentConvId: 'c3'})
        const c5 = row({id: 'c5', workspacePath: WB, parentConvId: 'c4'})
        // store 里两个项目各自的会话集（后代展开的数据源）
        h.store.workspaces = {
            [WA]: {lastOpenedAt: 1, conversations: [c1, c2]},
            [WB]: {lastOpenedAt: 1, conversations: [c3, c4, c5]},
        }
        stubApi({conversations: [c1, c2, c3, c4, c5], workspaces: [ws(WA), ws(WB)]})
        render(<ConversationsDialog/>)

        // 选中 c1（/ws/a，带 1 个子会话）与 c3（/ws/b，带 2 个后代）
        const boxes = await checkboxesOf(5)
        fireEvent.click(boxes[0])
        fireEvent.click(boxes[2])
        await waitFor(() => expect(screen.getByText('已选 2 项')).toBeTruthy())

        fireEvent.click(document.querySelector('[data-name="conversations-dialog-delete-button"]') as HTMLElement)

        const message = h.confirmMock.mock.calls[0][0].message
        // 正确口径：wsA 2（c1+c2）+ wsB 3（c3+c4+c5）- 2（选中自身）= 3
        // 低估（只查当前项目）→ 1；高估（每个项目都传全部选中 id）→ 5
        expect(message).toContain('含 3 个子会话将一并删除')
    })

    it('跨项目选中（各 1 个选中 + 各 1 个后代）→ 实删集恰为 选中∪后代，文案子会话数 = 2', async () => {
        const c1 = row({id: 'c1', workspacePath: WA})
        const c2 = row({id: 'c2', workspacePath: WA, parentConvId: 'c1'})
        const c3 = row({id: 'c3', workspacePath: WB})
        const c4 = row({id: 'c4', workspacePath: WB, parentConvId: 'c3'})
        // store 里两个项目各自的会话集（后代展开的数据源）
        h.store.workspaces = {
            [WA]: {lastOpenedAt: 1, conversations: [c1, c2]},
            [WB]: {lastOpenedAt: 1, conversations: [c3, c4]},
        }
        stubApi({conversations: [c1, c2, c3, c4], workspaces: [ws(WA), ws(WB)]})
        render(<ConversationsDialog/>)

        const boxes = await checkboxesOf(4)
        fireEvent.click(boxes[0]) // c1（/ws/a，带 1 个子会话 c2）
        fireEvent.click(boxes[2]) // c3（/ws/b，带 1 个子会话 c4）
        await waitFor(() => expect(screen.getByText('已选 2 项')).toBeTruthy())

        fireEvent.click(document.querySelector('[data-name="conversations-dialog-delete-button"]') as HTMLElement)

        const opts = h.confirmMock.mock.calls[0][0] as unknown as {message: string; onConfirm: () => Promise<void>}
        // 文案与实收集同源：2（两项目各自 1 个后代）
        expect(opts.message).toContain('含 2 个子会话将一并删除')

        await opts.onConfirm()
        // 实删集恰为「选中 2 个 + 两个后代」：少一个（如 store 只按当前项目展开漏掉 /ws/b 的 c4）即红
        expect(h.store.deleteConversations).toHaveBeenCalledTimes(1)
        expect(new Set(h.store.deleteConversations.mock.calls[0][0])).toEqual(new Set(['c1', 'c2', 'c3', 'c4']))
    })
})

describe('ConversationsDialog — 时间快捷选择', () => {
    it('作用于当前筛选结果（筛选外的旧会话不被选中）', async () => {
        const now = Date.now()
        const oldA = row({id: 'a-old', workspacePath: WA, updatedAt: now - 10 * 86400000})
        const newA = row({id: 'a-new', workspacePath: WA, updatedAt: now - 1000})
        const oldB = row({id: 'b-old', workspacePath: WB, updatedAt: now - 30 * 86400000})
        stubApi({
            conversations: (scope) => (scope.scope === 'group' ? [oldA, newA] : [oldA, newA, oldB]),
            groups: [pg('pg-a', '组A', [WA])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)
        const groupSelect = await selectEl('conversations-group-filter', 'pg-a')
        fireEvent.change(groupSelect, {target: {value: 'pg-a'}})
        await checkboxesOf(2)

        const preset = await waitFor(() => {
            const el = document.querySelector('[data-name="conversations-dialog-time-preset-2"]') as HTMLElement | null
            expect(el).toBeTruthy()
            return el!
        })
        fireEvent.click(preset) // 7天前

        await waitFor(() => expect(screen.getByText('已选 1 项')).toBeTruthy())
        const boxes = await checkboxesOf(2)
        expect(boxes[0].checked).toBe(true)  // a-old（筛选结果内的旧会话）
        expect(boxes[1].checked).toBe(false) // a-new
    })
})

describe('ConversationsDialog — 切换筛选后选区与列表同源（R-CI）', () => {
    it('切到不含原选中的作用域 → 选区清空（计数 0、删除按钮禁用、不触发删除）', async () => {
        const a1 = row({id: 'a1', workspacePath: WA})
        const a2 = row({id: 'a2', workspacePath: WA})
        const b1 = row({id: 'b1', workspacePath: WB})
        // 切组前：全部（/ws/a 两条）；切组后：组A（仅 /ws/b）——与选区完全不相交
        stubApi({
            conversations: (scope) => (scope.scope === 'group' ? [b1] : [a1, a2]),
            groups: [pg('pg-a', '组A', [WB])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)

        // 在「全部」勾选 /ws/a 的两条
        const boxes = await checkboxesOf(2)
        fireEvent.click(boxes[0])
        fireEvent.click(boxes[1])
        await waitFor(() => expect(screen.getByText('已选 2 项')).toBeTruthy())

        // 切到不含这两条的项目组 → 列表刷新为 /ws/b，选区应随之清空
        const groupSelect = await selectEl('conversations-group-filter', 'pg-a')
        fireEvent.change(groupSelect, {target: {value: 'pg-a'}})
        await checkboxesOf(1)

        await waitFor(() => {
            expect(screen.queryByText('已选 2 项')).toBeNull()
            expect(screen.queryByText(/已选 \d+ 项/)).toBeNull()
        })
        const deleteBtn = document.querySelector('[data-name="conversations-dialog-delete-button"]') as HTMLButtonElement
        expect(deleteBtn.disabled).toBe(true)
        expect(deleteBtn.textContent).toContain('删除选中')
        expect(deleteBtn.textContent).not.toContain('(2)')

        // 极端路径：确认框不弹、store 不被调用（否则会出现"文案说 2、实际一条未删"的静默 0 删）
        fireEvent.click(deleteBtn)
        expect(h.confirmMock).not.toHaveBeenCalled()
        expect(h.store.deleteConversations).not.toHaveBeenCalled()
    })

    it('切到含部分原选中的作用域 → 只保留交集（计数 = |交集|，实收集 = 交集 ∪ 后代）', async () => {
        const a1 = row({id: 'a1', workspacePath: WA})
        const a2 = row({id: 'a2', workspacePath: WA, parentConvId: 'a1'})
        const b1 = row({id: 'b1', workspacePath: WB})
        // 后代展开数据源：/ws/a 内含 a1 → a2
        h.store.workspaces = {[WA]: {lastOpenedAt: 1, conversations: [a1, a2]}}
        stubApi({
            // 全部 → 与 /ws/a 无关的一条也在列表内；收窄到项目 /ws/a → 多出 a2（a1 的后代）
            conversations: (scope) => (scope.scope === 'project' ? [a1, a2] : [a1, b1]),
            groups: [pg('pg-a', '组A', [WA])],
            workspaces: [ws(WA), ws(WB)],
        })
        render(<ConversationsDialog/>)

        // 「全部」下勾选 a1（/ws/a）与 b1（/ws/b）
        const boxes = await checkboxesOf(2)
        fireEvent.click(boxes[0]) // a1
        fireEvent.click(boxes[1]) // b1
        await waitFor(() => expect(screen.getByText('已选 2 项')).toBeTruthy())

        // 收窄到项目 /ws/a → 交集仅 {a1}
        const projectSelect = await selectEl('conversations-project-filter', WA)
        fireEvent.change(projectSelect, {target: {value: WA}})
        await checkboxesOf(2)

        await waitFor(() => expect(screen.getByText('已选 1 项')).toBeTruthy())
        const after = await checkboxesOf(2)
        expect(after.map((b) => b.checked)).toEqual([true, false]) // a1 保留、a2 未选

        fireEvent.click(document.querySelector('[data-name="conversations-dialog-delete-button"]') as HTMLElement)
        const opts = h.confirmMock.mock.calls[0][0] as unknown as {message: string; onConfirm: () => Promise<void>}
        // 文案 ← 交集：1 个选中 + 1 个后代（残留的 b1 若未清理，这里会变成 2 个会话 / 0 个子会话）
        expect(opts.message).toContain('确定要删除选中的 1 个会话吗？')
        expect(opts.message).toContain('含 1 个子会话将一并删除')

        await opts.onConfirm()
        // 实收集 = 交集 ∪ 后代（不含已被切出范围的 b1）
        expect(new Set(h.store.deleteConversations.mock.calls[0][0])).toEqual(new Set(['a1', 'a2']))
    })
})
