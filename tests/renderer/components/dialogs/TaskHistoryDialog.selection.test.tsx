// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import TaskHistoryDialog from '../../../../src/renderer/components/dialogs/TaskHistoryDialog'
import ConfirmDialog from '../../../../src/renderer/components/ConfirmDialog'

const DAY = 86400000
const NOW = Date.now()

type TestBatch = {
    id: string
    name: string
    status: string
    createdAt: number
    completedAt: number | null
    total: number
    done: number
}
type TestGroup = { conversationId: string; conversationTitle: string; batches: TestBatch[] }

/** 造批次：name 恒为 `批次-${id}`（行定位依赖此约定），默认每批 2 个任务 */
function mkBatch(id: string, createdAt: number, over: Partial<TestBatch> = {}): TestBatch {
    return {
        id,
        name: `批次-${id}`,
        status: 'completed',
        createdAt,
        completedAt: createdAt + 60000,
        total: 2,
        done: 2,
        ...over,
    }
}

/** 数据集：conv-a 含「40 天前」的 a-old 与「1 小时前」的 a-new；conv-b 含「10 天前」的 b-mid
 *  total 刻意互不相同（2 / 3 / 5，合计 10）：恒等的 total 无法区分「正确求和」与
 * 「selectedCount × 每批固定值」这类退化实现（原 3×2=6 的断言对两者都成立）。 */
function seed(): TestGroup[] {
    return [
        {
            conversationId: 'conv-a',
            conversationTitle: '会话A',
            batches: [
                mkBatch('a-old', NOW - 40 * DAY, {total: 2, done: 2}),
                mkBatch('a-new', NOW - 3600_000, {total: 3, done: 3}),
            ],
        },
        {
            conversationId: 'conv-b',
            conversationTitle: '会话B',
            batches: [mkBatch('b-mid', NOW - 10 * DAY, {total: 5, done: 5})],
        },
    ]
}

