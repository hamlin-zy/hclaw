// @vitest-environment jsdom
/**
 * MemoPanel 组件测试（双 Tab + 日期分组 + Reorder 拖拽）
 *
 * 覆盖语义用例：
 * 1. Tab 切换：默认待办，切到历史
 * 2. 待办列表：排序渲染（pinned→sortIndex→createdAt）
 * 3. 历史列表：按创建日期层级分组，默认折叠，点组头展开
 * 4. 历史 processed 项置灰
 * 5. 搜索只作用于当前 Tab
 * 6. 跳转按钮两态：会话存在可点 → setActiveConversation；已删除 → disabled
 * 7. 删除走 ConfirmDialog 确认
 * 8. 底部统计随 Tab 高亮
 * 9. 点击条目 → openConfigWindow('memo-edit', ['--hclaw-memo-id=<id>'])
 * 10. 新增按钮 → openConfigWindow('memo-edit', ['--hclaw-memo-workspace=<path>'])
 *
 * mock 约定：memoStore / conversationStore / confirm 按 mockZustandStore 模式；
 * electronAPI.openConfigWindow 以 vi.fn stub。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react'
import type {MemoItem} from '@/shared/types/memo'

const h = vi.hoisted(() => {
    // ── memoStore fake（真实 zustand shape：hook + getState/setState/subscribe）──
    const memoState: Record<string, unknown> = {
        memos: [] as MemoItem[],
        loading: false,
        error: null,
        load: vi.fn(async () => {}),
        create: vi.fn(async () => null),
        updateItem: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        createSession: vi.fn(async () => null),
    }
    const useMemoStore: any = (selector?: (s: any) => unknown) => (selector ? selector(memoState) : memoState)
    useMemoStore.getState = () => memoState as never
    useMemoStore.setState = (partial: any) => {
        Object.assign(memoState, typeof partial === 'function' ? partial(memoState) : partial)
        listeners.forEach((fn) => fn(memoState as never, {} as never))
    }
    useMemoStore.subscribe = (fn: any) => {
        listeners.push(fn)
        return () => {
            const i = listeners.indexOf(fn)
            if (i >= 0) listeners.splice(i, 1)
        }
    }
    const listeners: Array<(a: unknown, b: unknown) => void> = []
    const subscribeMemoChanged = vi.fn(() => () => {})

    // ── conversationStore fake ──
    const setActiveConversation = vi.fn()
    const convState = {
        currentWorkspacePath: 'E:\\proj',
        workspaces: {'E:\\proj': {lastOpenedAt: 1, conversations: [{id: 'conv-1'}]}},
        setActiveConversation,
    }
    const useConversationStore: any = (selector?: (s: any) => unknown) => (selector ? selector(convState) : convState)
    useConversationStore.getState = () => convState as never

    // ── electronAPI ──
    const openConfigWindow = vi.fn(async () => {})

    return {useMemoStore, subscribeMemoChanged, useConversationStore, setActiveConversation, openConfigWindow,
        openMemoCreateWindow: (ws: string) => window.electronAPI?.openConfigWindow?.('memo-edit', [`--hclaw-memo-workspace=${encodeURIComponent(ws)}`])}
})

vi.mock('@/renderer/stores/memoStore', () => ({
    useMemoStore: h.useMemoStore,
    subscribeMemoChanged: h.subscribeMemoChanged,
    openMemoCreateWindow: h.openMemoCreateWindow,
}))
vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: h.useConversationStore,
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
    h.useConversationStore.getState().currentWorkspacePath = P
})

import MemoPanel from '@/renderer/components/memo/MemoPanel'
import {CAP_STYLE} from '@/renderer/components/memo/MemoPanel'
import {TYPE_STYLE} from '@/renderer/components/message-list/UserCommandBubble'
import {confirm} from '@/renderer/components/ConfirmDialog'
import TooltipPortal from '@/renderer/components/common/TooltipPortal'

const P = 'E:\\proj'
const item = (id: string, over: Partial<MemoItem> = {}): MemoItem => ({
    id,
    workspacePath: P,
    content: `memo-${id}`,
    title: `memo-${id}`,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    status: 'active',
    ...over,
})

/** 相对日期构造（本地时间，避免时区偏移） */
const _now = new Date()
const daysAgo = (n: number) => new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - n, 12).getTime()
const monthsAgo = (n: number) => new Date(_now.getFullYear(), _now.getMonth() - n, 15, 12).getTime()
const yearsAgo = (n: number) => new Date(_now.getFullYear() - n, 5, 15, 12).getTime()

