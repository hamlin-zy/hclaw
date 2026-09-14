// @vitest-environment jsdom
/**
 * 极简模式弹窗「接线」回归测试
 *
 * 背景：弹窗的实时刷新（pull 模型）依赖打开时透传的定位锚点
 * （convId / messageId / anchorToolCallId / anchorBlockId）。
 * 若 handleClick 漏传其中任一，弹窗将静默退化为「快照冻结」——
 * 而这条路径此前没有任何测试守护。
 *
 * 本文件直接渲染概要行组件并触发点击，断言 openToolPopup / openCombinedPopup
 * 收到的锚点参数完整。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, act} from '@testing-library/react'
import {UltraCompactToolGroup, UltraCompactCombinedGroup} from '../../../../src/renderer/components/message-list/ToolCallRenderer'
import {useToolCallsStore} from '../../../../src/renderer/stores/toolCallsStore'

const mockAgentState = vi.hoisted(() => ({
    messageDisplayMode: 'ultra-compact',
    openToolPopup: vi.fn(),
    openCombinedPopup: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: unknown) => unknown) => selector({activeConversationId: 'conv-1'}),
}))

vi.mock('../../../../src/renderer/stores/mcpStore', () => ({
    useMcpStore: (selector: (s: unknown) => unknown) => selector({mcpServers: []}),
}))

vi.mock('../../../../src/renderer/stores/modelSchemeStore', () => ({
    useModelSchemeStore: (selector: (s: unknown) => unknown) => selector({schemes: [], activeSchemeId: null}),
}))

vi.mock('../../../../src/renderer/stores/llmStore', () => ({
    useLLMStore: {getState: () => ({providers: []})},
}))

const tc = (id: string) => ({id, name: 'bash', arguments: {command: `echo ${id}`}, status: 'success' as const})

beforeEach(() => {
    mockAgentState.openToolPopup.mockClear()
    mockAgentState.openCombinedPopup.mockClear()
    useToolCallsStore.getState().clearAll()
})

describe('极简模式概要行 → 弹窗 锚点透传', () => {
    it('UltraCompactToolGroup：透传 convId / messageId / anchorToolCallId', () => {
        const {container} = render(
            <UltraCompactToolGroup toolCalls={[tc('tc1'), tc('tc2')] as any} messageId="m1"/>,
        )
        const btn = container.querySelector('[data-name="tool-call-renderer-button"]') as HTMLElement
        expect(btn).toBeTruthy()

        act(() => { btn.click() })

        expect(mockAgentState.openToolPopup).toHaveBeenCalledTimes(1)
        expect(mockAgentState.openToolPopup).toHaveBeenCalledWith(expect.objectContaining({
            convId: 'conv-1',
            messageId: 'm1',
            anchorToolCallId: 'tc1',
        }))
    })

    it('UltraCompactCombinedGroup：透传 convId / messageId / anchorToolCallId / anchorBlockId', () => {
        const items = [
            {type: 'think' as const, thinkBlock: {id: 'b1', content: 'x', status: 'complete'} as any, blockId: 'b1'},
            {type: 'tools' as const, toolCalls: [tc('tc1')] as any},
        ]
        const {container} = render(
            <UltraCompactCombinedGroup items={items as any} thinkCount={1} toolCalls={[tc('tc1')] as any} messageId="m1"/>,
        )
        const btn = container.querySelector('[data-name="tool-call-renderer-toggle-expanded-button"]') as HTMLElement
        expect(btn).toBeTruthy()

        act(() => { btn.click() })

        expect(mockAgentState.openCombinedPopup).toHaveBeenCalledTimes(1)
        expect(mockAgentState.openCombinedPopup).toHaveBeenCalledWith(expect.objectContaining({
            convId: 'conv-1',
            messageId: 'm1',
            anchorToolCallId: 'tc1',
            anchorBlockId: 'b1',
        }))
    })
})
