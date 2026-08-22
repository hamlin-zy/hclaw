// @vitest-environment jsdom
/**
 * MessageList 查找功能回归测试
 *
 * 覆盖的 bug（systematic-debugging 修复记录）：
 * 1. buildHighlights 用 `.message-content` 选择器（真实 DOM 无此类）→ 高亮/计数恒为空
 * 2. 没有 ::highlight CSS 规则（JS 侧无法断言，此测试只锁 JS 侧：Range 确实创建并注册）
 * 3. msgIdx（可见行序号）与 data-msg-idx（原始索引，可跳号）不一致 → 定位滚动失败
 * 4. firstChild 假设文本节点（Markdown 渲染后是 <p> 等元素）→ TreeWalker 遍历文本节点
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, waitFor, fireEvent} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

// ── 依赖 mock：静态 store（selector 每次返回同一引用） ──
const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        loadedMessages: [] as any[],
        activeConversationId: null as string | null,
        hasMoreMap: {} as Record<string, boolean>,
        loadingMoreMap: {} as Record<string, boolean>,
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        streamingMessageId: null as string | null,
        agentState: {status: 'idle', phase: 'idle', mode: 'auto'} as {status: string; phase: string; mode: string},
        errorMessage: null as string | null,
        isThinkingAfterTools: false,
        messageDisplayMode: undefined as string | undefined,
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) =>
        selector(mockAgentState),
}))

// ── Highlight API 打桩（jsdom 未实现） ──
class MockHighlight {
    ranges = new Set<Range>()
    add(r: Range) { this.ranges.add(r) }
    delete(r: Range) { this.ranges.delete(r) }
    clear() { this.ranges.clear() }
}

let highlightsMap: Map<string, MockHighlight>
// 可捕获的 MutationObserver 回调列表（jsdom 不触发真实 observer，测试手动调用来模拟 DOM 变化）
let mutationCallbacks: Array<{cb: MutationCallback; inst: unknown}>

beforeEach(() => {
    // 重置 store 状态
    mockConversationState.messagesMap = {}
    mockConversationState.loadedMessages = []
    mockConversationState.activeConversationId = null
    mockConversationState.hasMoreMap = {}
    mockConversationState.loadingMoreMap = {}
    mockAgentState.convAgentStates = {}
    mockAgentState.errorMessage = null
    mockAgentState.messageDisplayMode = undefined
    mutationCallbacks = []

    vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
        root = null
        rootMargin = ''
        thresholds = []
        takeRecords(): IntersectionObserverEntry[] { return [] }
    })
    vi.stubGlobal('MutationObserver', class {
        cb: MutationCallback
        constructor(cb: MutationCallback) {
            this.cb = cb
            mutationCallbacks.push({cb, inst: this})
        }
        observe() {}
        disconnect() {}
        takeRecords(): MutationRecord[] { return [] }
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0)
        return 0
    })
    // scrollIntoView / scrollTo 在 jsdom 未实现
    const scrollIntoViewMock = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoViewMock as any
    Element.prototype.scrollTo = vi.fn() as any

    // Range.prototype.getBoundingClientRect jsdom 未实现（scrollToMatch 精确校正用），
    // 默认全 0 → 走"无布局重试"分支，不抛异常
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
        top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
        toJSON: () => ({}),
    }) as DOMRect)

    // Highlight API：Highlight 构造器 + CSS.highlights registry
    vi.stubGlobal('Highlight', MockHighlight)
    highlightsMap = new Map<string, MockHighlight>()
    Object.defineProperty(window.CSS, 'highlights', {
        value: highlightsMap,
        configurable: true,
        writable: true,
    })
})

/** 触发 Ctrl+F 打开查找面板并输入关键词 */
async function openFindAndSearch(query: string) {
    fireEvent.keyDown(document, {key: 'f', ctrlKey: true})
    const input = await waitFor(() => {
        const el = document.querySelector('.find-input') as HTMLInputElement
        expect(el).toBeTruthy()
        return el
    })
    fireEvent.change(input, {target: {value: query}})
}

function getFindPanelText(): string {
    return document.querySelector('[role="search"]')?.textContent ?? ''
}

