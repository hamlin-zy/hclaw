/**
 * truncateForLlmCall 单元测试
 */

import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../model/types'
import {truncateForLlmCall} from './truncateBeforeLlm'

function makeUserMsg(idx: number, content: string): ChatMessage {
    return {id: `u${idx}`, role: 'user', content}
}
function makeAssistantMsg(idx: number, content: string, toolCalls?: ChatMessage['toolCalls']): ChatMessage {
    return {id: `a${idx}`, role: 'assistant', content, toolCalls}
}

describe('truncateForLlmCall', () => {
    it('消息总 token ≤ budget → passthrough 不动', () => {
        const msgs: ChatMessage[] = [
            makeUserMsg(1, 'hi'),
            makeAssistantMsg(1, 'hello'),
        ]
        const r = truncateForLlmCall({
            messages: msgs,
            systemPrompt: 'sys',
            modelConfig: {provider: 'openai', model: 'gpt-4o', maxContextTokens: 128000},
            settings: {model: {defaultMaxTokens: 8000}},
        })
        expect(r.action).toBe('passthrough')
        expect(r.messages).toBe(msgs) // 同引用
    })

    it('消息总 token > budget → structured_truncate', () => {
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            const longText = 'A'.repeat(800) // ≈ 200 tokens
            msgs.push(makeUserMsg(i, longText))
            msgs.push(makeAssistantMsg(i, longText + ' reply'))
        }

        // maxContext 4000 + output 8000 → budget = 0 → 强制截断
        const r = truncateForLlmCall({
            messages: msgs,
            systemPrompt: 'sys',
            modelConfig: {provider: 'openai', model: 'gpt-4o', maxContextTokens: 4000},
            settings: {model: {defaultMaxTokens: 8000}},
            reserveBufferTokens: 1000,
        })
        expect(r.action).toBe('structured_truncate')
        expect(r.messages.length).toBeLessThan(msgs.length)
    })

    it('ModelScheme.maxContextTokens 优先于 adapter', () => {
        const msgs = [makeUserMsg(1, 'x'), makeAssistantMsg(1, 'y')]

        const r1 = truncateForLlmCall({
            messages: msgs,
            systemPrompt: 'sys',
            modelConfig: {provider: 'openai', model: 'custom', maxContextTokens: 128000},
            settings: {model: {defaultMaxTokens: 8000}},
            modelScheme: {maxContextTokens: 32000},
        })
        expect(r1.tokenEstimate.budget).toBeLessThan(32000)

        const r2 = truncateForLlmCall({
            messages: msgs,
            systemPrompt: 'sys',
            modelConfig: {provider: 'openai', model: 'custom', maxContextTokens: 128000},
            settings: {model: {defaultMaxTokens: 8000}},
        })
        expect(r2.tokenEstimate.budget).toBeGreaterThan(r1.tokenEstimate.budget)
    })

    it('保留 system prompt + 最早 user + 最近 10 turns', () => {
        const sys = {id: 'sys', role: 'system' as const, content: 'sys prompt'}
        const msgs: ChatMessage[] = [sys]
        for (let i = 1; i <= 15; i++) {
            msgs.push(makeUserMsg(i, 'q'.repeat(500)))
            msgs.push(makeAssistantMsg(i, 'a'.repeat(500)))
        }

        const r = truncateForLlmCall({
            messages: msgs,
            systemPrompt: 'sys',
            modelConfig: {provider: 'openai', model: 'gpt-4o', maxContextTokens: 4000},
            settings: {model: {defaultMaxTokens: 8000}},
        })
        expect(r.action).toBe('structured_truncate')

        expect(r.messages[0].role).toBe('system')
        expect(r.messages.find(m => m.id === 'u1')).toBeDefined()
        expect(r.messages.find(m => m.id === 'u15')).toBeDefined()
        // 中间纯文本 turn 被丢
        expect(r.messages.find(m => m.id === 'u2')).toBeUndefined()
    })
})
