import {describe, expect, it} from 'vitest'
import {createForwardPayload, trimLlmCallDoneForRenderer} from '@/main/agent/manager.streamForward'
import type {AgentStreamEvent} from '@/main/agent/stream'

/** 构造完整 llm_call_done 事件（模拟 worker→主进程原始事件，含大字段） */
function makeFullLlmCallDone(): Extract<AgentStreamEvent, {type: 'llm_call_done'}> {
    return {
        type: 'llm_call_done',
        conversationTitle: 'sdd 长任务',
        provider: 'anthropic',
        providerType: 'anthropic',   // 新增：精确服务商类型
        providerName: 'Deepseek-ant', // 新增：providers 表服务商名（人类可读）
        model: 'claude-sonnet-4-5',
        duration: 12345,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        reasoningTokens: 100,
        ttftMs: 800,
        decodeMs: 5000,
        tokensPerSecond: 40,
        inputContent: 'x'.repeat(500),      // 大字段
        outputContent: 'y'.repeat(2000),    // 大字段
        toolCalls: [{id: 'tc-1', name: 'bash', input: {command: 'ls'}, output: 'ok', success: true}],
        messages: [                          // 大字段：完整新增消息数组
            {role: 'user', content: '请执行任务'},
            {role: 'assistant', content: '好的', toolCalls: [{id: 'tc-1', name: 'bash', arguments: {command: 'ls'}}]},
            {role: 'tool', content: '...'.repeat(1000), toolCallId: 'tc-1', toolResult: '...'.repeat(1000)},
        ],
        systemPrompt: 'system prompt '.repeat(100), // 大字段
    }
}

describe('createForwardPayload — 转发载荷构造', () => {
    it('llm_call_done 瘦身：剥离大字段，仅保留渲染端 stats 字段', () => {
        const event = makeFullLlmCallDone()
        const {conversationId, event: out} = createForwardPayload('conv-1', event)

        expect(conversationId).toBe('conv-1')
        expect(out.type).toBe('llm_call_done')

        const e = out as Extract<AgentStreamEvent, {type: 'llm_call_done'}>
        // 保留的 stats 字段
        expect(e.provider).toBe('anthropic')
        expect(e.providerType).toBe('anthropic')   // 新增
        expect(e.providerName).toBe('Deepseek-ant') // 新增
        expect(e.model).toBe('claude-sonnet-4-5')
        expect(e.duration).toBe(12345)
        expect(e.inputTokens).toBe(1000)
        expect(e.outputTokens).toBe(500)
        expect(e.cacheReadTokens).toBe(800)
        expect(e.cacheWriteTokens).toBe(200)
        expect(e.reasoningTokens).toBe(100)
        expect(e.ttftMs).toBe(800)
        expect(e.decodeMs).toBe(5000)
        expect(e.tokensPerSecond).toBe(40)
        // 大字段必须被剥离（IPC 流量瘦身的核心断言）
        expect(e.inputContent).toBeUndefined()
        expect(e.outputContent).toBeUndefined()
        expect(e.messages).toBeUndefined()
        expect(e.systemPrompt).toBeUndefined()
        expect(e.toolCalls).toBeUndefined()
        // 序列化后大小显著减小（防回归：大字段若回归则载荷膨胀）
        const slimBytes = JSON.stringify(out).length
        const fullBytes = JSON.stringify(event).length
        expect(slimBytes).toBeLessThan(fullBytes / 10)
    })

    it('非 llm_call_done 事件原样透传（引用不变，零拷贝）', () => {
        const textEvent: AgentStreamEvent = {type: 'text', content: 'hello'}
        const {event: out} = createForwardPayload('conv-1', textEvent)
        expect(out).toBe(textEvent)
    })

    it('tool_result / thinking 等高频事件不受瘦身影响', () => {
        const thinking: AgentStreamEvent = {type: 'thinking', content: '思考中'}
        const toolResult = createForwardPayload('conv-1', {
            type: 'tool_result',
            toolCallId: 'tc-1',
            toolName: 'bash',
            result: {output: 'ok'},
        } as AgentStreamEvent)
        expect(createForwardPayload('conv-1', thinking).event).toBe(thinking)
        expect(toolResult.event.type).toBe('tool_result')
    })
})

describe('trimLlmCallDoneForRenderer — 字段级瘦身契约', () => {
    it('输出对象的键集合固定（新增字段需显式放行，防止大字段回归）', () => {
        const out = trimLlmCallDoneForRenderer(makeFullLlmCallDone())
        const keys = Object.keys(out).sort()
        expect(keys).toEqual([
            'cacheReadTokens',
            'cacheWriteTokens',
            'conversationTitle',
            'decodeMs',
            'duration',
            'inputTokens',
            'model',
            'outputTokens',
            'provider',
            'providerName',
            'providerType',
            'reasoningTokens',
            'tokensPerSecond',
            'ttftMs',
            'type',
        ])
    })

    it('可选 stats 字段缺失时仍生成合法载荷（不抛错）', () => {
        const out = trimLlmCallDoneForRenderer({
            type: 'llm_call_done',
            conversationTitle: '',
            provider: 'openai',
            providerType: 'openai',
            providerName: 'OpenAI',
            model: 'gpt-4o',
            duration: 0,
            inputTokens: 1,
            outputTokens: 1,
            inputContent: 'x',
            outputContent: 'y',
            messages: [{role: 'user', content: 'hi'}],
            systemPrompt: '',
        })
        expect(out.cacheReadTokens).toBeUndefined()
        expect(out.cacheWriteTokens).toBeUndefined()
        expect(out.reasoningTokens).toBeUndefined()
        expect(out.ttftMs).toBeUndefined()
        expect(out.decodeMs).toBeUndefined()
        expect(out.tokensPerSecond).toBeUndefined()
        expect(out.type).toBe('llm_call_done')
    })
})
