/**
 * 子会话块落库补 turnIndex（Brief B）— 累积器侧单测
 *
 * 背景：子会话走 messageToBlocks 全量落库，此前 StreamBlock / ChildConvAccumulator
 * 均无 turnIndex，落库后 turn_index 全为 NULL，historyConverter 只能走
 * convertFromContentBlocks（think 边界切段）fallback，与父会话 convertFromTurnIndex
 * 主路径语义分叉。本测试验证修复后：
 * - 块（think / tool_use）携带当前 LLM 调用轮次号
 * - llm_call_done 使轮次号递增（同轮多段 think 追加不新建轮次）
 * - rotate 后归零
 * - buildCurrentMessage 产出 contentBlocks 的 turnIndex 与源块一致
 */
import {describe, expect, it, vi} from 'vitest'
import type {AgentStreamEvent} from '../../../../../src/main/agent/stream'
import {
    createChildConvAccumulator,
    handleChildEvent,
    buildCurrentMessage,
    rotateChildConvAccumulator,
} from '../../../../../src/main/agent/tools/builtin/childConvMessages'

// ─── 事件工厂（与 childConvMessages.e2e.test.ts 同构）────────────────

const thinking = (content: string): AgentStreamEvent => ({type: 'thinking', content})
const toolUse = (id: string, name: string, args: Record<string, unknown> = {}): AgentStreamEvent => ({
    type: 'tool_use', toolCall: {id, name, arguments: args},
})
const toolResult = (id: string, output: string): AgentStreamEvent => ({
    type: 'tool_result', toolCallId: id, toolName: 'bash', result: {success: true, output},
})
const llmCallDone = (): AgentStreamEvent => ({
    type: 'llm_call_done',
    conversationTitle: 'child',
    provider: 'test',
    providerType: 'anthropic',
    providerName: 'Deepseek-ant',
    model: 'm',
    duration: 5000,
    inputTokens: 100,
    outputTokens: 200,
    ttftMs: 800,
    decodeMs: 5000,
    tokensPerSecond: 40,
})

/** 驱动事件流（不触达 DB，仅操作累积器） */
function drive(events: AgentStreamEvent[]) {
    const acc = createChildConvAccumulator()
    for (const event of events) handleChildEvent(acc, event)
    return acc
}

describe('子会话块 turnIndex（Brief B）', () => {
    it('多轮序列：thinking → tool_use → tool_result → llm_call_done → thinking → tool_use → llm_call_done，块 turnIndex 序列为 [0, 0, 1, 1]', () => {
        const acc = drive([
            thinking('先查目录'),
            toolUse('t1', 'bash', {command: 'ls'}),
            toolResult('t1', 'a.ts'),
            llmCallDone(),
            thinking('再读文件'),
            toolUse('t2', 'file_read', {path: 'a.ts'}),
            llmCallDone(),
        ])

        // 按块序：think(轮0) → tool_use(轮0) → think(轮1) → tool_use(轮1)
        expect(acc.blocks.map(b => b.turnIndex)).toEqual([0, 0, 1, 1])
        // 轮次号 = llm_call_done 次数
        expect(acc.turnIndex).toBe(2)
    })

    it('同轮多 think 追加不新建轮次：两个 thinking 事件落到同一块，turnIndex 均为 0', () => {
        const acc = drive([
            thinking('第一段'),
            thinking('第二段'),
            llmCallDone(),
        ])

        // 追加而非新建：只有 1 个块，内容为两段拼接
        expect(acc.blocks).toHaveLength(1)
        expect(acc.blocks[0]!.type).toBe('think')
        expect(acc.blocks[0]!.turnIndex).toBe(0)
        expect(acc.blocks[0]!.thinkContent).toBe('第一段第二段')
        expect(acc.turnIndex).toBe(1)
    })

    it('rotate 后归零：新块 turnIndex 从 0 重新开始', () => {
        const acc = drive([
            thinking('轮 0 思考'),
            llmCallDone(),
        ])
        expect(acc.turnIndex).toBe(1)

        const repo = {writeMessages: vi.fn()}
        rotateChildConvAccumulator(acc, repo as never, 'conv-rotate')

        expect(acc.turnIndex).toBe(0)
        // 注入新消息后：新块从 0 起
        handleChildEvent(acc, thinking('新运行思考'))
        expect(acc.blocks).toHaveLength(1)
        expect(acc.blocks[0]!.turnIndex).toBe(0)
    })

    it('buildCurrentMessage 透传：contentBlocks[*].turnIndex 与源块一致', () => {
        const acc = drive([
            thinking('轮 0 思考'),
            toolUse('t1', 'grep', {pattern: 'foo'}),
            toolResult('t1', 'match'),
            llmCallDone(),
            thinking('轮 1 思考'),
            toolUse('t2', 'bash', {command: 'echo'}),
            llmCallDone(),
        ])

        const msg = buildCurrentMessage(acc, Date.now())
        expect(msg).not.toBeNull()
        // 跳过 text / end 块（end 由 flush 追加，buildCurrentMessage 不产出 end），
        // 其余块（think / tool_use / text）turnIndex 均与源块一致
        const blockTurns = msg!.contentBlocks!
            .filter(b => b.type === 'think' || b.type === 'tool_use')
            .map(b => b.turnIndex)
        expect(blockTurns).toEqual([0, 0, 1, 1])
    })
})
