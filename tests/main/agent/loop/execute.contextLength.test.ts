import {describe, it, expect} from 'vitest'
import {shouldRetryAttempt} from '../../../../src/main/agent/loop/execute'
import {isNonRetryableError} from '../../../../src/main/agent/common/errorClassifier'

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

describe('shouldRetryAttempt (内容风控类错误立即中断不重试 2026-09-21)', () => {
    it('DeepSeek "Content Exists Risk"（响应体风格）不重试', () => {
        const error = {
            message: '400 Content Exists Risk',
            response: {data: {error: {message: 'Content Exists Risk', type: 'invalid_request_error'}}}
        }
        expect(isNonRetryableError(error)).toBe(true)
        expect(shouldRetryAttempt(error, false, true)).toBe(false)
    })
    it('Azure "content_filter" 不重试', () => {
        const error = {
            message: '400 content_filter',
            response: {data: {error: {message: 'The response was filtered due to content_filter'}}}
        }
        expect(isNonRetryableError(error)).toBe(true)
        expect(shouldRetryAttempt(error, false, false)).toBe(false)
    })
    it('OpenAI "content policy" 不重试', () => {
        const error = {
            message: '400 content policy violation',
            response: {data: {error: {message: 'violates content policy'}}}
        }
        expect(isNonRetryableError(error)).toBe(true)
        expect(shouldRetryAttempt(error, false, true)).toBe(false)
    })
    it('SDK 顶层 error.message 风格（无 response 包装）也命中', () => {
        const error = {message: '400 Bad Request: Content Exists Risk'}
        expect(isNonRetryableError(error)).toBe(true)
        expect(shouldRetryAttempt(error, false, false)).toBe(false)
    })
    it('大小写不敏感', () => {
        const error = {message: 'CONTENT EXISTS RISK'}
        expect(isNonRetryableError(error)).toBe(true)
    })
    it('非风控错误不误匹配', () => {
        expect(isNonRetryableError({message: 'rate limit exceeded'})).toBe(false)
        expect(isNonRetryableError({message: 'context length exceeded'})).toBe(false)
        expect(isNonRetryableError({message: 'Worker error'})).toBe(false)
        expect(isNonRetryableError({message: 'bad request'})).toBe(false)
        expect(isNonRetryableError(null)).toBe(false)
        expect(isNonRetryableError(undefined)).toBe(false)
    })
})
