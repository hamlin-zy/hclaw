/**
 * childConvMessages（子会话完整执行过程累积器）单元测试
 *
 * 覆盖子 Agent 流事件 → 「单条」assistant 消息（contentBlocks 按时间序交错）的累积与落库：
 * - 整个运行累积为一条固定 id 消息（1 指令 + 1 助手气泡）
 * - thinking / text / tool_use 按 textOffset 交错为 contentBlocks
 * - tool_result 全部完成后触发增量落库（UPSERT 同一条消息，频率受轮次限制）
 * - 多轮追加到同一条消息（不新增消息），contentBlocks 持续增长
 * - llm_call_done 累积 llmStats
 * - final 写入附加 endedAt；空累积兜底占位；错误信息并入正文尾部
 *
 * 纯函数隔离：不依赖任何主进程模块，仅输入事件流与参数。
 */
import {describe, expect, it} from 'vitest'
import type {AgentStreamEvent} from '@/main/agent/stream'
import {
    createChildConvAccumulator,
    buildCurrentMessage,
    handleChildEvent,
    flushAccumulatorMessage,
} from '@/main/agent/tools/builtin/childConvMessages'

// ─── 测试用事件工厂 ──────────────────────────────────────

const thinking = (content: string): AgentStreamEvent => ({type: 'thinking', content})
const text = (content: string): AgentStreamEvent => ({type: 'text', content})
const toolUse = (id: string, name: string, args: Record<string, unknown> = {}): AgentStreamEvent => ({
    type: 'tool_use', toolCall: {id, name, arguments: args},
})
const toolStart = (id: string, name: string, args: Record<string, unknown> = {}, reason?: string): AgentStreamEvent => ({
    type: 'tool_start', toolCall: {id, name, arguments: args, reason},
})
const toolResult = (id: string, output: string, error?: string): AgentStreamEvent => ({
    type: 'tool_result', toolCallId: id, toolName: 'bash', result: {success: !error, output, error},
})
const llmDone = (tokens: number): AgentStreamEvent => ({
    type: 'llm_call_done',
    conversationTitle: '',
    provider: 'anthropic',
    model: 'claude',
    duration: 100,
    inputTokens: tokens,
    outputTokens: tokens / 2,
    inputContent: '',
    outputContent: '',
})

// ─── Mock repository ─────────────────────────────────────

function mockRepo() {
    const written: Array<{convId: string; messages: import('@shared/types').Message[]}> = []
    return {
        repo: {
            writeMessages: (convId: string, messages: import('@shared/types').Message[]) => {
                written.push({convId, messages})
                return true
            },
        },
        written,
    }
}

