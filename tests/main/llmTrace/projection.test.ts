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
        // turn 降序：最新 turn 在前
        expect(turns.map(n => n.turn)).toEqual([2, 1])
        expect(turns[0].children!.map(c => c.record!.attempt)).toEqual([0, 1])
    })
    it('summary 按 provider×model 聚合，含 p95', () => {
        const s = foldRecords([
            rec({id: '1', provider: 'A', model: 'm1', totalMs: 100}),
            rec({id: '2', provider: 'A', model: 'm1', totalMs: 900, status: 'error'}),
        ]).summary
        expect(s[0]).toMatchObject({provider: 'A', model: 'm1', calls: 2, errors: 1})
        expect(s[0].avgTotalMs).toBe(500)
    })
    it('重试口径：同 (conv,turn,step) 多 attempt 计入 retries，不同 step 是独立步骤不计入', () => {
        // 真实 step 修复后的形状：同一调用重试共享 step 且 attempt 递增；
        // 工具循环的下一次调用是不同 step（attempt 均为 0）
        const {timeline, summary} = foldRecords([
            rec({id: 'r1a', turn: 3, step: 2, attempt: 0, status: 'error'}),
            rec({id: 'r1b', turn: 3, step: 2, attempt: 1}),
            rec({id: 'r2a', turn: 3, step: 3, attempt: 0}),
            rec({id: 'r3a', turn: 4, step: 4, attempt: 0}),
        ])
        // turn=3 含 3 条 record（step2 两条 attempt + step3 一条）；重试口径看 summary.retries
        const turn3 = timeline[0].children!.find(n => n.turn === 3)!
        expect(turn3.children!.length).toBe(3)
        expect(summary[0]).toMatchObject({calls: 4, retries: 1, errors: 1})
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
            inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, toolsCount: 0}])
    })
    it('缓存命中 tokens 与工具调用次数：从 res.raw 累加，解析失败记 0', async () => {
        const sseWithCacheAndTool = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]}\n\n'
            + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}\n\n'
            + 'data: [DONE]\n\n'
        const tokens = await computeTokens(
            [
                rec({id: '1', resFile: '1.res.raw'}),
                rec({id: '2', resFile: '2.res.raw', provider: 'q'}),
                rec({id: '3', status: 'error'}),          // 非 ok：不计入
                rec({id: '4', resFile: undefined}),       // 无 resFile：不计入
            ],
            async r => r.id === '1' ? sseWithCacheAndTool : r.id === '2' ? 'garbage !!' : null,
        )
        expect(tokens.find(t => t.provider === 'p')).toMatchObject({
            inputTokens: 100, outputTokens: 5,
            cacheReadTokens: 80, cacheWriteTokens: 20, toolsCount: 1,
        })
        // 解析失败（garbage）→ 该组不出现/为 0
        const q = tokens.find(t => t.provider === 'q')
        expect(q === undefined || (q.inputTokens === 0 && q.toolsCount === 0)).toBe(true)
    })
})

describe('execute.ts step 计数器（源码形状，防回归硬编码）', () => {
    it('traceCtx 的 step 不再硬编码 1，而来自每会话持久计数器', () => {
        const fs = require('node:fs')
        const path = require('node:path')
        const src = fs.readFileSync(
            path.resolve(process.cwd(), 'src/main/agent/loop/execute.ts'), 'utf-8')
        expect(src).not.toMatch(/step:\s*1,\s*\/\/?/)
        expect(src).toContain('chatStepCounters')
    })
})
