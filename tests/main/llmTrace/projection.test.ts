import {describe, it, expect} from 'vitest'
import {extractUsage, foldRecords, computeTokens} from '../../../src/main/utils/llmLogProjection'
import type {LlmCallRecord} from '@shared/types/llmTrace'

const rec = (over: Partial<LlmCallRecord>): LlmCallRecord => ({
    id: 'r', ts: 1, conversationId: 'c', turn: 1, step: 1, attempt: 0,
    context: 'main', provider: 'p', model: 'm', apiStyle: 'chat',
    status: 'ok', firstByteMs: 100, totalMs: 1000, reqFile: 'r.req.json', ...over,
})

describe('extractUsage', () => {
    it('chat: 解析 SSE 末帧 usage（OpenAI 兼容 include_usage 格式）', () => {
        const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,'
            + '"prompt_cache_hit_tokens":80}}\n\ndata: [DONE]\n\n'
        expect(extractUsage('chat', sse)).toEqual({
            inputTokens: 100, outputTokens: 20, cacheReadTokens: 80,
        })
    })
    it('responses: 取 response.completed 事件 usage', () => {
        const sse = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":10}}}'
        expect(extractUsage('responses', sse)).toEqual({inputTokens: 50, outputTokens: 10})
    })
    it('anthropic: message_start+message_delta 组合，含 cacheWrite', () => {
        const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":15,"cache_creation_input_tokens":3}}}\n'
            + 'data: {"type":"message_delta","usage":{"output_tokens":77}}\n'
        expect(extractUsage('anthropic', sse)).toEqual({
            inputTokens: 25, outputTokens: 77, cacheReadTokens: 15, cacheWriteTokens: 3,
        })
    })
    it('google: 非流式 JSON usageMetadata（含缓存与思考 token）', () => {
        const json = JSON.stringify({
            candidates: [{content: {parts: [{text: 'hi'}]}, finishReason: 'STOP'}],
            usageMetadata: {
                promptTokenCount: 120, candidatesTokenCount: 30,
                cachedContentTokenCount: 20, thoughtsTokenCount: 5,
            },
        })
        expect(extractUsage('google', json)).toEqual({
            inputTokens: 120, outputTokens: 30, reasoningTokens: 5,
        })
    })
    it('未知结构 → null 不抛错', () => {
        expect(extractUsage('chat', 'garbage !!')).toBeNull()
        expect(extractUsage('google', '')).toBeNull()
    })
})

describe('foldRecords', () => {
    it('按 conversation→turn 层级分组，重试链同组', () => {
        const t = foldRecords([
            rec({id: '1', turn: 1}),
            rec({id: '2', turn: 2, attempt: 0, status: 'error'}),
            rec({id: '3', turn: 2, attempt: 1}),
        ])
        const conv = t.timeline[0]
        expect(conv.kind).toBe('conversation')
        const turns = conv.children!
        expect(turns.map(n => n.turn)).toEqual([1, 2])
        expect(turns[1].children!.map(c => c.record!.attempt)).toEqual([0, 1])
    })
    it('summary 按 provider×model 聚合，含 p95', () => {
        const s = foldRecords([
            rec({id: '1', provider: 'A', model: 'm1', totalMs: 100}),
            rec({id: '2', provider: 'A', model: 'm1', totalMs: 900, status: 'error'}),
        ]).summary
        expect(s[0]).toMatchObject({provider: 'A', model: 'm1', calls: 2, errors: 1})
        expect(s[0].avgTotalMs).toBe(500)
    })
})

describe('computeTokens', () => {
    it('从 res.raw 解析并汇总', async () => {
        const sse = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
        const tokens = await computeTokens(
            [rec({id: '1', resFile: '1.res.raw'}), rec({id: '2', status: 'error'})],
            async r => r.id === '1' ? sse : null,
        )
        expect(tokens).toEqual([{provider: 'p', model: 'm',
            inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0}])
    })
})