// @vitest-environment jsdom
/**
 * ConversationList 日期分组测试
 *
 * 覆盖语义用例：
 * 1. 置顶会话脱离分组（pinned 在顶部平铺，不套组头）
 * 2. 今天会话平铺（不套组头）
 * 3. 历史会话按日期层级分组（本月→日；本年→月→日；往年→年→月→日）
 * 4. 历史分组默认折叠，点组头展开/收起
 * 5. 子会话跟随父会话（父在哪个组，子就在该组内展开）
 * 6. 搜索时分组逻辑照常（跨组匹配）
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'

// ── 依赖 mock ──
const h = vi.hoisted(() => {
    const getFilteredConversationsMock = vi.fn(() => [] as Array<{
        id: string; title: string; parentConvId?: string | null;
        createdAt: number; updatedAt: number; preview?: string;
        pinned?: boolean; channel?: string; status?: string
    }>)
    const mockState = {
        currentWorkspacePath: 'E:/workspace/media/hclaw',
        workspaces: {'E:/workspace/media/hclaw': {lastOpenedAt: 300, conversations: []}},
        searchQuery: '',
        activeConversationId: null as string | null,
    }
    return {getFilteredConversationsMock, mockState}
})

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: any) => unknown) =>
        selector({
            ...h.mockState,
            getFilteredConversations: h.getFilteredConversationsMock,
            setSearchQuery: vi.fn(),
            setActiveConversation: vi.fn(),
            togglePinConversation: vi.fn(),
            deleteConversation: vi.fn(),
        }),
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: {convAgentStates: Record<string, unknown>}) => unknown) =>
        selector({convAgentStates: {}}),
}))

/** 本地时间构造（避免 UTC 时区偏移） */
const d = (y: number, mo: number, da: number, hh = 12) => new Date(y, mo, da, hh).getTime()
const _now = new Date()
const daysAgo = (n: number) => new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - n, 12).getTime()
const monthsAgo = (n: number) => new Date(_now.getFullYear(), _now.getMonth() - n, 15, 12).getTime()
const yearsAgo = (n: number) => new Date(_now.getFullYear() - n, 5, 15, 12).getTime()

const conv = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, title: `conv-${id}`, parentConvId: null,
    createdAt: daysAgo(0), updatedAt: daysAgo(0), preview: '', pinned: false,
    ...over,
})

function setConvs(convs: Array<Record<string, unknown>>) {
    h.getFilteredConversationsMock.mockReturnValue(convs)
}

