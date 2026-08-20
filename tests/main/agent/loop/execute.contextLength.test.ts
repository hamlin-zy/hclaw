import {describe, it, expect} from 'vitest'
import {shouldRetryAttempt} from '../../../../src/main/agent/loop/execute'

describe('shouldRetryAttempt (用户策略 2026-08-19: LLM 报错一律重试)', () => {
    it('普通 retryable 错误仍重试', () => {
        expect(shouldRetryAttempt({message: 'rate limit'}, false, true)).toBe(true)
    })
    it('context-length 错误也重试（用户策略：不区分错误类型）', () => {
        expect(shouldRetryAttempt({message: 'context length exceeded'}, true, true)).toBe(true)
        // classifier 判 false 也重试（错误分类不再影响决策）
        expect(shouldRetryAttempt({message: 'context length exceeded'}, true, false)).toBe(true)
    })
    it('非 retryable 错误也重试（用户策略：不区分错误类型）', () => {
        expect(shouldRetryAttempt({message: 'bad request'}, false, false)).toBe(true)
    })
    it('即使 classifier 判定不可重试也重试（OpenRouter worker error 场景）', () => {
        expect(shouldRetryAttempt({message: 'Worker error'}, false, false)).toBe(true)
    })
})
