import {describe, it, expect} from 'vitest'
import {shouldRetryAttempt} from '../../../../src/main/agent/loop/execute'

describe('shouldRetryAttempt (A1 context-length 不重试)', () => {
    it('普通 retryable 错误仍重试', () => {
        expect(shouldRetryAttempt({message: 'rate limit'}, false, true)).toBe(true)
    })
    it('context-length 错误即使 classifier 判 retryable 也不重试', () => {
        expect(shouldRetryAttempt({message: 'context length exceeded'}, true, true)).toBe(false)
    })
    it('非 retryable 错误不重试', () => {
        expect(shouldRetryAttempt({message: 'bad request'}, false, false)).toBe(false)
    })
})
