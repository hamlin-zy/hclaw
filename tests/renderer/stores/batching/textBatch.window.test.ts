// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

// store 桩：flushTextBatch 依赖 useAgentStore/useConversationStore
const {mockUpdateMessageForConv, mockUpdateConvData} = vi.hoisted(() => ({
    mockUpdateMessageForConv: vi.fn(),
    mockUpdateConvData: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {
                'conv-1': {
                    streamingMessageId: 'msg-1',
                    streamBuffer: '',
                    streamBlocks: [],
                    agentState: {status: 'running'},
                },
            },
            updateConvData: (...a: unknown[]) => mockUpdateConvData(...a),
        }),
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            activeConversationId: 'conv-1',
            updateMessageForConv: (...a: unknown[]) => mockUpdateMessageForConv(...a),
        }),
    },
}))

import {
    accumulateTextBatch, flushTextBatch, scheduleImmediateTextFlush,
    clearTextBatch, flushAllTextBatches,
} from '../../../../src/renderer/stores/agentStore/batching/textBatch'

describe('textBatch 固定窗口批处理', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        // 顺序：先清残留 batch（顺带复位窗口 timer），再清 mock 计数，
        // 避免前一用例遗留的未到期 timer / 残留 batch 污染本用例断言
        flushAllTextBatches()
        mockUpdateMessageForConv.mockClear()
        mockUpdateConvData.mockClear()
    })
    afterEach(() => {
        flushAllTextBatches()
        vi.useRealTimers()
    })

    it('窗口内 N 个 chunk 只 flush 一次，内容完整拼接', () => {
        accumulateTextBatch('conv-1', '你')
        accumulateTextBatch('conv-1', '好')
        accumulateTextBatch('conv-1', '！')
        scheduleImmediateTextFlush('conv-1', 'msg-1')
        vi.advanceTimersByTime(24)
        expect(mockUpdateMessageForConv).toHaveBeenCalledTimes(1)
        expect(mockUpdateMessageForConv.mock.calls[0][2]).toMatchObject({content: '你好！'})
    })

    it('窗口不因新 chunk 重置：总时长 ≈ 窗口值（50ms ÷ 24ms = 2 窗）', () => {
        // 每 1ms 一个 chunk 共 50ms → 固定 24ms 窗口恰好 2 窗（chunk 0..23 / 24..49）。
        // 若窗口被新 chunk 重置（每 1ms 推迟 timer），50ms 内一窗都走不完 → 0 次，
        // 故断言 2 能严格区分「固定窗口」与「重置窗口」；同时远小于每 chunk 一次（50 次）。
        for (let i = 0; i < 50; i++) {
            accumulateTextBatch('conv-1', `c${i}`)
            scheduleImmediateTextFlush('conv-1', 'msg-1')
            vi.advanceTimersByTime(1)
        }
        expect(mockUpdateMessageForConv).toHaveBeenCalledTimes(2)  // 2 窗：内容按窗合并，非逐 chunk
    })

    it('慢速流：chunk 间隔 > 窗口 → 每窗只含 1 个 chunk（逐字顺滑）', () => {
        accumulateTextBatch('conv-1', '第')
        scheduleImmediateTextFlush('conv-1', 'msg-1')
        vi.advanceTimersByTime(24)
        accumulateTextBatch('conv-1', '一')
        scheduleImmediateTextFlush('conv-1', 'msg-1')
        vi.advanceTimersByTime(24)
        expect(mockUpdateMessageForConv).toHaveBeenCalledTimes(2)
        expect(mockUpdateMessageForConv.mock.calls[0][2]).toMatchObject({content: '第'})
        expect(mockUpdateMessageForConv.mock.calls[1][2]).toMatchObject({content: '一'})
    })

    it('flushAllTextBatches 强制清空残留（done 兜底路径）', () => {
        accumulateTextBatch('conv-1', '残留')
        scheduleImmediateTextFlush('conv-1', 'msg-1')
        flushAllTextBatches()  // 不等到期
        expect(mockUpdateMessageForConv).toHaveBeenCalledTimes(1)
    })

    it('clearTextBatch 清空累积，后续 flush 不产生更新', () => {
        accumulateTextBatch('conv-1', '丢弃')
        clearTextBatch('conv-1')
        scheduleImmediateTextFlush('conv-1', 'msg-1')
        vi.advanceTimersByTime(24)
        expect(mockUpdateMessageForConv).not.toHaveBeenCalled()
    })
})