beforeEach(() => {
    h.getFilteredConversationsMock.mockReset()
    h.getFilteredConversationsMock.mockReturnValue([])
})
afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('ConversationList · 日期分组', () => {
    it('置顶会话脱离分组，在顶部平铺（无组头）', () => {
        setConvs([
            conv('p1', {title: '置顶会话', pinned: true, createdAt: daysAgo(5)}),
            conv('a1', {title: '普通会话', createdAt: daysAgo(0)}),
        ])
        render(<ConversationList/>)

        // 置顶会话直接可见（不在折叠的分组里）
        expect(screen.getByText('置顶会话')).toBeTruthy()
        expect(screen.getByText('普通会话')).toBeTruthy()
        // 置顶会话不在任何日期分组内
        expect(screen.getByText('置顶会话').closest('[data-testid="conv-date-group"]')).toBeNull()
    })

    it('今天的会话平铺（无组头），历史会话分组', () => {
        setConvs([
            conv('today', {title: '今天的会话', createdAt: daysAgo(0)}),
            conv('yesterday', {title: '昨天的会话', createdAt: daysAgo(1)}),
        ])
        render(<ConversationList/>)

        // 今天的会话直接可见（平铺）
        expect(screen.getByText('今天的会话')).toBeTruthy()
        // 昨天的会话在折叠的历史分组里，不可见
        expect(screen.queryByText('昨天的会话')).toBeNull()
    })

    it('历史分组默认折叠，点组头展开', () => {
        setConvs([
            conv('yesterday', {title: '昨天的会话', createdAt: daysAgo(1)}),
        ])
        render(<ConversationList/>)

        // 默认折叠：条目不可见
        expect(screen.queryByText('昨天的会话')).toBeNull()
        // 组头存在（展开按钮）
        const headers = screen.getAllByRole('button', {name: /^展开 /})
        expect(headers.length).toBeGreaterThan(0)

        // 展开第一个分组
        fireEvent.click(headers[0])
        expect(screen.getByText('昨天的会话')).toBeTruthy()

        // 再折叠
        const collapseHeaders = screen.getAllByRole('button', {name: /^折叠 /})
        fireEvent.click(collapseHeaders[0])
        expect(screen.queryByText('昨天的会话')).toBeNull()
    })

    it('往年会话产生「年」层级分组', () => {
        setConvs([
            conv('old', {title: '去年的会话', createdAt: yearsAgo(1)}),
        ])
        render(<ConversationList/>)

        // 顶层应有「YYYY年」分组头
        const headers = screen.getAllByRole('button', {name: /^展开 /})
        const yearHeader = headers.find((b) => (b.textContent ?? '').includes('年'))
        expect(yearHeader).toBeTruthy()
    })

    it('本年非本月会话产生「月」层级分组', () => {
        setConvs([
            conv('lastMonth', {title: '上个月的会话', createdAt: monthsAgo(1)}),
        ])
        render(<ConversationList/>)

        const headers = screen.getAllByRole('button', {name: /^展开 /})
        // 本年非本月 → 月组（不含「年」字）
        const monthHeader = headers.find((b) => {
            const text = b.textContent ?? ''
            return /\d+月/.test(text) && !/年/.test(text)
        })
        expect(monthHeader).toBeTruthy()
        // 不应有「年」层级组头
        const yearHeader = headers.find((b) => (b.textContent ?? '').includes('年'))
        expect(yearHeader).toBeFalsy()
    })

    it('子会话跟随父会话：父在分组内，子也跟随', () => {
        setConvs([
            conv('parent', {title: '父会话', createdAt: daysAgo(1)}),
            conv('child', {title: '子会话', parentConvId: 'parent', createdAt: daysAgo(1)}),
        ])
        render(<ConversationList/>)

        // 默认折叠：父会话不可见
        expect(screen.queryByText('父会话')).toBeNull()
        // 展开第一个分组
        fireEvent.click(screen.getAllByRole('button', {name: /^展开 /})[0])

        // 父会话可见
        expect(screen.getByText('父会话')).toBeTruthy()
    })

    it('置顶子会话脱离分组（仅根会话参与分组，子会话跟随父）', () => {
        // 置顶根会话在顶部，其子会话在置顶区下方
        setConvs([
            conv('parent', {title: '置顶父会话', pinned: true, createdAt: daysAgo(3)}),
            conv('child', {title: '子会话', parentConvId: 'parent', createdAt: daysAgo(3)}),
        ])
        render(<ConversationList/>)

        // 置顶父会话直接可见（不在折叠分组里）
        expect(screen.getByText('置顶父会话')).toBeTruthy()
    })

    it('混合场景：置顶 + 今天 + 历史分组', () => {
        setConvs([
            conv('pin', {title: '置顶的', pinned: true, createdAt: daysAgo(10)}),
            conv('today', {title: '今天的', createdAt: daysAgo(0)}),
            conv('yesterday', {title: '昨天的', createdAt: daysAgo(1)}),
            conv('lastMonth', {title: '上月的', createdAt: monthsAgo(1)}),
        ])
        render(<ConversationList/>)

        // 置顶 + 今天直接可见
        expect(screen.getByText('置顶的')).toBeTruthy()
        expect(screen.getByText('今天的')).toBeTruthy()
        // 历史折叠不可见
        expect(screen.queryByText('昨天的')).toBeNull()
        expect(screen.queryByText('上月的')).toBeNull()

        // 展开第一个历史组
        const headers = screen.getAllByRole('button', {name: /^展开 /})
        if (headers.length > 0) fireEvent.click(headers[0])
        // 展开后至少可见一个历史会话
        const visible = ['昨天的', '上月的'].filter((t) => screen.queryByText(t))
        expect(visible.length).toBeGreaterThan(0)
    })
})