let dbGroups: TestGroup[]
let listMock: ReturnType<typeof vi.fn>
let removeMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    dbGroups = seed()
    // fake 的已知局限：搜索只按批次 name 匹配（真实实现是「批次名或任务标题」）
    listMock = vi.fn(async (args?: { filter?: string }) => {
        const f = args?.filter
        if (!f) return dbGroups
        return dbGroups
            .map(g => ({...g, batches: g.batches.filter(b => b.name.includes(f))}))
            .filter(g => g.batches.length > 0)
    })
    removeMock = vi.fn(async () => {})
    vi.stubGlobal('electronAPI', {
        dialogType: 'task-history',
        taskConvId: '',
        workspace: {getCurrent: vi.fn(async () => ({path: 'E:/ws'}))},
        taskBatches: {list: listMock, remove: removeMock, getTasks: vi.fn(async () => [])},
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function renderDialog() {
    return render(
        <>
            <TaskHistoryDialog/>
            <ConfirmDialog/>
        </>
    )
}

async function waitReady() {
    // 工具栏出现即代表 ready + 首次加载完成（不绑定具体批次名，便于各用例自造数据）
    await screen.findByText('全选')
}

/** 行内 checkbox：用 data-name 锚点定位行（不依赖 Tailwind 布局类，布局改动不会碎） */
function rowCheckbox(name: string): HTMLInputElement {
    const row = screen.getByText(name).closest('[data-name]') as HTMLElement
    expect(row, `未找到「${name}」所在行`).toBeTruthy()
    return row.querySelector('input[type="checkbox"]') as HTMLInputElement
}

function clickEl(dataName: string) {
    const el = document.querySelector(`[data-name="${dataName}"]`) as HTMLElement
    expect(el, `未找到 [data-name="${dataName}"]`).toBeTruthy()
    fireEvent.click(el)
}

/** 输入搜索词（组件有 300ms 防抖，调用方负责 waitFor 结果） */
function typeFilter(value: string) {
    fireEvent.change(document.querySelector('[data-name="task-history-dialog-filter-input"]') as HTMLElement,
        {target: {value}})
}

/** 时间预设下拉（公共组件 ThemedSelect：靠触发按钮的 ariaLabel 定位） */
function presetTrigger(): HTMLElement {
    return screen.getByLabelText('按时间选择批次')
}

/** 触发按钮上回显的文本（占位或当前预设 label）＝ `按时间选择…` / `30天前` */
function presetLabel(): string {
    return presetTrigger().textContent ?? ''
}

/** 展开下拉并点选某个预设（选项由 ThemedSelect 用 portal 挂到 body，用 role=option 定位） */
function pickPreset(label: string) {
    fireEvent.click(presetTrigger())
    fireEvent.click(screen.getByRole('option', {name: label}))
}

/** 确认弹窗可见文本（含标题、正文、按钮） */
function confirmDialogText(): string {
    const el = document.querySelector('[data-name="confirm-dialog-div"]') as HTMLElement | null
    expect(el, '确认弹窗未出现').toBeTruthy()
    return el!.textContent ?? ''
}

/** 点删除 → 确认弹窗 → 确认（触发 taskBatches.remove） */
async function deleteSelected() {
    fireEvent.click(screen.getByText(/删除选中/))
    await waitFor(() =>
        expect(document.querySelector('[data-name="confirm-dialog-confirm-button"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-name="confirm-dialog-confirm-button"]') as HTMLElement)
    await waitFor(() => expect(removeMock).toHaveBeenCalled())
}

describe('TaskHistoryDialog 删除范围选择', () => {
    it('全选只吃当前可见批次（含侧栏会话筛选）', async () => {
        renderDialog()
        await waitReady()

        // 侧栏选中「会话A」→ 列表只剩 conv-a 的批次
        clickEl('task-history-dialog-group-0')
        await waitFor(() => expect(screen.queryByText('批次-b-mid')).toBeNull())

        clickEl('task-history-dialog-select-all-button')

        expect(screen.getByText('已选 2 个批次')).toBeTruthy()
        expect(rowCheckbox('批次-a-old').checked).toBe(true)
        expect(rowCheckbox('批次-a-new').checked).toBe(true)

        await deleteSelected()
        expect(removeMock).toHaveBeenCalledWith(['a-old', 'a-new'])
    })

    it('反选 = 对当前可见集合取补（可见集合 ⊊ 全量）', async () => {
        // 构造可见集合严格小于全量摊平：会话A 的 a-keep 命中搜索、a-drop 被搜索滤掉；
        // 会话B 的 b-keep 命中搜索但被侧栏滤掉。
        // → 侧栏选中会话A + 搜索 "keep"：visibleBatches = [a-keep]，groups 摊平 = [a-keep, b-keep]
        dbGroups = [
            {
                conversationId: 'conv-a', conversationTitle: '会话A',
                batches: [mkBatch('a-keep', NOW - 2 * DAY), mkBatch('a-drop', NOW - DAY)],
            },
            {conversationId: 'conv-b', conversationTitle: '会话B', batches: [mkBatch('b-keep', NOW - 3 * DAY)]},
        ]
        renderDialog()
        await screen.findByText('批次-a-keep')

        clickEl('task-history-dialog-group-0')            // 侧栏：会话A
        typeFilter('keep')                                // 搜索进一步收窄
        await waitFor(() => expect(screen.queryByText('批次-a-drop')).toBeNull())
        expect(screen.queryByText('批次-b-keep')).toBeNull()   // 不可见，但仍在 groups 里
        expect(screen.getByText('批次-a-keep')).toBeTruthy()

        fireEvent.click(rowCheckbox('批次-a-keep'))
        expect(screen.getByText('已选 1 个批次')).toBeTruthy()

        clickEl('task-history-dialog-invert-selection-button')

        // 补集 = 可见 {a-keep} − 已选 {a-keep} = 空。若误用全量 groups 摊平，会选中 b-keep（已选 1）
        await waitFor(() => expect(screen.queryByText(/已选 /)).toBeNull())

        clickEl('task-history-dialog-invert-selection-button')

        // 空集取补 = 可见 {a-keep}。若误用全量 groups 摊平，会选中 a-keep + b-keep（已选 2）
        await waitFor(() => expect(screen.getByText('已选 1 个批次')).toBeTruthy())
        expect(rowCheckbox('批次-a-keep').checked).toBe(true)

        await deleteSelected()
        expect(removeMock).toHaveBeenCalledWith(['a-keep'])
    })

    it('取消选中 = 清空全部选中（含当前不可见的会话）', async () => {
        renderDialog()
        await waitReady()

        clickEl('task-history-dialog-group-0')            // 侧栏：会话A
        clickEl('task-history-dialog-select-all-button')
        expect(screen.getByText('已选 2 个批次')).toBeTruthy()

        // 切到会话B：a-old / a-new 变为不可见，但仍在选中集里
        clickEl('task-history-dialog-group-1')
        await waitFor(() => expect(screen.queryByText('批次-a-old')).toBeNull())
        expect(screen.getByText('已选 2 个批次')).toBeTruthy()
        expect(rowCheckbox('批次-b-mid').checked).toBe(false)

        clickEl('task-history-dialog-clear-selection-button')

        // 「取消选中」语义即全清：连不可见的 a-old / a-new 一并清掉
        // （若实现成「只清可见项」，这里会残留「已选 2 个批次」）
        await waitFor(() => expect(screen.queryByText(/已选 /)).toBeNull())

        clickEl('task-history-dialog-all-conversations-tab-button')
        await screen.findByText('批次-a-old')
        expect(rowCheckbox('批次-a-old').checked).toBe(false)
        expect(rowCheckbox('批次-a-new').checked).toBe(false)
    })

    it('时间预设锚定 createdAt：与 completedAt 方向相反时只选前者', async () => {
        // 两条批次在「创建轴」与「完成轴」上方向相反：
        // - a-old-created：40 天前创建、刚刚完成 → 锚 createdAt 应命中；锚 completedAt 会漏掉
        // - a-old-completed：刚刚创建、40 天前完成 → 锚 createdAt 不应命中；锚 completedAt 会误选
        dbGroups = [
            {
                conversationId: 'conv-a', conversationTitle: '会话A',
                batches: [
                    mkBatch('a-old-created', NOW - 40 * DAY, {completedAt: NOW - 60_000}),
                    mkBatch('a-old-completed', NOW - 60_000, {completedAt: NOW - 40 * DAY}),
                ],
            },
        ]
        renderDialog()
        await screen.findByText('批次-a-old-created')

        // 时间预设下拉选「30天前」
        pickPreset('30天前')

        expect(screen.getByText('已选 1 个批次')).toBeTruthy()
        expect(rowCheckbox('批次-a-old-created').checked).toBe(true)
        expect(rowCheckbox('批次-a-old-completed').checked).toBe(false)

        await deleteSelected()
        expect(removeMock).toHaveBeenCalledWith(['a-old-created'])
    })

    it('改搜索词后选中项原样保留（搜索只改变可见集合）', async () => {
        renderDialog()
        await waitReady()

        clickEl('task-history-dialog-select-all-button')
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()

        // 敲搜索词：未命中的 a-old / b-mid 只是不可见，不得从选中集里掉
        typeFilter('new')

        await waitFor(() => expect(screen.queryByText('批次-b-mid')).toBeNull())

        expect(screen.getByText('已选 3 个批次')).toBeTruthy()
        expect(rowCheckbox('批次-a-new').checked).toBe(true)

        // 清空搜索词，选择依然原样
        typeFilter('')
        await screen.findByText('批次-b-mid')

        expect(screen.getByText('已选 3 个批次')).toBeTruthy()
        expect(rowCheckbox('批次-a-old').checked).toBe(true)
        expect(rowCheckbox('批次-b-mid').checked).toBe(true)

        await deleteSelected()
        expect(removeMock).toHaveBeenCalledWith(expect.arrayContaining(['a-old', 'a-new', 'b-mid']))
    })

    it('剔除判据取全量数据：侧栏筛选下无过滤重载也只剔真正消失的批次', async () => {
        renderDialog()
        await waitReady()

        clickEl('task-history-dialog-select-all-button')
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()

        // 侧栏切到会话A（b-mid 不可见）
        clickEl('task-history-dialog-group-0')
        await waitFor(() => expect(screen.queryByText('批次-b-mid')).toBeNull())
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()   // 切侧栏不误剔

        // 模拟 a-old 在别处被删除
        dbGroups = [
            {conversationId: 'conv-a', conversationTitle: '会话A', batches: [mkBatch('a-new', NOW - 3600_000)]},
            {conversationId: 'conv-b', conversationTitle: '会话B', batches: [mkBatch('b-mid', NOW - 10 * DAY)]},
        ]

        // 非空 filter 的重载不做剔除
        typeFilter('new')
        await waitFor(() => expect(listMock).toHaveBeenCalledWith(expect.objectContaining({filter: 'new'})))
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()

        // 清空搜索触发一次无过滤重载：只按全量 nextGroups 剔除真正消失的 a-old
        typeFilter('')
        await waitFor(() => expect(screen.getByText('已选 2 个批次')).toBeTruthy())

        // 侧栏仍停在会话A（b-mid 当前不可见），但它没有被误剔
        clickEl('task-history-dialog-all-conversations-tab-button')
        await screen.findByText('批次-b-mid')
        expect(rowCheckbox('批次-b-mid').checked).toBe(true)
        expect(rowCheckbox('批次-a-new').checked).toBe(true)
        expect(screen.queryByText('批次-a-old')).toBeNull()

        await deleteSelected()
        expect(removeMock).toHaveBeenCalledWith(expect.arrayContaining(['a-new', 'b-mid']))
        expect(removeMock.mock.calls[0][0]).not.toContain('a-old')
    })

    it('批次被外部删除 + 无过滤重载：确认文案的任务数不含幽灵批次', async () => {
        renderDialog()
        await waitReady()

        clickEl('task-history-dialog-select-all-button')
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()

        // 外部删除 a-old：数据源真值变为 2 个批次 / 8 个任务
        dbGroups = [
            {
                conversationId: 'conv-a', conversationTitle: '会话A',
                batches: [mkBatch('a-new', NOW - 3600_000, {total: 3, done: 3})],
            },
            {
                conversationId: 'conv-b', conversationTitle: '会话B',
                batches: [mkBatch('b-mid', NOW - 10 * DAY, {total: 5, done: 5})],
            },
        ]

        // 先走一次搜索过滤（不做剔除），再清空搜索词 → 触发一次无过滤权威重载（剔除 + map 权威化）
        typeFilter('new')
        await waitFor(() => expect(listMock).toHaveBeenCalledWith(expect.objectContaining({filter: 'new'})))
        typeFilter('')
        await waitFor(() => expect(screen.getByText('已选 2 个批次')).toBeTruthy())

        fireEvent.click(screen.getByText(/删除选中/))
        await waitFor(() =>
            expect(document.querySelector('[data-name="confirm-dialog-confirm-button"]')).toBeTruthy())

        const text = confirmDialogText()
        expect(text).toContain('确定要删除选中的 2 个批次吗？')
        // 本条锁的是【端到端要求】（已删批次不得进文案计数），能挡住「无过滤重载不再剔除 +
        // 累积式 map」这类回归；但注意它无法区分「权威分支重建 vs 合并」——剔除判据与重建
        // 集合同源（同一次 loadResponse 的 nextGroups），两者对文案输出不可区分，见报告说明。
        expect(text).toContain('共包含 8 个任务的明细记录')

        clickEl('confirm-dialog-button')
        await waitFor(() => expect(document.querySelector('[data-name="confirm-dialog-div"]')).toBeNull())

        await deleteSelected()
        expect(removeMock.mock.calls[0][0]).toEqual(expect.arrayContaining(['a-new', 'b-mid']))
        expect(removeMock.mock.calls[0][0]).not.toContain('a-old')
    })

    it('删除确认文案的任务数 = 全量选中批次的任务数（含当前不可见）', async () => {
        renderDialog()
        await waitReady()

        clickEl('task-history-dialog-select-all-button')      // 3 个批次：2 + 3 + 5 = 10 个任务
        typeFilter('new')                                     // 可见只剩 a-new，但选中的仍是 3 个批次
        await waitFor(() => expect(screen.queryByText('批次-b-mid')).toBeNull())
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()

        // 路径 1：搜索命中错开 —— 未命中的已选批次连 groups 都不在
        fireEvent.click(screen.getByText(/删除选中/))
        await waitFor(() =>
            expect(document.querySelector('[data-name="confirm-dialog-confirm-button"]')).toBeTruthy())

        const text = confirmDialogText()
        expect(text).toContain('确定要删除选中的 3 个批次吗？')
        // 若按可见集合统计会低报成 3（只有 a-new 一批）
        expect(text).toContain('共包含 10 个任务的明细记录')

        clickEl('confirm-dialog-button')                       // 取消，保留选中集
        await waitFor(() => expect(document.querySelector('[data-name="confirm-dialog-div"]')).toBeNull())

        // 路径 2：侧栏筛选 —— 已选批次仍在 groups 里，只是被侧栏滤掉
        typeFilter('')
        await screen.findByText('批次-b-mid')
        clickEl('task-history-dialog-group-0')                 // 侧栏：会话A
        await waitFor(() => expect(screen.queryByText('批次-b-mid')).toBeNull())
        expect(screen.getByText('已选 3 个批次')).toBeTruthy()

        fireEvent.click(screen.getByText(/删除选中/))
        await waitFor(() =>
            expect(document.querySelector('[data-name="confirm-dialog-confirm-button"]')).toBeTruthy())

        const text2 = confirmDialogText()
        expect(text2).toContain('确定要删除选中的 3 个批次吗？')
        // 若按 visibleGroups 统计会低报成 5（会话A 的 a-old + a-new = 2 + 3）
        expect(text2).toContain('共包含 10 个任务的明细记录')

        fireEvent.click(document.querySelector('[data-name="confirm-dialog-confirm-button"]') as HTMLElement)
        await waitFor(() => expect(removeMock).toHaveBeenCalled())
        expect(removeMock.mock.calls[0][0]).toEqual(expect.arrayContaining(['a-old', 'a-new', 'b-mid']))
    })

    it('时间预设下拉：选中项回显在控件上；非预设操作清回占位', async () => {
        renderDialog()
        await waitReady()

        // 初始停在占位项
        expect(presetLabel()).toBe('按时间选择…')

        pickPreset('30天前')
        expect(screen.getByText('已选 1 个批次')).toBeTruthy()   // a-old（40 天前）
        expect(rowCheckbox('批次-a-old').checked).toBe(true)
        expect(rowCheckbox('批次-a-new').checked).toBe(false)

        // 控件必须回显当前生效的预设（原缺陷：选完弹回占位，用户看不出选了什么）
        expect(presetLabel()).toBe('30天前')

        // 非预设途径改选中集 → 预设不再成立，标签清回占位（否则标签与选中集不符）
        fireEvent.click(rowCheckbox('批次-a-new'))
        expect(presetLabel()).toBe('按时间选择…')

        clickEl('task-history-dialog-clear-selection-button')
        await waitFor(() => expect(screen.queryByText(/已选 /)).toBeNull())

        // 清空后再次选同一预设，仍然生效
        pickPreset('30天前')
        expect(screen.getByText('已选 1 个批次')).toBeTruthy()
        expect(rowCheckbox('批次-a-old').checked).toBe(true)
        expect(presetLabel()).toBe('30天前')
    })
})
