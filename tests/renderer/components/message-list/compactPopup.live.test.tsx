// @vitest-environment jsdom
/**
 * 极简模式弹窗「快照冻结」修复回归测试
 *
 * 缺陷场景：极简模式下 L1 聚合弹窗 / L2 工具详情弹窗渲染「打开时刻的快照」，
 * 打开后新出现的工具调用 / 思考块永不渲染（永远停留在打开时的状态）。
 *
 * 修复：弹窗按 anchor（toolCallId / blockId）从 conversationStore 的最新 message
 * 实时重推导（pull 模型），解析失败时回退快照。
 *
 * 本文件同时覆盖纯函数 resolveGroupByAnchor / resolveToolCallsByAnchor。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, act} from '@testing-library/react'
import CompactToolPopup from '../../../../src/renderer/components/message-list/compact-popup/index'
import CombinedCardPopup from '../../../../src/renderer/components/message-list/compact-popup/CombinedCardPopup'
import {
    buildDisplaySegments,
    resolveGroupByAnchor,
    resolveToolCallsByAnchor,
} from '../../../../src/renderer/components/message-list/utils/displaySegments'

// ── store / UI 依赖 mock ────────────────────────────────

// 轻量可订阅 store：保证弹窗（被 memo 包裹）能因 store 更新而重渲染
const hoisted = vi.hoisted(() => {
    const mk = (initial: any) => {
        let state = initial
        const listeners = new Set<() => void>()
        return {
            get: () => state,
            replace: (s: any) => { state = s; listeners.forEach(l => l()) },
            subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
        }
    }
    return {agent: mk({}), conv: mk({})}
})

vi.mock('../../../../src/renderer/stores/agentStore', async () => {
    const React = await import('react')
    return {
        useAgentStore: (selector: (s: any) => unknown) => {
            const state = React.useSyncExternalStore(hoisted.agent.subscribe, hoisted.agent.get, hoisted.agent.get)
            return selector(state)
        },
    }
})

vi.mock('../../../../src/renderer/stores/conversationStore', async () => {
    const React = await import('react')
    const useConversationStore = (selector: (s: any) => unknown) => {
        const state = React.useSyncExternalStore(hoisted.conv.subscribe, hoisted.conv.get, hoisted.conv.get)
        return selector(state)
    }
    return {
        useConversationStore: Object.assign(useConversationStore, {
            getState: () => hoisted.conv.get(),
        }),
    }
})

vi.mock('framer-motion', () => {
    const Passthrough = (props: any) => props.children ?? null
    const motion: any = new Proxy({}, {get: () => Passthrough})
    return {AnimatePresence: Passthrough, motion}
})

vi.mock('../../../../src/renderer/hooks/useDraggableDialog', () => ({
    useDraggableDialog: () => ({
        dialogRef: {current: null},
        position: {x: 0, y: 0},
        isDragging: false,
        handleDragStart: () => {},
    }),
}))

vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: (props: any) => props.children ?? null,
}))

vi.mock('../../../../src/renderer/components/message-list/StreamEntryRenderer', () => ({
    StreamEntryCard: () => null,
    mergeTimeline: () => [],
    getLastActiveTime: () => 0,
}))

vi.mock('../../../../src/renderer/components/message-list/compact-popup/PopupToolCard', () => ({
    PopupToolCard: ({toolCall}: any) => <div data-testid="popup-tool-card">{toolCall.id}</div>,
}))

vi.mock('../../../../src/renderer/components/icons', () => ({
    AgentIcon: () => null,
    SkillIcon: () => null,
    RemoveIcon: () => null,
}))

// ── 测试数据构造 ────────────────────────────────────────

const tc = (id: string) => ({id, name: 'bash', arguments: {command: `echo ${id}`}, status: 'success' as const})
const thinkBlock = (id: string) => ({id, content: `think-${id}`, status: 'complete' as const, timestamp: 1})
const toolBlock = (id: string) => ({id: `cb-${id}`, type: 'tool_use' as const, toolCall: tc(id)})
const thinkCb = (id: string) => ({id, type: 'think' as const, thinkBlock: thinkBlock(id)})
const msg = (id: string, blocks: any[]) => ({id, role: 'assistant', content: '', contentBlocks: blocks} as any)

function reset(convMsgs: Record<string, any[]>, agent: Partial<Record<string, any>> = {}) {
    hoisted.conv.replace({
        activeConversationId: 'conv-1',
        messagesMap: convMsgs,
        setActiveConversation: vi.fn(),
    })
    hoisted.agent.replace({
        openToolPopup: vi.fn(),
        openCombinedPopup: vi.fn(),
        closeToolPopup: vi.fn(),
        closeCombinedPopup: vi.fn(),
        updateToolPopupExpanded: vi.fn(),
        messageDisplayMode: 'ultra-compact',
        ...agent,
    })
}

beforeEach(() => {
    reset({})
})

// ── 1. L2 工具弹窗实时重推导 ────────────────────────────

describe('CompactToolPopup（L2）实时重推导', () => {
    it('打开后新出现的工具调用（tc2）应渲染，而非停留在打开时的快照', () => {
        reset({'conv-1': [msg('m1', [toolBlock('tc1')])]}, {
            toolPopupData: {
                toolCalls: [tc('tc1')],
                convId: 'conv-1',
                messageId: 'm1',
                anchorToolCallId: 'tc1',
            },
        })

        render(<CompactToolPopup/>)
        expect(screen.getByText('tc1')).toBeTruthy()
        expect(screen.queryByText('tc2')).toBeNull()

        // 消息更新：tc1 之后新增 tc2
        act(() => {
            hoisted.conv.replace({
                ...hoisted.conv.get(),
                messagesMap: {'conv-1': [msg('m1', [toolBlock('tc1'), toolBlock('tc2')])]},
            })
        })

        expect(screen.getByText('tc2')).toBeTruthy()
    })

    it('L2 由 L1 子卡片打开（anchor 位于 combined-group 的 tools 子项内）：新增 tc2 应渲染', () => {
        reset({'conv-1': [msg('m1', [thinkCb('b1'), toolBlock('tc1')])]}, {
            toolPopupData: {
                toolCalls: [tc('tc1')],
                convId: 'conv-1',
                messageId: 'm1',
                anchorToolCallId: 'tc1',
            },
        })

        render(<CompactToolPopup/>)
        expect(screen.queryByText('tc2')).toBeNull()

        // 同一 tools 子项内追加 tc2（连续工具 → 同一子项）
        act(() => {
            hoisted.conv.replace({
                ...hoisted.conv.get(),
                messagesMap: {'conv-1': [msg('m1', [thinkCb('b1'), toolBlock('tc1'), toolBlock('tc2')])]},
            })
        })

        expect(screen.getByText('tc1')).toBeTruthy()
        expect(screen.getByText('tc2')).toBeTruthy()
    })

    it('回退：anchor 未命中 / 缺省 → 使用快照，不崩溃', () => {
        reset({'conv-1': [msg('m1', [toolBlock('tc9')])]}, {
            toolPopupData: {
                toolCalls: [tc('tc1')],
                convId: 'conv-1',
                messageId: 'm1',
                anchorToolCallId: 'not-exist',
            },
        })
        render(<CompactToolPopup/>)
        expect(screen.getByText('tc1')).toBeTruthy()
    })

    it('回退：无 convId/messageId（旧调用方）→ 使用快照，不抛错', () => {
        reset({}, {toolPopupData: {toolCalls: [tc('tc1')]}})
        render(<CompactToolPopup/>)
        expect(screen.getByText('tc1')).toBeTruthy()
    })
})

// ── 2. L1 聚合弹窗实时重推导 ────────────────────────────

describe('CombinedCardPopup（L1）实时重推导', () => {
    it('打开后新增的思考块与工具调用应渲染（思考计数 +1、新增子卡片）', () => {
        const snapItems = [{type: 'think', thinkBlock: thinkBlock('b1'), blockId: 'b1'}, {type: 'tools', toolCalls: [tc('tc1')]}]
        reset({'conv-1': [msg('m1', [thinkCb('b1'), toolBlock('tc1')])]}, {
            combinedPopupData: {
                items: snapItems as any,
                thinkCount: 1,
                toolCalls: [tc('tc1')],
                convId: 'conv-1',
                messageId: 'm1',
                anchorToolCallId: 'tc1',
                anchorBlockId: 'b1',
            },
        })

        const {container} = render(<CombinedCardPopup/>)
        const subCardsBefore = container.querySelectorAll('[data-name="combined-card-popup-agent-card-button"]')
        expect(subCardsBefore.length).toBe(1)
        expect(container.textContent).toContain('思考 1')

        // 消息更新：新增 think b2 与 tc2
        act(() => {
            hoisted.conv.replace({
                ...hoisted.conv.get(),
                messagesMap: {'conv-1': [msg('m1', [thinkCb('b1'), toolBlock('tc1'), thinkCb('b2'), toolBlock('tc2')])]},
            })
        })

        expect(container.textContent).toContain('思考 2')
        const subCardsAfter = container.querySelectorAll('[data-name="combined-card-popup-agent-card-button"]')
        expect(subCardsAfter.length).toBe(2)
    })
})

// ── 3. 纯函数单测 ───────────────────────────────────────

describe('displaySegments 纯函数', () => {
    it('resolveToolCallsByAnchor：tool-group / combined-group / 未命中', () => {
        const segments = buildDisplaySegments(msg('m1', [toolBlock('tc1'), toolBlock('tc2')]), true)
        expect(resolveToolCallsByAnchor(segments, {toolCallId: 'tc2'})?.map(c => c.id)).toEqual(['tc1', 'tc2'])
        expect(resolveToolCallsByAnchor(segments, {toolCallId: 'nope'})).toBeNull()
        expect(resolveToolCallsByAnchor(segments, {})).toBeNull()

        const combined = buildDisplaySegments(msg('m1', [thinkCb('b1'), toolBlock('tc1')]), true)
        expect(resolveToolCallsByAnchor(combined, {toolCallId: 'tc1'})?.map(c => c.id)).toEqual(['tc1'])
    })

    it('resolveGroupByAnchor：tool-group / combined-group / 未命中', () => {
        const toolOnly = buildDisplaySegments(msg('m1', [toolBlock('tc1'), toolBlock('tc2')]), true)
        const g1 = resolveGroupByAnchor(toolOnly, {toolCallId: 'tc2'})
        expect(g1?.thinkCount).toBe(0)
        expect(g1?.toolCalls.map(c => c.id)).toEqual(['tc1', 'tc2'])

        const combined = buildDisplaySegments(msg('m1', [thinkCb('b1'), toolBlock('tc1')]), true)
        expect(resolveGroupByAnchor(combined, {toolCallId: 'tc1'})?.thinkCount).toBe(1)
        expect(resolveGroupByAnchor(combined, {blockId: 'b1'})?.thinkCount).toBe(1)

        expect(resolveGroupByAnchor(combined, {toolCallId: 'nope'})).toBeNull()
        expect(resolveGroupByAnchor(combined, {blockId: 'nope'})).toBeNull()
    })

    it('buildDisplaySegments：ultraCompact=false 返回基础片段，true 聚合', () => {
        const m = msg('m1', [thinkCb('b1'), toolBlock('tc1'), toolBlock('tc2')])
        const base = buildDisplaySegments(m, false)
        expect(base.some(s => s.type === 'tool')).toBe(true)
        expect(base.some(s => s.type === 'combined-group')).toBe(false)

        const compact = buildDisplaySegments(m, true)
        expect(compact.some(s => s.type === 'combined-group')).toBe(true)
    })
})