describe('MessageList 查找功能（CSS Highlight API 回归）', () => {
    it('Markdown 嵌套正文中能构建高亮：计数显示 + Range 注册 + 首匹配定位到正确行', async () => {
        // 含 role=context（渲染层过滤）→ data-msg-idx 跳号为 1,2,3（复现“按 msgIdx 查询失败”场景）
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'ctx', role: 'context', content: ''},
            {id: 'm1', role: 'user', content: '你好，今天天气很好'},
            {id: 'm2', role: 'assistant', content: '是的，**今天**适合出门散步 hello world'},
            {id: 'm3', role: 'assistant', content: 'hello again from assistant'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)

        await openFindAndSearch('hello')

        // 等防抖 150ms 后构建完成：match-highlight 注册了 2 个 Range（m2、m3 各一处）
        await waitFor(() => {
            const matchHl = highlightsMap.get('find-match')
            expect(matchHl).toBeTruthy()
            expect(matchHl!.ranges.size).toBe(2)
        })

        // 当前匹配高亮：恰 1 个 Range
        expect(highlightsMap.get('find-current')?.ranges.size).toBe(1)

        // 命中计数显示「1 / 2」
        expect(getFindPanelText()).toContain('1 / 2')

        // 首匹配定位：scrollIntoView 作用于 m2 行（data-msg-idx="2"），
        // 而非旧实现查询 data-msg-idx="0"（跳号下必然 null）导致的不滚动
        // 注：组件初始化也有 scrollIntoView 调用，取搜索之后（最后一次）的调用
        const sv = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
        expect(sv).toHaveBeenCalled()
        const firstTarget = sv.mock.instances[sv.mock.calls.length - 1]
        expect(firstTarget?.getAttribute?.('data-msg-idx')).toBe('2')
    })

    it('同一行多个命中：总数 = 真实命中数，导航逐命中跳转（含同行内）', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm1', role: 'user', content: 'hello hello world'},   // 同一行 2 个命中
            {id: 'm2', role: 'assistant', content: 'hello again'},    // 1 个命中
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)

        await openFindAndSearch('hello')

        // 总数应为 3（2 个在同一行的 m1）+ 1（m2），而不是按行聚合的 2
        await waitFor(() => {
            expect(getFindPanelText()).toContain('1 / 3')
        })
        expect(highlightsMap.get('find-match')?.ranges.size).toBe(3)

        // 下一条：同行内第 2 个命中（仍在 m1 行）
        const nextBtn = document.querySelector('[aria-label="下一条"]') as HTMLButtonElement
        fireEvent.click(nextBtn)
        await waitFor(() => {
            expect(getFindPanelText()).toContain('2 / 3')
        })

        // 再下一条：跳到 m2 行
        fireEvent.click(nextBtn)
        await waitFor(() => {
            expect(getFindPanelText()).toContain('3 / 3')
        })
        const sv = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
        const target = sv.mock.instances[sv.mock.calls.length - 1]
        expect(target?.getAttribute?.('data-msg-idx')).toBe('1')
    })

    it('下一条导航精准定位：计数推进到 2 / 2 且滚动到 m3 行', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm1', role: 'user', content: '你好，今天天气很好'},
            {id: 'm2', role: 'assistant', content: '是的，今天适合出门散步 hello world'},
            {id: 'm3', role: 'assistant', content: 'hello again from assistant'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)

        await openFindAndSearch('hello')
        await waitFor(() => {
            expect(getFindPanelText()).toContain('1 / 2')
        })

        // 点击「下一条」
        const nextBtn = document.querySelector('[aria-label="下一条"]') as HTMLButtonElement
        expect(nextBtn).toBeTruthy()
        fireEvent.click(nextBtn)

        await waitFor(() => {
            expect(getFindPanelText()).toContain('2 / 2')
        })
        // 当前匹配高亮随之切换
        expect(highlightsMap.get('find-current')?.ranges.size).toBe(1)

        // 滚动目标应为 m3 行（数据序号 2，行序号 2）——按行序号（NodeList 索引）定位
        const sv = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
        const lastCall = sv.mock.calls.length - 1
        const target = sv.mock.instances[lastCall] ?? sv.mock.calls[lastCall][0]
        expect(target?.getAttribute?.('data-msg-idx')).toBe('2')
    })

    it('清空关键词后高亮与计数清除', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm1', role: 'user', content: 'hello world'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)

        await openFindAndSearch('hello')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(1)
        })

        // 清空输入
        const input = document.querySelector('.find-input') as HTMLInputElement
        fireEvent.change(input, {target: {value: ''}})

        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(0)
            expect(getFindPanelText()).not.toContain('/')
        })
    })

    it('搜索范围仅限正文：header（HClaw）/时间戳/代码块复制按钮等 UI 元信息不计入命中', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm1', role: 'assistant', content: 'hello world\n\n```js\nconst x = 1\n```', timestamp: 1710000000000},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)

        // header「HClaw」（所有助手消息均有）→ 0 命中（不显示计数）
        await openFindAndSearch('HClaw')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
            expect(getFindPanelText()).not.toContain('/')
        })

        // 时间戳文本（MessageBubble 渲染格式）→ 0 命中
        const ts = new Date(1710000000000).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})
        await openFindAndSearch(ts)
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })

        // 代码块复制按钮文本（"复制"，位于正文 scope 内）→ data-find-exclude 跳过
        await openFindAndSearch('复制')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })

        // 正文命中 2 处（hello world + 代码块 const x = 1）
        await openFindAndSearch('const')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(1)
        })
        await openFindAndSearch('hello')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(1)
        })
    })

    it('紧凑模式：折叠 think/工具详情不在 DOM、聚合芯片文本不命中，仅正文命中', async () => {
        mockAgentState.messageDisplayMode = 'ultra-compact'
        mockConversationState.messagesMap['conv-1'] = [
            {
                id: 'm1', role: 'assistant', content: '',
                contentBlocks: [
                    // think：紧凑模式聚合成芯片（折叠不渲染内容）→ zzz 不可见
                    {id: 'b1', type: 'think', thinkBlock: {id: 'tb1', content: 'hidden thinking zzz', status: 'complete' as const, timestamp: 0}},
                    {id: 'b2', type: 'text', text: 'visible body hello'},
                    // 工具调用：紧凑模式聚合成芯片（arguments/result 在 popup，不在行 DOM）→ zzz 不可见
                    {
                        id: 'b3', type: 'tool_use', toolCall: {
                            id: 't1', name: 'bash', arguments: {command: 'echo hidden args zzz'},
                            result: {toolCallId: 't1', output: 'hidden result zzz'}, status: 'complete' as const,
                        },
                    },
                ],
            },
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)

        // 折叠 think + 工具 result 中才有的词 → 0 命中（紧凑模式下不在 DOM）
        await openFindAndSearch('zzz')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })

        // 工具 arguments 中的词 → 0 命中
        await openFindAndSearch('echo')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })

        // 聚合芯片文本（工具名 bash / 思考 N / 展开详情）→ 0 命中
        await openFindAndSearch('bash')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })

        // 正文本体 → 命中 1 处
        await openFindAndSearch('hello')
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(1)
        })
    })

    it('详情模式：工具卡片【展开后】arguments/result 计入命中（可见文本语义），折叠时不命中', async () => {
        mockAgentState.messageDisplayMode = 'detailed'
        mockConversationState.messagesMap['conv-1'] = [
            {
                id: 'm1', role: 'assistant', content: '',
                contentBlocks: [
                    {id: 'b1', type: 'text', text: 'visible body hello'},
                    {
                        id: 'b2', type: 'tool_use', toolCall: {
                            id: 't1', name: 'bash', arguments: {command: 'echo find-me-args'},
                            result: {toolCallId: 't1', output: 'find-me-output'}, status: 'complete' as const,
                        },
                    },
                ],
            },
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)
        await openFindAndSearch('find-me')

        // 折叠状态：ToolCallBody 不在 DOM → 不命中（工具头部的工具名等 UI 文本也不命中）
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })

        // 点击工具卡片 header（Normal 模式整行按钮）展开
        const headerBtn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent?.includes('bash'))
        expect(headerBtn).toBeTruthy()
        fireEvent.click(headerBtn!)

        // 展开后重新输入触发重建：arguments（find-me-args）+ result（find-me-output）→ 2 处命中
        // 正文 hello 也在（1 处），但 'find-me' 只出现在工具详情中
        const input = document.querySelector('.find-input') as HTMLInputElement
        fireEvent.change(input, {target: {value: 'find-me'}})
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(2)
        })
        // 「输出/命令」等 UI 标签文本不计入（搜索"命令"应 0 命中）
        fireEvent.change(input, {target: {value: '命令'}})
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
        })
    })

    it('DOM 变化后自动重建高亮（面板打开时）：命中文本被卸载 → 计数与高亮同步更新', async () => {
        mockAgentState.messageDisplayMode = 'detailed'
        mockConversationState.messagesMap['conv-1'] = [
            {
                id: 'm1', role: 'assistant', content: '',
                contentBlocks: [
                    {id: 'b1', type: 'think', thinkBlock: {id: 'tb1', content: 'thinking thinkme keyword', status: 'complete' as const, timestamp: 0}},
                    {id: 'b2', type: 'text', text: 'visible body hello'},
                ],
            },
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        render(<MessageList conversationId="conv-1"/>)
        await openFindAndSearch('thinkme')

        // detailed：think 默认展开（在 DOM）→ 1 命中
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size).toBe(1)
        })

        // 模拟 DOM 变化：折叠/模式切换等价于 think 内容从 DOM 卸载（React 移除元素）
        const scopeEl = Array.from(document.querySelectorAll('[data-find-scope]'))
            .find(el => el.textContent?.includes('thinkme'))
        expect(scopeEl).toBeTruthy()
        ;(scopeEl as HTMLElement).remove()
        // 触发捕获的 MutationObserver 回调（jsdom 不自动触发，模拟真实 observer）
        mutationCallbacks.forEach(({cb, inst}) => cb([], inst as unknown as MutationObserver))

        // 重建后：命中文本不在 DOM → 命中归零，计数不再残留旧快照
        await waitFor(() => {
            expect(highlightsMap.get('find-match')?.ranges.size ?? 0).toBe(0)
            expect(getFindPanelText()).not.toContain('/')
        })
    })

    it('搜索定位按 Range 精确居中：粗定位行级 scrollIntoView + 命中文本偏差 scrollTo 校正', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm1', role: 'user', content: 'hello world', timestamp: 1710000000000},
            {id: 'm2', role: 'assistant', content: 'no match at all', timestamp: 1710000000000},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        // ── 几何模拟 ──
        // 容器 rect 0-800（中心 400）；m1 行粗定位后 rect 0-40；命中文本 Range 首测 0-40
        // （中心 20，偏差 -380 → scrollTo 校正 top=scrollTop-380）；校正生效后 Range 380-420（居中 → 停止）
        let m1Scrolls = 0
        let corrections = 0
        const svMock = vi.fn(function (this: Element) {
            if (this.getAttribute?.('data-msg-idx') === '0') m1Scrolls++
        })
        Element.prototype.scrollIntoView = svMock as any
        const stMock = vi.fn(function (this: Element, opts: {top?: number}) {
            // 只统计负增量（搜索校正 top=-380）；排除组件初始化/goToBottom 的正向 scrollTo
            if (typeof opts?.top === 'number' && opts.top < 0) corrections++
        })
        Element.prototype.scrollTo = stMock as any

        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.getAttribute?.('data-name') === 'message-list-scroll-container') {
                return {top: 0, bottom: 800, height: 800, left: 0, right: 0, width: 0, x: 0, y: 0} as DOMRect
            }
            return {top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0} as DOMRect
        })
        // Range 几何：首测在顶部（偏差 -380）；一次 scrollTo 校正后居中（380-420）
        ;(Range.prototype.getBoundingClientRect as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
            top: corrections >= 1 ? 380 : 0,
            bottom: corrections >= 1 ? 420 : 40,
            left: 0, right: 100, width: 100, height: 40, x: 0, y: corrections >= 1 ? 380 : 0,
            toJSON: () => ({}),
        }))

        render(<MessageList conversationId="conv-1"/>)
        await openFindAndSearch('hello')

        // 粗定位：m1 行 scrollIntoView 1 次（auto 居中，触发 content-visibility 渲染）
        // 精确校正：Range 偏差 -380 → scrollTo(top=-380) 1 次；校正后居中 → 停止
        await waitFor(() => {
            expect(m1Scrolls).toBeGreaterThanOrEqual(1)
            expect(corrections).toBeGreaterThanOrEqual(1)
        })
        // 收敛：不再有第二次校正
        await new Promise(r => setTimeout(r, 500))
        expect(m1Scrolls).toBe(1)
        expect(corrections).toBe(1)
        // 校正调用的参数：偏差即增量（scrollTop=0 + (-380)），首次 auto
        const correctionCall = stMock.mock.calls.find(c => (c[0] as {top?: number})?.top === -380)
        expect(correctionCall).toBeTruthy()
        expect((correctionCall![0] as {behavior?: string}).behavior).toBe('auto')
        // 粗定位目标为命中行 m1（而非初始化滚动的 m2）
        expect(svMock.mock.instances.find(el => el.getAttribute?.('data-msg-idx') === '0')).toBeTruthy()

        vi.restoreAllMocks()
    })
})