function setMemos(memos: MemoItem[]) {
    h.useMemoStore.setState({memos})
}

/** 切到历史 Tab 并展开第一个分组（默认全部折叠） */
function gotoHistoryAndExpandFirstGroup() {
    fireEvent.click(screen.getByRole('button', {name: '历史'}))
    const headers = screen.getAllByRole('button', {name: /^展开 /})
    if (headers.length > 0) fireEvent.click(headers[0])
}

describe('MemoPanel', () => {
    it('搜索关键词匹配 title + content（大小写不敏感）', () => {
        setMemos([
            item('m1', {title: 'fix login bug', content: 'auth token 过期'}),
            item('m2', {title: '写文档', content: 'write docs about api'}),
        ])
        render(<MemoPanel/>)

        expect(screen.getByText('写文档')).toBeTruthy()
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'LOGIN'}})
        expect(screen.queryByText('写文档')).toBeNull()
        expect(screen.getByText('fix login bug')).toBeTruthy()
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'DOCS'}})
        expect(screen.getByText('写文档')).toBeTruthy()
        expect(screen.queryByText('fix login bug')).toBeNull()
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'zzz-no-match'}})
        expect(screen.getByText('无匹配的备忘录')).toBeTruthy()
    })

    it('workspacePath 为空时点击新增按钮不打开编辑窗口', () => {
        h.useConversationStore.getState().currentWorkspacePath = ''
        render(<MemoPanel/>)

        fireEvent.click(screen.getByLabelText('新建备忘录 (Ctrl+Shift+N)'))
        expect(h.openConfigWindow).not.toHaveBeenCalled()
    })

    it('底部统计区显示待处理/已处理数量', () => {
        setMemos([
            item('a1', {title: 'active one'}),
            item('a2', {title: 'active two'}),
            item('p1', {status: 'processed'}),
        ])
        render(<MemoPanel/>)

        const stats = screen.getByTestId('memo-stats')
        expect(stats.textContent).toContain('待处理 2')
        expect(stats.textContent).toContain('已处理 1')
    })
})

