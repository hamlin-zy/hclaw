import {describe, expect, it} from 'vitest'
import {computeTokenTiming, isTokenDelta} from '@/main/agent/loop/tokenTiming'

describe('isTokenDelta（首 token 边界）', () => {
    it('非空 text 是 token delta', () => {
        expect(isTokenDelta({type: 'text', content: 'hi'})).toBe(true)
    })
    it('空 text 不是 token delta', () => {
        expect(isTokenDelta({type: 'text', content: ''})).toBe(false)
    })
    it('非空 thinking / reasoning 是 token delta', () => {
        expect(isTokenDelta({type: 'thinking', content: 'x'})).toBe(true)
        expect(isTokenDelta({type: 'reasoning', content: 'x'})).toBe(true)
    })
    it('空 thinking 不是 token delta', () => {
        expect(isTokenDelta({type: 'thinking', content: ''})).toBe(false)
    })
    it('tool_use 不作为首 token 边界（OpenAI 系在流末 flush，计为边界会虚短 decodeMs 爆表）', () => {
        expect(isTokenDelta({type: 'tool_use', id: '1', name: 'bash', input: {}})).toBe(false)
    })
    it('usage / done / error / thinking_signature 不是 token delta', () => {
        expect(isTokenDelta({type: 'usage', inputTokens: 1, outputTokens: 1})).toBe(false)
        expect(isTokenDelta({type: 'done', stopReason: 'end_turn'})).toBe(false)
        expect(isTokenDelta({type: 'error', error: new Error('x')})).toBe(false)
        expect(isTokenDelta({type: 'thinking_signature', signature: 's'})).toBe(false)
    })
})

describe('computeTokenTiming（时序与速率计算）', () => {
    it('正确计算 ttftMs / decodeMs / tokensPerSecond', () => {
        const r = computeTokenTiming(1000, 1800, 6800, 200)
        expect(r.ttftMs).toBe(800)          // 1800 - 1000
        expect(r.decodeMs).toBe(5000)        // 6800 - 1800
        expect(r.tokensPerSecond).toBe(40)   // 200 / 5s
    })
    it('decodeMs <= 0 时 tokensPerSecond = 0', () => {
        const r = computeTokenTiming(1000, 2000, 2000, 100)
        expect(r.decodeMs).toBe(0)
        expect(r.tokensPerSecond).toBe(0)
    })
    it('负时长 clamp 到 0', () => {
        const r = computeTokenTiming(2000, 1000, 1000, 100)
        expect(r.ttftMs).toBe(0)
        expect(r.decodeMs).toBe(0)
    })
    it('decodeMs 过短（<500ms）时按 500ms 保守下限计算吞吐，防止首 token 边界虚短导致 t/s 爆表', () => {
        // 真实案例：DB 中 decode_ms=1 但 output_tokens=759 → 理论 759000 t/s
        const r = computeTokenTiming(0, 1, 2, 759)
        expect(r.decodeMs).toBe(1)            // 原始时长不变（数据层口径）
        expect(r.tokensPerSecond).toBe(1518)  // 759 / 0.5s，封顶后不再爆表
    })
    it('decodeMs >= 500ms 时正常计算', () => {
        const r = computeTokenTiming(0, 100, 5000, 200)
        expect(r.decodeMs).toBe(4900)
        expect(r.tokensPerSecond).toBe(200 / 4.9)
    })
})
