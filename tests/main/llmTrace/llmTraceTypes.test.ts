import {describe, it, expect} from 'vitest'
import {sanitizeHeaders} from '@shared/types/llmTrace'

describe('sanitizeHeaders', () => {
    it('脱敏 authorization（大小写变体）', () => {
        const out = sanitizeHeaders({'Authorization': 'Bearer sk-abc', 'authorization': 'Bearer sk-def'})
        expect(out['Authorization']).toBe('***REDACTED***')
        expect(out['authorization']).toBe('***REDACTED***')
    })
    it('脱敏各家 API key 键与 cookie', () => {
        const out = sanitizeHeaders({'x-api-key': 'k', 'api-key': 'k', 'X-Goog-Api-Key': 'k', 'Cookie': 'c'})
        expect(Object.values(out).every(v => v === '***REDACTED***')).toBe(true)
    })
    it('普通头保留原值', () => {
        const out = sanitizeHeaders({'Content-Type': 'application/json'})
        expect(out['Content-Type']).toBe('application/json')
    })
})