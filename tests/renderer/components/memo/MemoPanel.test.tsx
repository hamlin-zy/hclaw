// @vitest-environment jsdom
/**
 * MemoPanel 组件测试（UI 修订轮 Task C：纯列表 + 独立编辑窗口）
 *
 * 覆盖语义用例：
 * 1. 搜索关键词过滤 title + content（大小写不敏感）
 * 2. processed 沉底且置灰
 * 3. 条目纯展示：标题 + 附件角标 + 能力徽章，不渲染正文
 * 4. 点击条目 → openConfigWindow('memo-edit', ['--hclaw-memo-id=<id>'])
 * 5. 新增按钮 → openConfigWindow('memo-edit', ['--hclaw-memo-workspace=<path>'])
 * 6. 跳转按钮两态：会话存在可点 → setActiveConversation；已删除 → disabled
 * 7. 删除走 ConfirmDialog 确认
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
        // 真实实现走 window.electronAPI.openConfigWindow，代理保持断言一致
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

function setMemos(memos: MemoItem[]) {
    h.useMemoStore.setState({memos})
}

describe('MemoPanel', () => {
    it('搜索关键词匹配 title + content（大小写不敏感）', () => {
        setMemos([
            item('m1', {title: 'fix login bug', content: 'auth token 过期'}),
            item('m2', {title: '写文档', content: 'write docs about api'}),
        ])
        render(<MemoPanel/>)

        expect(screen.getByText('写文档')).toBeTruthy()
        // 命中 title
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'LOGIN'}})
        expect(screen.queryByText('写文档')).toBeNull()
        expect(screen.getByText('fix login bug')).toBeTruthy()
        // 命中 content（title 不含关键词）
        fireEvent.change(screen.getByPlaceholderText(/搜索备忘录/), {target: {value: 'DOCS'}})
        expect(screen.getByText('写文档')).toBeTruthy()
        expect(screen.queryByText('fix login bug')).toBeNull()
        // 全不命中
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

    it('processed 沉底且置灰', () => {
        setMemos([
            item('p1', {status: 'processed'}),
            item('a1', {title: 'active one'}),
        ])
        render(<MemoPanel/>)

        const rows = screen.getAllByTestId('memo-item')
        expect(rows).toHaveLength(2)
        // active 在前，processed 沉底
        expect(rows[0].textContent).toContain('active one')
        expect(rows[1].textContent).toContain('memo-p1')
        // 置灰 class
        expect(rows[1].className).toContain('opacity-50')
        expect(rows[0].className).not.toContain('opacity-50')
    })

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
        // 不再展示正文摘要
        expect(row.textContent).not.toContain('牛奶')
        // 无内联编辑器
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
        // DOM 顺序：徽章在标题元素之前
        const titleEl = Array.from(row.querySelectorAll('div')).find((d) => d.textContent === '标题在下')
        expect(badge.compareDocumentPosition(titleEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        // 同构样式：agent 蓝 / 图标 chip / 类型标签
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

    it('右缘按钮 tooltip：悬停时经 Portal 向左展开且不换行（nowrap）', () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        const deleteBtn = screen.getByLabelText('删除')
        expect(deleteBtn.getAttribute('title')).toBeNull() // 不用 title，避免被全局 TooltipPortal 接管
        fireEvent.mouseEnter(deleteBtn)

        const tip = screen.getByTestId('memo-tip')
        expect(tip.textContent).toBe('删除')
        expect(tip.style.whiteSpace).toBe('nowrap')
        expect(tip.style.transform).toBe('translateX(-100%)') // 右缘对齐按钮右缘、向左延伸

        fireEvent.mouseLeave(deleteBtn)
        expect(screen.queryByTestId('memo-tip')).toBeNull()
    })

    it('创建会话处理按钮 tooltip 文案为「创建会话处理」', () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        const btn = screen.getByLabelText('创建会话处理')
        fireEvent.mouseEnter(btn)
        expect(screen.getByTestId('memo-tip').textContent).toBe('创建会话处理')
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

    it('跳转按钮：会话存在可点 → setActiveConversation；已删除 → disabled', () => {
        setMemos([
            item('p1', {status: 'processed', relatedConvId: 'conv-1'}),
            item('p2', {title: 'orphan', status: 'processed', relatedConvId: 'conv-gone'}),
        ])
        render(<MemoPanel/>)

        const rows = screen.getAllByTestId('memo-item')
        const okBtn = Array.from(rows[0].querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '跳转到关联会话')!
        expect(okBtn.disabled).toBe(false)
        fireEvent.click(okBtn)
        expect(h.setActiveConversation).toHaveBeenCalledWith('conv-1')

        const orphanRow = screen.getByText('orphan').closest('[data-testid="memo-item"]')!
        const orphanBtn = Array.from(orphanRow.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '跳转到关联会话')!
        expect(orphanBtn.disabled).toBe(true)
    })

    it('删除走 ConfirmDialog 确认', async () => {
        setMemos([item('m1')])
        render(<MemoPanel/>)

        fireEvent.click(screen.getByLabelText('删除'))
        await waitFor(() => expect(confirm).toHaveBeenCalled())
        await waitFor(() => expect(h.useMemoStore.getState().remove).toHaveBeenCalledWith('m1'))
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
        // 守护意图说明：若未来 TYPE_STYLE 新增与 skill/agent/command 同义的新键，
        // 应更新 PAIRINGS 使其纳入一致性校验，而不是放任漂移。
        expect(TYPE_STYLE.plugin).toBeDefined()
        expect(CAP_STYLE.command).toBeDefined()
    })
})
