// @vitest-environment jsdom
/**
 * toolResultBatch 隐藏冻结测试（Task 6）
 *
 * 保护：窗口 hidden 时 scheduleToolResultUpdate 只累积不调度 rAF（不再每 1Hz 节流帧
 * 持续 flush 积压的工具结果）；注册一次性 visibilitychange，visible 恢复时一次
 * flush 全部会话积压 batch，避免恢复黑屏的逐帧补 flush。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {
    getToolResultBatch,
    getToolResultBatchMap,
    scheduleToolResultUpdate,
    clearToolResultBatchData,
} from '@/renderer/stores/agentStore/batching/toolResultBatch'

// ── 依赖 mock：静态 store（getState 返回最小形态） ──
const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {
            'conv-1': [
                {
                    id: 'msg-1',
                    role: 'assistant',
                    toolCalls: [
                        {id: 'tc-1', name: 'bash', status: 'running'},
                        {id: 'tc-2', name: 'bash', status: 'running'},
                    ],
                },
            ],
            'conv-2': [
                {
                    id: 'msg-2',
                    role: 'assistant',
                    toolCalls: [
                        {id: 'tc-3', name: 'bash', status: 'running'},
                    ],
                },
            ],
        },
        updateMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {
            'conv-1': {streamingMessageId: 'msg-1'},
            'conv-2': {streamingMessageId: 'msg-2'},
        },
    },
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => mockConversationState,
    },
    recordToolResultBlock: vi.fn(),
}))

vi.mock('@/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockAgentState,
    },
}))

// ── 可控 rAF mock：记录是否被调度，并保存回调供测试显式执行 ──
let rafCb: FrameRequestCallback | null = null
let rafCalled = 0

const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', {value: hidden, configurable: true})
}

beforeEach(() => {
    rafCb = null
    rafCalled = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        rafCalled++
        rafCb = cb
        return 1
    })
    // 默认从可见状态开始
    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true})
    setHidden(false)
    mockConversationState.updateMessageForConv.mockClear()
    // 清空任何遗留 batch
    for (const convId of Object.keys(getToolResultBatchMap())) {
        clearToolResultBatchData(convId)
    }
    // 消费上一次测试可能遗留的一次性 visibilitychange 监听（visible → flush 空批次无副作用）
    document.dispatchEvent(new Event('visibilitychange'))
})

afterEach(() => {
    // 消费遗留监听 / 遗留 rAF，复位模块级状态（hiddenFlushRegistered / globalToolResultFlushScheduled）
    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true})
    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    if (rafCb) {
        const cb = rafCb
        rafCb = null
        cb(0)
    }
    vi.unstubAllGlobals()
})

describe('toolResultBatch 隐藏冻结（Task 6）', () => {
    it('hidden 时 scheduleToolResultUpdate 不调度 rAF，仅累积 batch，store 不更新', () => {
        setHidden(true)
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'x'})

        // ★ 核心：hidden 时不得调度 rAF（旧实现 1Hz 节流帧仍持续 flush）
        expect(rafCalled).toBe(0)
        // 仅累积：batch 非空，store 未更新
        expect(getToolResultBatch('conv-1').size).toBe(1)
        expect(mockConversationState.updateMessageForConv).not.toHaveBeenCalled()
    })

    it('hidden 期间多会话积压，visible 恢复时一次 flush 全部（batch 清空 + store 更新）', () => {
        setHidden(true)
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'A'})
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-2', {success: true, output: 'B'})
        scheduleToolResultUpdate('conv-2', 'msg-2', 'tc-3', {success: true, output: 'C'})
        expect(rafCalled).toBe(0)

        // 切 visible：dispatch visibilitychange → 同步 flush 全部会话，无需再调度 rAF
        setHidden(false)
        document.dispatchEvent(new Event('visibilitychange'))

        expect(rafCalled).toBe(0)
        expect(mockConversationState.updateMessageForConv).toHaveBeenCalledTimes(2)
        // 全部会话 batch 清空
        expect(getToolResultBatch('conv-1').size).toBe(0)
        expect(getToolResultBatch('conv-2').size).toBe(0)
        // 单会话 batch 合并为一次更新（conv-1 两条 toolCall 合并进同一次 updateMessageForConv）
        const conv1Updates = mockConversationState.updateMessageForConv.mock.calls.find(
            (c: any[]) => c[0] === 'conv-1',
        )
        expect(conv1Updates).toBeDefined()
        expect(conv1Updates![2].toolCalls.find((tc: any) => tc.id === 'tc-1').status).toBe('success')
        expect(conv1Updates![2].toolCalls.find((tc: any) => tc.id === 'tc-2').status).toBe('success')
    })

    it('hidden 期间多次 schedule 只注册一次 visibilitychange，恢复时合并 flush 一次', () => {
        setHidden(true)
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'A'})
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: false, error: 'boom'})
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-2', {success: true, output: 'B'})
        expect(rafCalled).toBe(0)

        setHidden(false)
        document.dispatchEvent(new Event('visibilitychange'))

        // 一次性监听：仅一次 flush → conv-1 一次 update
        expect(mockConversationState.updateMessageForConv).toHaveBeenCalledTimes(1)
        // 合并语义：tc-1 保留最后一次结果（error）
        const updates = mockConversationState.updateMessageForConv.mock.calls[0][2]
        expect(updates.toolCalls.find((tc: any) => tc.id === 'tc-1').status).toBe('error')
        expect(updates.toolCalls.find((tc: any) => tc.id === 'tc-2').status).toBe('success')
    })

    it('visible 时仍走 rAF 调度（回归保护），frame 触发 flush', () => {
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {success: true, output: 'X'})

        expect(rafCalled).toBe(1)
        expect(mockConversationState.updateMessageForConv).not.toHaveBeenCalled()

        // 执行 frame 回调 → flush
        const cb = rafCb
        rafCb = null
        cb!(0)
        expect(mockConversationState.updateMessageForConv).toHaveBeenCalledTimes(1)
        expect(getToolResultBatch('conv-1').size).toBe(0)
    })
})