describe('childConvMessages（子会话完整执行过程累积器 — 单条消息模式）', () => {
    it('整个运行累积为一条消息（id 为 msg- 前缀，与主会话 assistant 同格式）', () => {
        const acc = createChildConvAccumulator('conv-child-1')
        expect(acc.assistantMsgId).toMatch(/^msg-\d+-[a-z0-9]{6}$/)

        handleChildEvent(acc, thinking('分析'))
        handleChildEvent(acc, text('正文'))
        handleChildEvent(acc, toolUse('t1', 'bash', {command: 'ls'}))
        handleChildEvent(acc, toolResult('t1', 'out'))

        const msg = buildCurrentMessage(acc, 1700000000000)
        expect(msg!.id).toBe(acc.assistantMsgId)
        // 单条消息：contentBlocks 完整保留 think → text → tool_use 时间序
        const types = msg!.contentBlocks!.map(b => b.type)
        expect(types).toEqual(['think', 'text', 'tool_use'])
    })

    it('thinking 连续块拼接', () => {
        const acc = createChildConvAccumulator('c')
        handleChildEvent(acc, thinking('第一步'))
        handleChildEvent(acc, thinking('，第二步'))
        const msg = buildCurrentMessage(acc, 1700000000000)
        expect(msg!.contentBlocks![0].thinkBlock?.content).toBe('第一步，第二步')
    })

    it('tool_use + tool_start + tool_result 累积为完整 toolCall', () => {
        const acc = createChildConvAccumulator('c')
        handleChildEvent(acc, toolUse('t1', 'bash', {command: 'ls'}))
        handleChildEvent(acc, toolStart('t1', 'bash', {command: 'ls'}, '查看目录'))
        handleChildEvent(acc, toolResult('t1', 'file1\nfile2'))

        const tc = acc.toolCalls.get('t1')
        expect(tc).toBeDefined()
        expect(tc!.name).toBe('bash')
        expect(tc!.reason).toBe('查看目录')
        expect(tc!.status).toBe('success')
        expect(tc!.result?.output).toBe('file1\nfile2')
    })

    it('tool_result 返回错误时 toolCall 标记 error', () => {
        const acc = createChildConvAccumulator('c')
        handleChildEvent(acc, toolStart('t1', 'bash'))
        handleChildEvent(acc, toolResult('t1', '', 'command not found'))
        expect(acc.toolCalls.get('t1')!.status).toBe('error')
        expect(acc.toolCalls.get('t1')!.result?.error).toBe('command not found')
    })

    it('文本与工具按 textOffset 交错', () => {
        const acc = createChildConvAccumulator('c')
        handleChildEvent(acc, text('先看目录'))
        handleChildEvent(acc, toolUse('t1', 'bash', {command: 'ls'}))
        handleChildEvent(acc, text('再读文件'))
        handleChildEvent(acc, toolUse('t2', 'file_read', {path: 'a.ts'}))
        handleChildEvent(acc, toolResult('t1', 'out1'))
        handleChildEvent(acc, toolResult('t2', 'out2'))

        const msg = buildCurrentMessage(acc, 1700000000000)
        const types = msg!.contentBlocks!.map(b => b.type)
        expect(types).toEqual(['text', 'tool_use', 'text', 'tool_use'])
        // textOffset 保持工具在正文中的位置
        expect(msg!.contentBlocks![1].toolCall?.textOffset).toBe(4)
        expect(msg!.contentBlocks![3].toolCall?.textOffset).toBe(8)
    })

    it('多轮追加到同一条消息，增量落库 UPSERT 同一 id', () => {
        const {repo, written} = mockRepo()
        const acc = createChildConvAccumulator('conv-child')

        // 轮 1：思考 + 工具 → tool_result 触发落库
        handleChildEvent(acc, thinking('轮1思考'))
        handleChildEvent(acc, toolUse('t1', 'bash'))
        handleChildEvent(acc, toolResult('t1', 'r1'))
        expect(acc.pendingToolCount).toBe(0)
        flushAccumulatorMessage(acc, repo, 'conv-child', false)
        expect(written).toHaveLength(1)
        expect(written[0].messages[0].id).toMatch(/^msg-/)

        // 轮 2：文本 + 工具 → 追加到同一条
        handleChildEvent(acc, text('轮2正文'))
        handleChildEvent(acc, toolUse('t2', 'grep'))
        handleChildEvent(acc, toolResult('t2', 'r2'))
        flushAccumulatorMessage(acc, repo, 'conv-child', false)
        expect(written).toHaveLength(2)
        expect(written[1].messages[0].id).toMatch(/^msg-/)
        const msg = written[1].messages[0]
        expect(msg.content).toBe('轮2正文')
        expect(msg.contentBlocks!.map(b => b.type)).toEqual(['think', 'tool_use', 'text', 'tool_use'])
        // 两条消息为同一条的两次快照（最终覆盖），不是两条独立消息
        expect(written[0].messages[0].id).toBe(written[1].messages[0].id)
    })

    it('llm_call_done 累积 llmStats 并触发增量落库', () => {
        const {repo, written} = mockRepo()
        const acc = createChildConvAccumulator('c')
        handleChildEvent(acc, thinking('思考'))
        handleChildEvent(acc, text('回答'))
        const done = handleChildEvent(acc, llmDone(100))
        expect(done).toBe(true)
        expect(acc.llmStats).toHaveLength(1)
        expect(acc.llmStats[0].inputTokens).toBe(100)

        flushAccumulatorMessage(acc, repo, 'c', false)
        expect(written[0].messages[0].llmStats).toHaveLength(1)
        expect(written[0].messages[0].contentBlocks![0].type).toBe('think')
    })

    it('final 写入附加 endedAt；错误信息并入正文尾部', () => {
        const {repo, written} = mockRepo()
        const acc = createChildConvAccumulator('c')
        handleChildEvent(acc, text('部分输出'))
        handleChildEvent(acc, {type: 'error', error: 'boom'})
        flushAccumulatorMessage(acc, repo, 'c', true)

        expect(written).toHaveLength(1)
        expect(written[0].messages[0].endedAt).toBeDefined()
        expect(written[0].messages[0].content).toContain('部分输出')
        expect(written[0].messages[0].content).toContain('执行失败**')
        expect(written[0].messages[0].content).toContain('boom')
    })

    it('空累积 final 落库生成占位消息（不产生空气泡）', () => {
        const {repo, written} = mockRepo()
        const acc = createChildConvAccumulator('c')
        acc.hasError = true
        acc.errorMsg = 'boom'
        flushAccumulatorMessage(acc, repo, 'c', true)

        expect(written).toHaveLength(1)
        expect(written[0].messages[0].content).toContain('执行失败: boom')
    })

    it('多个并行工具同轮共享一条消息（全部完成后才落库）', () => {
        const acc = createChildConvAccumulator('c')
        // 真实事件序：同轮工具先全部声明，再逐个完成
        handleChildEvent(acc, toolStart('a', 'bash'))
        handleChildEvent(acc, toolStart('b', 'bash'))
        expect(acc.pendingToolCount).toBe(2)

        const shouldFlush1 = handleChildEvent(acc, toolResult('a', 'ra'))
        expect(shouldFlush1).toBe(false)
        expect(acc.pendingToolCount).toBe(1)

        const shouldFlush2 = handleChildEvent(acc, toolResult('b', 'rb'))
        expect(shouldFlush2).toBe(true)
        expect(acc.pendingToolCount).toBe(0)

        const msg = buildCurrentMessage(acc, 1700000000000)
        expect(msg!.toolCalls).toHaveLength(2)
        expect(msg!.contentBlocks!.filter(b => b.type === 'tool_use')).toHaveLength(2)
    })
})