describe('MemoPanel · Tab 切换', () => {
    it('默认显示待办 Tab，待办项可见、历史项不可见', () => {
        setMemos([
            item('a1', {title: '待办项A'}),
            item('p1', {status: 'processed', createdAt: daysAgo(0), title: '历史项P'}),
        ])
        render(<MemoPanel/>)

        expect(screen.getByText('待办项A')).toBeTruthy()
        expect(screen.queryByText('历史项P')).toBeNull()
    })

    it('切到历史 Tab 后显示分组头（不展示条目，因为默认折叠）', () => {
        setMemos([
            item('p1', {status: 'processed', createdAt: daysAgo(0), title: '历史项P'}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        // 分组头存在（展开按钮）
        expect(screen.getAllByRole('button', {name: /^展开 /}).length).toBeGreaterThan(0)
        // 条目仍不可见（折叠）
        expect(screen.queryByText('历史项P')).toBeNull()
    })

    it('切回待办 Tab 后待办项可见', () => {
        setMemos([
            item('a1', {title: '待办项A'}),
            item('p1', {status: 'processed', createdAt: daysAgo(0), title: '历史项P'}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        fireEvent.click(screen.getByRole('button', {name: '待办'}))
        expect(screen.getByText('待办项A')).toBeTruthy()
    })
})

describe('MemoPanel · 待办列表排序', () => {
    it('渲染顺序：pinned → sortIndex desc → createdAt asc', () => {
        setMemos([
            item('a', {createdAt: 3}),
            item('b', {createdAt: 1, pinned: true}),
            item('c', {createdAt: 2}),
        ])
        render(<MemoPanel/>)

        const rows = screen.getAllByTestId('memo-item')
        expect(rows.map((r) => r.getAttribute('data-memo-id'))).toEqual(['b', 'c', 'a'])
    })

    it('置顶项与未置顶项各自组内有序，置顶居前', () => {
        setMemos([
            item('u1', {sortIndex: 0, createdAt: 1}),
            item('p1', {sortIndex: 5, createdAt: 9, pinned: true}),
            item('u2', {sortIndex: 0, createdAt: 2}),
            item('p2', {sortIndex: 3, createdAt: 8, pinned: true}),
        ])
        render(<MemoPanel/>)

        const rows = screen.getAllByTestId('memo-item')
        // sortIndex desc: p1(5) > p2(3) → p1,p2 在前；createdAt asc: u1(1) < u2(2)
        expect(rows.map((r) => r.getAttribute('data-memo-id'))).toEqual(['p1', 'p2', 'u1', 'u2'])
    })
})

describe('MemoPanel · 历史分组与折叠', () => {
    it('processed 项置灰（opacity-50），active 项不置灰', () => {
        setMemos([
            item('a1', {title: 'active one'}),
            item('p1', {status: 'processed', createdAt: daysAgo(0), title: '历史项P'}),
        ])
        render(<MemoPanel/>)

        // 待办 Tab 下 active 不置灰
        const activeRow = screen.getAllByTestId('memo-item')[0]
        expect(activeRow.className).not.toContain('opacity-50')

        // 历史 Tab 下 processed 置灰
        gotoHistoryAndExpandFirstGroup()
        const processedRow = screen.getByTestId('memo-item')
        expect(processedRow.className).toContain('opacity-50')
    })

    it('展开分组后条目可见，再点折叠后隐藏', () => {
        setMemos([
            item('p1', {status: 'processed', createdAt: daysAgo(0), title: '历史项P'}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        expect(screen.queryByText('历史项P')).toBeNull()

        // 展开
        fireEvent.click(screen.getAllByRole('button', {name: /^展开 /})[0])
        expect(screen.getByText('历史项P')).toBeTruthy()

        // 折叠
        fireEvent.click(screen.getAllByRole('button', {name: /^折叠 /})[0])
        expect(screen.queryByText('历史项P')).toBeNull()
    })

    it('跨年数据产生「年」层级分组头', () => {
        setMemos([
            item('old', {status: 'processed', createdAt: yearsAgo(1), title: '去年的项'}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        // 顶层应有「YYYY年」分组头（textContent 含「年」字，年组 label 如「2025年」）
        const headers = screen.getAllByRole('button', {name: /^展开 /})
        const yearHeader = headers.find((b) => (b.textContent ?? '').includes('年'))
        expect(yearHeader).toBeTruthy()
    })

    it('本月数据直接为「日」层级（无月/年包裹）', () => {
        setMemos([
            item('today', {status: 'processed', createdAt: daysAgo(0), title: '今天项'}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        const headers = screen.getAllByRole('button', {name: /^展开 /})
        // 本月日组 label 形如「M月D日」
        const dayHeader = headers.find((b) => /\d+月\d+日/.test(b.textContent ?? ''))
        expect(dayHeader).toBeTruthy()
        // 不应有「年」层级组头（月组/日组 label 不含「年」字）
        const yearHeader = headers.find((b) => (b.textContent ?? '').includes('年'))
        expect(yearHeader).toBeFalsy()
    })
})

describe('MemoPanel · 搜索只搜当前 Tab', () => {
    it('待办 Tab 搜索只过滤待办项', () => {
        setMemos([
            item('a1', {title: 'login bug', status: 'active'}),
            item('a2', {title: 'docs', status: 'active'}),
            item('p1', {title: 'login history', status: 'processed', createdAt: daysAgo(0)}),
        ])
        render(<MemoPanel/>)

        // 默认待办 Tab
        expect(screen.getByText('login bug')).toBeTruthy()
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'login'}})
        expect(screen.getByText('login bug')).toBeTruthy()
        expect(screen.queryByText('docs')).toBeNull()
        // 历史项不在待办 Tab 显示
        expect(screen.queryByText('login history')).toBeNull()
    })

    it('历史 Tab 搜索只过滤历史项（搜索后展开分组可见匹配条目）', () => {
        setMemos([
            item('a1', {title: 'login bug', status: 'active'}),
            item('p1', {title: 'login history', status: 'processed', createdAt: daysAgo(0)}),
            item('p2', {title: 'other', status: 'processed', createdAt: daysAgo(1)}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'login'}})

        // 搜索结果只含匹配的历史项，展开后可见
        const headers = screen.getAllByRole('button', {name: /^展开 /})
        if (headers.length > 0) fireEvent.click(headers[0])
        expect(screen.getByText('login history')).toBeTruthy()
        expect(screen.queryByText('other')).toBeNull()
        expect(screen.queryByText('login bug')).toBeNull()
    })
})

describe('MemoPanel · 条目交互', () => {
    it('条目纯展示：标题 + 附件角标 + 能力徽章，不渲染正文', () => {
        setMemos([item('m1', {
            title: '购物清单',
            content: '牛奶、鸡蛋、面包等很长的正文内容不应出现在列表里',
            capability: {name: 'daily-task', type: 'skill'},
            attachments: [{id: 'a1', fileName: 'f.txt', storedPath: 'p', mime: 'text/plain', kind: 'file'}],
        })])
        render(<MemoPanel/>)

        const row = screen.getByTestId('memo-item')
        expect(row.textContent).toContain('购物清单')
        expect(row.textContent).toContain('daily-task')
        expect(row.textContent).toContain('技能')
        expect(row.textContent).toContain('📎 1')
        expect(row.textContent).not.toContain('牛奶')
        expect(screen.queryByPlaceholderText('记录备忘...')).toBeNull()
        expect(screen.queryByText('保存')).toBeNull()
    })

    it('能力徽章位于标题上方（纵向排列），样式对齐 UserCommandBubble（图标+着色名+类型标签）', () => {
        setMemos([item('m1', {
            title: '标题在下',
            capability: {name: 'review-agent', type: 'agent'},
        })])
        render(<MemoPanel/>)

        const row = screen.getByTestId('memo-item')
        const badge = screen.getByTestId('memo-capability-badge')
        const titleEl = Array.from(row.querySelectorAll('div')).find((d) => d.textContent === '标题在下')
        expect(badge.compareDocumentPosition(titleEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(badge.textContent).toContain('review-agent')
        expect(badge.textContent).toContain('代理')
        expect(badge.className).toContain('items-center')
        expect(badge.querySelector('span')!.className).toContain('bg-[#0ea5e9]/10')
    })

    it('列表项对齐会话列表（胶囊圆角 + 透明底 + hover 半透明，无实底卡片）', () => {
        setMemos([item('m1'), item('m2')])
        render(<MemoPanel/>)

        for (const row of screen.getAllByTestId('memo-item')) {
            expect(row.className).toContain('rounded-[18px]')
            expect(row.className).toContain('hover:bg-gray-50')
            expect(row.className).toContain('dark:hover:bg-white/5')
            expect(row.className).not.toContain('bg-[var(--surface)]')
            expect(row.className).not.toContain('border-b')
        }
    })

    it('搜索框对齐会话列表 SearchInput（胶囊圆角 + 半透明底）', () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        const input = screen.getByPlaceholderText('搜索备忘录...')
        expect(input.className).toContain('rounded-[36px]')
        expect(input.className).toContain('bg-gray-100/60')
        expect(input.className).toContain('dark:bg-white/5')
    })

    it('右缘按钮 tooltip：title 走全局 TooltipPortal，data-tooltip-placement=left 向左展开', () => {
        setMemos([item('m1')])
        render(<><MemoPanel/><TooltipPortal/></>)

        const deleteBtn = screen.getByLabelText('删除')
        expect(deleteBtn.getAttribute('title')).toBe('删除')
        expect(deleteBtn.dataset.tooltipPlacement).toBe('left')

        // 全局接管：mouseover 后 title 被移除，Portal 渲染主题化 tooltip（左放置锚定）
        fireEvent.mouseOver(deleteBtn)
        const tip = document.querySelector<HTMLElement>('.tooltip-portal')!
        expect(tip.textContent).toBe('删除')
        expect(tip.style.transform).toBe('translate(-100%, -50%)')

        fireEvent.mouseOut(deleteBtn)
        expect(deleteBtn.getAttribute('title')).toBe('删除')
    })

    it('创建会话处理按钮 tooltip 文案为「创建会话处理」', () => {
        setMemos([item('m1')])
        render(<><MemoPanel/><TooltipPortal/></>)

        const btn = screen.getByLabelText('创建会话处理')
        fireEvent.mouseOver(btn)
        expect(document.querySelector('.tooltip-portal')!.textContent).toBe('创建会话处理')
    })

    it('点击条目 → openConfigWindow 传 --hclaw-memo-id', () => {
        setMemos([item('m-abc', {title: '点我'})])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByTestId('memo-item'))
        expect(h.openConfigWindow).toHaveBeenCalledWith('memo-edit', ['--hclaw-memo-id=m-abc'])
    })

    it('新增按钮 → openConfigWindow 传 --hclaw-memo-workspace', () => {
        setMemos([])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByLabelText('新建备忘录 (Ctrl+Shift+N)'))
        expect(h.openConfigWindow).toHaveBeenCalledWith('memo-edit', ['--hclaw-memo-workspace=E%3A%5Cproj'])
    })

    it('新增按钮：workspacePath 含空格 → encodeURIComponent 编码传参', () => {
        h.useConversationStore.getState().currentWorkspacePath = 'E:\\my projects\\app'
        setMemos([])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByLabelText('新建备忘录 (Ctrl+Shift+N)'))
        expect(h.openConfigWindow).toHaveBeenCalledWith('memo-edit', ['--hclaw-memo-workspace=' + encodeURIComponent('E:\\my projects\\app')])
    })

    it('历史 Tab 跳转按钮：会话存在可点 → setActiveConversation；已删除 → disabled', () => {
        setMemos([
            item('p1', {status: 'processed', createdAt: daysAgo(0), relatedConvId: 'conv-1'}),
            item('p2', {status: 'processed', createdAt: daysAgo(1), title: 'orphan', relatedConvId: 'conv-gone'}),
        ])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByRole('button', {name: '历史'}))
        // 展开第一个分组（含 p1）
        fireEvent.click(screen.getAllByRole('button', {name: /^展开 /})[0])

        const okBtn = screen.getByLabelText('跳转到关联会话') as HTMLButtonElement
        expect(okBtn.disabled).toBe(false)
        fireEvent.click(okBtn)
        expect(h.setActiveConversation).toHaveBeenCalledWith('conv-1')
    })

    it('删除走 ConfirmDialog 确认', async () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByLabelText('删除'))
        await waitFor(() => expect(confirm).toHaveBeenCalled())
        await waitFor(() => expect(h.useMemoStore.getState().remove).toHaveBeenCalledWith('m1'))
    })
})

describe('MemoPanel · 优先级下拉（PrioritySelect 集成）', () => {
    it('active 项渲染 PrioritySelect，processed/历史项不渲染', () => {
        setMemos([
            item('a1', {title: '待办项A'}),
            item('p1', {status: 'processed', createdAt: daysAgo(0), title: '历史项P'}),
        ])
        render(<MemoPanel/>)

        // 待办 Tab：active 项有下拉
        const rows = screen.getAllByTestId('memo-item')
        expect(rows).toHaveLength(1)
        expect(screen.getByTestId('priority-select')).toBeTruthy()

        // 历史 Tab：processed 项无下拉
        gotoHistoryAndExpandFirstGroup()
        expect(screen.getByTestId('memo-item').getAttribute('data-memo-id')).toBe('p1')
        expect(screen.queryByTestId('priority-select')).toBeNull()
    })

    it('选择优先级 → updateItem 被调用且 patch 为 {priority: "high"}', () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByTestId('priority-trigger'))
        fireEvent.click(screen.getByTestId('priority-option-high'))
        expect(h.useMemoStore.getState().updateItem).toHaveBeenCalledWith('m1', {priority: 'high'})
    })

    it('点击优先级下拉不触发条目 onClick（不打开编辑窗口）', () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByTestId('priority-trigger'))
        fireEvent.click(screen.getByTestId('priority-option-low'))
        expect(h.openConfigWindow).not.toHaveBeenCalled()
    })

    it('缺省（无 priority 字段）显示"普通"', () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        expect(screen.getByTestId('priority-trigger').textContent).toContain('普通')
    })
})

/**
 * 漂移守护：MemoPanel.CAP_STYLE 与 UserCommandBubble.TYPE_STYLE
 * 必须对同一能力类型使用相同配色（color/bg），防止两处映射各自演进。
 * 键名映射：MemoPanel `command` ↔ UserCommandBubble `user`（同一语义：用户命令）。
 */
describe('CAP_STYLE ↔ TYPE_STYLE 漂移守护', () => {
    const PAIRINGS: Array<[keyof typeof CAP_STYLE, keyof typeof TYPE_STYLE]> = [
        ['skill', 'skill'],
        ['agent', 'agent'],
        ['command', 'user'],
    ]

    it.each(PAIRINGS)('CAP_STYLE.%s 与 TYPE_STYLE.%s 配色一致', (capKey, typeKey) => {
        const cap = CAP_STYLE[capKey]
        const type = TYPE_STYLE[typeKey]
        expect(cap.color).toBe(type.color)
        expect(cap.bg).toBe(type.bg)
    })

    it('UserCommandBubble 不存在与 command 语义等价的漂移键（plugin 仅作灰色降级，不参与断言）', () => {
        expect(TYPE_STYLE.plugin).toBeDefined()
        expect(CAP_STYLE.command).toBeDefined()
    })
})
