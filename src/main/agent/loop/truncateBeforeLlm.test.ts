/**
 * truncateForLlmCall 单元测试
 *
 * v4（2026-12）：移除 token 预算门，仅按轮数判断。
 */

import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../model/types'
import {truncateForLlmCall} from './truncateBeforeLlm'

function makeUserMsg(idx: number, text: string): ChatMessage {
    return {id: `u${idx}`, role: 'user', content: text}
}
function makeAssistantMsg(idx: number, text: string): ChatMessage {
    return {id: `a${idx}`, role: 'assistant', content: text}
}

describe('truncateForLlmCall', () => {
    it('空数组 → passthrough', () => {
        const r = truncateForLlmCall({messages: []})
        expect(r.action).toBe('passthrough')
        expect(r.messages).toEqual([])
    })

    it('轮数 ≤ keepRecentTurns+1 → passthrough', () => {
        // 8 turns = 16 msgs ≤ 7+1 → passthrough
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 8; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = truncateForLlmCall({messages: msgs})
        expect(r.action).toBe('passthrough')
        expect(r.messages.length).toBe(16)
    })

    it('轮数 > keepRecentTurns+1 → structured_truncate', () => {
        // 10 turns > 7+1 → 触发截断
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 10; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = truncateForLlmCall({messages: msgs})
        expect(r.action).toBe('structured_truncate')
        expect(r.messages.length).toBeLessThan(msgs.length)
    })

    it('自定义 keepRecentTurns 生效', () => {
        // 10 turns, keepRecentTurns=10 → 10 ≤ 10+1 → passthrough
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 10; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = truncateForLlmCall({messages: msgs, keepRecentTurns: 10})
        expect(r.action).toBe('passthrough')
    })
})
