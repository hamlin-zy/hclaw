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
    truncateToolResultObject,
    TOOL_RESULT_TRUNCATE_LEN,
    TOOL_RESULT_TRUNCATE_SUFFIX,
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
    // 与真实实现一致：强制扁平复制（截断大串用）
    flatString: (s: string) => s.split('').join(''),
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

/** 取最近一次写入 conv-1 的 toolCall 列表 */
function lastToolCallsForConv(convId: string): any[] | undefined {
    const calls = mockConversationState.updateMessageForConv.mock.calls.filter((c: any[]) => c[0] === convId)
    const last = calls[calls.length - 1]
    return last ? last[2].toolCalls : undefined
}

describe('toolResultBatch 入队即截断（S4）', () => {
    it('入队大输出 flush 后与「仅 flush 截断」旧行为逐字节相同，error/artifacts/diff 保留、_fullOutputStored 语义不变', () => {
        const bigOutput = 'A'.repeat(5000)
        const bigToolResult = 'T'.repeat(4000)
        const rawResult = {
            success: true,
            output: bigOutput,
            toolResult: bigToolResult,
            artifacts: [{path: 'x'}],
            diff: 'diff-text',
        }

        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', rawResult)
        // visible → 执行 rAF 回调触发 flush
        const cb = rafCb
        rafCb = null
        cb!(0)

        const finalized = lastToolCallsForConv('conv-1')!.find((tc: any) => tc.id === 'tc-1')

        // 「仅 flush 截断」旧行为的最终值 = 对原始串做一次截断
        const expectedOldOutput = bigOutput.slice(0, TOOL_RESULT_TRUNCATE_LEN) + TOOL_RESULT_TRUNCATE_SUFFIX
        const expectedOldToolResult = bigToolResult.slice(0, TOOL_RESULT_TRUNCATE_LEN) + TOOL_RESULT_TRUNCATE_SUFFIX
        expect(finalized.result.output).toBe(expectedOldOutput)
        expect(finalized.result.toolResult).toBe(expectedOldToolResult)
        // 其余字段保留，截断不影响
        expect(finalized.result.artifacts).toEqual([{path: 'x'}])
        expect(finalized.result.diff).toBe('diff-text')
        // _fullOutputStored 语义不变：截断后为 true
        expect(finalized.result._fullOutputStored).toBe(true)
    })

    it('幂等性锁定：截断结果再截断逐字节相同（入队 + flush 双截断等价于单次截断）', () => {
        const raw = {output: 'A'.repeat(5000), toolResult: 'T'.repeat(4000)}
        const once = truncateToolResultObject(raw)
        const twice = truncateToolResultObject(once)
        expect(once.output).toBe('A'.repeat(TOOL_RESULT_TRUNCATE_LEN) + TOOL_RESULT_TRUNCATE_SUFFIX)
        expect(twice.output).toBe(once.output)
        expect(twice.toolResult).toBe(once.toolResult)
        expect(twice._fullOutputStored).toBe(true)
    })

    it('document.hidden 期间入队多个大输出 → Map 内每个 entry 的 result 均已截断（不再驻留全文）', () => {
        setHidden(true)
        const big1 = 'A'.repeat(5000)
        const big2 = 'B'.repeat(3000)
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-1', {
            success: true,
            output: big1,
            toolResult: 'C'.repeat(4000),
        })
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-2', {success: true, output: big2})
        scheduleToolResultUpdate('conv-1', 'msg-1', 'tc-3', {success: true, output: 'short'})

        const batch = getToolResultBatch('conv-1')
        // 大输出在入队时即被截断：Map 内不再是全文（长度显著下降且等于截断结果）
        expect(batch.get('tc-1')!.result.output).toBe(big1.slice(0, TOOL_RESULT_TRUNCATE_LEN) + TOOL_RESULT_TRUNCATE_SUFFIX)
        expect(batch.get('tc-1')!.result.output.length).toBeLessThan(big1.length)
        expect(batch.get('tc-1')!.result.toolResult).toBe(
            'C'.repeat(TOOL_RESULT_TRUNCATE_LEN) + TOOL_RESULT_TRUNCATE_SUFFIX,
        )
        expect(batch.get('tc-2')!.result.output).toBe(big2.slice(0, TOOL_RESULT_TRUNCATE_LEN) + TOOL_RESULT_TRUNCATE_SUFFIX)
        // 未超限的短结果原样保留（不产生截断后缀）
        expect(batch.get('tc-3')!.result.output).toBe('short')
        expect(batch.get('tc-3')!.result._fullOutputStored).toBeUndefined()
    })
})
