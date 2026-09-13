// @vitest-environment jsdom
/**
 * InterleavedContent 片段渲染回归测试（Task 0.6 / C10 前置）
 *
 * 目标组件：src/renderer/components/message-list/InterleavedContent.tsx
 * （本批最大删减：add 15 / del 208 —— 最可能被简化改坏、且此前无直接测试）。
 *
 * 覆盖范围（对应任务简报 3 条）：
 *   1. 片段顺序：含「文本段 + 工具段」的 message，DOM 中片段顺序 === buildDisplaySegments 输出顺序
 *   2. 空 message：不崩，且渲染空容器（container.innerHTML === ''）
 *   3. ultraCompact 开关：切换后片段数量变化，且与 buildDisplaySegments 计算结果一致
 *
 * 设计：被测逻辑是 InterleavedContent 对 processedSegments 的「映射/顺序」，
 * 而非 store 或叶子渲染器。因此只 mock 叶子渲染器（MarkdownRenderer / ThinkBlock /
 * ToolCallRenderer / MediaPlayer），让每个片段在 DOM 中留下可辨识的 data-seg 标记；
 * store 用最小桩（对齐 InterleavedContent.memo.test.tsx 的写法）。
 * buildDisplaySegments 保持真实（不 mock），使断言直接绑定纯函数的输出。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render} from '@testing-library/react'

// ── 叶子渲染器 mock：为每个片段留下可读的 data-seg 标记 ──────────────
// 说明：这些 mock 只是「让片段的种类+载荷可观测」，不替换 InterleavedContent 的
// 片段编排逻辑（被测对象），故不违背「mock 不得吃掉被测逻辑」的约束。

vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    // ThrottledMarkdown 以 children 传入文本内容
    default: ({children}: any) => <div data-seg={`text:${children}`}>{children}</div>,
}))

vi.mock('../../../../src/renderer/components/ThinkBlock', () => ({
    default: ({thinkBlock}: any) => <div data-seg={`think:${thinkBlock.id}`}/>,
}))

vi.mock('../../../../src/renderer/components/message-list/ToolCallRenderer', () => ({
    default: ({toolCall}: any) => <div data-seg={`tool:${toolCall.id}`}/>,
    UltraCompactToolGroup: ({toolCalls}: any) => (
        <div data-seg={`tool-group:${toolCalls.map((c: any) => c.id).join(',')}`}/>
    ),
    UltraCompactCombinedGroup: ({thinkCount, toolCalls}: any) => (
        <div data-seg={`combined-group:${thinkCount}:${toolCalls.map((c: any) => c.id).join(',')}`}/>
    ),
}))

vi.mock('../../../../src/renderer/components/message-list/MediaPlayer', () => ({
    default: () => <div data-seg="media"/>,
}))

// ── store 最小桩（可切换 messageDisplayMode 以驱动 ultraCompact 开关）──
// state 形态对齐真实 selector 访问路径，避免 ThrottledMarkdown 内的 isStreaming 误判。
const hoisted = vi.hoisted(() => ({
    state: {
        messageDisplayMode: 'detailed',
        agentState: {status: 'idle'},
        convAgentStates: {},
    } as {messageDisplayMode: string; agentState: {status: string}; convAgentStates: any},
}))

vi.mock('../../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: () => 'light',
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (sel?: (s: any) => unknown) => (sel ? sel(hoisted.state) : hoisted.state),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: any) => unknown) =>
        sel ? sel({activeConversationId: 'conv-1'}) : {activeConversationId: 'conv-1'},
}))

import InterleavedContent from '../../../../src/renderer/components/message-list/InterleavedContent'
import {buildDisplaySegments, type Segment} from '../../../../src/renderer/components/message-list/utils/displaySegments'

// ── 测试数据构造（风格对齐 compactPopup.live.test.tsx / displaySegments.test.ts）──
const tc = (id: string) => ({id, name: 'bash', arguments: {command: `echo ${id}`}, status: 'success' as const})
const thinkBlock = (id: string) => ({id, content: `think-${id}`, status: 'complete' as const, timestamp: 1})
const toolBlock = (id: string) => ({id: `cb-${id}`, type: 'tool_use' as const, toolCall: tc(id)})
const thinkCb = (id: string) => ({id, type: 'think' as const, thinkBlock: thinkBlock(id)})
const textCb = (id: string, text: string) => ({id, type: 'text' as const, text})
const msg = (id: string, blocks: any[]) => ({id, role: 'assistant', content: '', timestamp: 1, contentBlocks: blocks} as any)

// 把一个 Segment 映射为 DOM 里对应的 data-seg 标记（与上面 mock 一一对应）。
function markerOf(seg: Segment): string | null {
    switch (seg.type) {
        case 'text': return `text:${seg.content}`
        case 'think-thread': return `think:${seg.blockId}`
        case 'tool': return `tool:${seg.toolCall.id}`
        case 'tool-with-reason': return `tool:${seg.toolCall.id}` // reason 是附加块，标记仍由 ToolCallRenderer 产出
        case 'tool-group': return `tool-group:${seg.toolCalls.map((c) => c.id).join(',')}`
        case 'combined-group': return `combined-group:${seg.thinkCount}:${seg.toolCalls.map((c) => c.id).join(',')}`
        case 'media': return 'media'
        default: return null
    }
}

// 读取 DOM 中按文档顺序排列的片段标记
function domMarkers(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('[data-seg]')).map(
        (el) => el.getAttribute('data-seg') as string,
    )
}

const setDisplayMode = (mode: string) => { hoisted.state.messageDisplayMode = mode }

function renderMsg(message: any, mode: string) {
    setDisplayMode(mode)
    return render(<InterleavedContent message={message} isUser={false}/>)
}

beforeEach(() => {
    hoisted.state.messageDisplayMode = 'detailed'
    hoisted.state.agentState = {status: 'idle'}
})

// ── 1. 片段顺序：DOM 顺序 === buildDisplaySegments 输出顺序 ──────────
describe('InterleavedContent — 片段顺序（与 buildDisplaySegments 一致）', () => {
    it('文本段 + 连续工具段：顺序为 text → tool → tool', () => {
        const m = msg('m1', [textCb('t1', 'hello'), toolBlock('tc1'), toolBlock('tc2')])
        const expected = buildDisplaySegments(m, false).map(markerOf)
        expect(expected).toEqual(['text:hello', 'tool:tc1', 'tool:tc2']) // 前置：纯函数输出符合预期

        const {container} = renderMsg(m, 'detailed')
        expect(domMarkers(container)).toEqual(expected)
    })

    it('文本与工具交替：顺序严格保持 text → tool → text → tool', () => {
        const m = msg('m1', [
            textCb('t1', 'hello'),
            toolBlock('tc1'),
            textCb('t2', 'world'),
            toolBlock('tc2'),
        ])
        const expected = buildDisplaySegments(m, false).map(markerOf)
        expect(expected).toEqual(['text:hello', 'tool:tc1', 'text:world', 'tool:tc2'])

        const {container} = renderMsg(m, 'detailed')
        expect(domMarkers(container)).toEqual(expected)
    })

    it('think 段参与顺序：think → tool → text（detailed 模式不聚合）', () => {
        const m = msg('m1', [thinkCb('b1'), toolBlock('tc1'), textCb('t1', 'body')])
        const expected = buildDisplaySegments(m, false).map(markerOf)
        expect(expected).toEqual(['think:b1', 'tool:tc1', 'text:body'])

        const {container} = renderMsg(m, 'detailed')
        expect(domMarkers(container)).toEqual(expected)
    })
})

// ── 2. 空 message：不崩且渲染空容器 ────────────────────────────────
describe('InterleavedContent — 空 message', () => {
    it('无 content / 无 contentBlocks / 无 toolCalls → 渲染空容器', () => {
        const m = {id: 'm-empty', role: 'assistant', content: '', timestamp: 1} as any
        expect(buildDisplaySegments(m, false)).toEqual([]) // 纯函数也返回空

        const {container} = renderMsg(m, 'detailed')
        expect(container.innerHTML).toBe('')       // 具体行为：不渲染任何节点
        expect(domMarkers(container)).toEqual([])
    })

    it('contentBlocks 为空数组 + 空文本 → 同样渲染空容器', () => {
        const m = msg('m-empty2', [])
        const {container} = renderMsg(m, 'ultra-compact')
        expect(container.innerHTML).toBe('')
    })
})

// ── 3. ultraCompact 开关：片段数量随模式变化且与纯函数一致 ────────────
describe('InterleavedContent — ultraCompact 开关', () => {
    const build = () => msg('m1', [
        thinkCb('b1'),
        toolBlock('tc1'),
        textCb('t1', 'body'),
        toolBlock('tc2'),
        toolBlock('tc3'),
    ])

    it('detailed：片段数与顺序 === buildDisplaySegments(msg,false)（不聚合）', () => {
        const m = build()
        const expected = buildDisplaySegments(m, false).map(markerOf)
        expect(expected).toEqual(['think:b1', 'tool:tc1', 'text:body', 'tool:tc2', 'tool:tc3'])

        const {container} = renderMsg(m, 'detailed')
        expect(domMarkers(container)).toEqual(expected)
        expect(domMarkers(container).length).toBe(5)
    })

    it('ultra-compact：片段数减少为 3 且与 buildDisplaySegments(msg,true) 一致（think+tool 聚合）', () => {
        const m = build()
        const expected = buildDisplaySegments(m, true).map(markerOf)
        expect(expected).toEqual(['combined-group:1:tc1', 'text:body', 'combined-group:0:tc2,tc3'])

        const {container} = renderMsg(m, 'ultra-compact')
        expect(domMarkers(container)).toEqual(expected)
        expect(domMarkers(container).length).toBe(3)
    })

    it('切换开关：片段数量由 5 变为 3（数量断言依赖模式，非恒真）', () => {
        const m = build()
        const baseLen = buildDisplaySegments(m, false).length
        const compactLen = buildDisplaySegments(m, true).length
        expect(baseLen).toBe(5)
        expect(compactLen).toBe(3)

        const {container: c1} = renderMsg(m, 'detailed')
        expect(c1.querySelectorAll('[data-seg]').length).toBe(baseLen)

        const {container: c2} = renderMsg(m, 'ultra-compact')
        expect(c2.querySelectorAll('[data-seg]').length).toBe(compactLen)
        expect(c1.querySelectorAll('[data-seg]').length)
            .not.toBe(c2.querySelectorAll('[data-seg]').length)
    })
})
