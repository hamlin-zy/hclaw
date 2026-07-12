/**
 * structuredTruncation 单元测试
 */

import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../model/types'
import {
    splitIntoTurns,
    structuredTruncateMessages,
} from './structuredTruncation'

function makeUserMsg(idx: number, text: string): ChatMessage {
    return {id: `u${idx}`, role: 'user', content: text}
}

function makeAssistantMsg(idx: number, text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
    return {id: `a${idx}`, role: 'assistant', content: text, toolCalls}
}

function makeToolMsg(idx: number, toolCallId: string, content: string): ChatMessage {
    return {id: `t${idx}`, role: 'tool', toolCallId, content, toolResult: content}
}

// ─── splitIntoTurns ─────────────────────────────────────

describe('splitIntoTurns', () => {
    it('空数组返回空', () => {
        expect(splitIntoTurns([])).toEqual([])
    })

    it('单 user 消息算一个 turn', () => {
        const msgs = [makeUserMsg(1, 'hi')]
        const turns = splitIntoTurns(msgs)
        expect(turns).toHaveLength(1)
        expect(turns[0]).toEqual({startIdx: 0, endIdx: 1, hasToolCalls: false})
    })

    it('user → assistant → user 切分两个 turn', () => {
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1'),
            makeUserMsg(2, 'q2'),
            makeAssistantMsg(2, 'a2'),
        ]
        const turns = splitIntoTurns(msgs)
        expect(turns).toHaveLength(2)
        expect(turns[0]).toEqual({startIdx: 0, endIdx: 2, hasToolCalls: false})
        expect(turns[1]).toEqual({startIdx: 2, endIdx: 4, hasToolCalls: false})
    })

    it('tool 消息标记 hasToolCalls=true', () => {
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1', [{id: 'tc1', name: 'bash', arguments: {}}]),
            makeToolMsg(1, 'tc1', 'result'),
            makeUserMsg(2, 'q2'),
            makeAssistantMsg(2, 'a2'),
        ]
        const turns = splitIntoTurns(msgs)
        expect(turns).toHaveLength(2)
        expect(turns[0].hasToolCalls).toBe(true)
        expect(turns[1].hasToolCalls).toBe(false)
    })

    it('system 前缀归入第一个 turn', () => {
        const msgs = [
            {id: 's1', role: 'system' as const, content: 'sys'},
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1'),
            makeUserMsg(2, 'q2'),
            makeAssistantMsg(2, 'a2'),
        ]
        const turns = splitIntoTurns(msgs)
        // turn 0 = [0, 3) = system + u1 + a1
        // turn 1 = [3, 5) = u2 + a2
        expect(turns).toHaveLength(2)
        expect(turns[0].endIdx).toBe(3)
        expect(turns[1].endIdx).toBe(5)
    })
})

// ─── structuredTruncateMessages ─────────────────────────

describe('structuredTruncateMessages', () => {
    it('空数组', () => {
        const r = structuredTruncateMessages([])
        expect(r.messages).toEqual([])
        expect(r.afterCount).toBe(0)
    })

    it('总轮数 ≤ keepRecentTurns + 1 → 不丢任何 turn', () => {
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1'),
            makeUserMsg(2, 'q2'),
            makeAssistantMsg(2, 'a2'),
        ]
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})
        expect(r.afterCount).toBe(4)
        expect(r.droppedTurns).toBe(0)
    })

    it('中间纯文本 turn 被丢弃', () => {
        // 12 turns：1 最早 + 10 最近 = 11，中间剩 1 个纯文本 turn
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})

        expect(r.droppedTurns).toBe(1)
        expect(r.afterCount).toBe(22)
        expect(r.messages[0]).toMatchObject({role: 'user', content: 'q1'})
        expect(r.messages[r.messages.length - 1]).toMatchObject({role: 'assistant', content: 'a12'})
    })

    it('中间带 toolCalls 的 turn 整轮保留', () => {
        // 12 turns：turn 5 含 tool call（3 msgs）；其他 turn 2 msgs
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 5) {
                msgs.push(makeAssistantMsg(i, `a${i}`, [{id: `tc${i}`, name: 'bash', arguments: {}}]))
                msgs.push(makeToolMsg(i, `tc${i}`, 'bash result'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})

        expect(r.droppedTurns).toBe(1)
        // turn 1 (2) + turn 3~12（turn 5 是 3 msgs，其他 2 msgs）
        // = 2 + 2 + 2 + 3 + 7*2 = 23
        expect(r.afterCount).toBe(23)

        // 验证 turn 5 的 tool 消息在结果中
        const toolMsgIds = r.messages.filter(m => m.role === 'tool').map(m => m.id)
        expect(toolMsgIds).toContain('t5')

        const a5 = r.messages.find(m => m.id === 'a5')
        expect(a5?.toolCalls?.[0].id).toBe('tc5')
    })

    it('默认 keepRecentTurns=10', () => {
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 13; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = structuredTruncateMessages(msgs)
        // 保留 turn 1 + turn 4~13 = 11 turns = 22 msgs；丢弃 turn 2~3 = 2 turns
        expect(r.droppedTurns).toBe(2)
        expect(r.afterCount).toBe(22)
    })

    it('保留下来的 messages 时序与原始一致（无乱序）', () => {
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 15; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 3) {
                msgs.push(makeAssistantMsg(i, `a${i}`, [{id: `tc${i}`, name: 'read', arguments: {}}]))
                msgs.push(makeToolMsg(i, `tc${i}`, 'content'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})

        // 验证保留 user 消息的 turn 序号（按数字时序）严格递增
        const userNumbers = r.messages
            .filter(m => m.role === 'user')
            .map(m => parseInt((typeof m.content === 'string' ? m.content : '').replace('q', ''), 10))
        expect(userNumbers).toEqual([1, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    })

    // ─── 决策 2026-01-B：排除全失败工具调用的混合轮 ───

    function makeToolMsgWithError(idx: number, toolCallId: string, content: string, isError: boolean): ChatMessage {
        return {id: `t${idx}`, role: 'tool', toolCallId, content, toolResult: content, isError}
    }

    it('全失败 tool 的 turn 被识别为纯文本（hasToolCalls=false）', () => {
        // 12 turns：turn 2 含失败的 toolCall，turn 5 在最近 10 轮内（仍保留），
        // turn 2 在中间可丢区间（应被丢）
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 2) {
                msgs.push(makeAssistantMsg(2, 'a2', [{id: 'tc-fail', name: 'bash', arguments: {}}]))
                msgs.push(makeToolMsgWithError(2, 'tc-fail', 'failed', true))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }

        const turns = splitIntoTurns(msgs)
        // turn 2 应被识别为纯文本（hasToolCalls=false）
        expect(turns[1].hasToolCalls).toBe(false)

        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})
        // turn 2 被丢；保留 firstTurn(turn1) + recentTurns(turn3~12) = 11 turns = 22 msgs
        expect(r.droppedTurns).toBe(1)
        expect(r.afterCount).toBe(22)
        expect(r.messages.find(m => m.id === 'a2')).toBeUndefined()
        expect(r.messages.find(m => m.id === 't2')).toBeUndefined()
    })

    it('混合 turn 含 1 成 1 败 → 失败 tool_use 和 tool_result 都剥离', () => {
        // 12 turns：turn 2 含 2 个 toolCall（一个成功一个失败）
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 2) {
                msgs.push(makeAssistantMsg(2, 'a2', [
                    {id: 'tc-success', name: 'bash', arguments: {}},
                    {id: 'tc-fail', name: 'read', arguments: {}},
                ]))
                msgs.push(makeToolMsg(2, 'tc-success', 'ok'))      // ← 成功
                msgs.push(makeToolMsgWithError(2, 'tc-fail', 'fail', true))  // ← 失败
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }

        const turns = splitIntoTurns(msgs)
        const turn2 = turns[1]
        expect(turn2.hasToolCalls).toBe(true)  // 至少一个成功 ⇒ 不能当纯文本 turn 丢
        // v3 关键：splitIntoTurns 应返回 mixedTurnKept（剥离后的内容）
        expect(turn2.mixedTurnKept).toBeDefined()
        const keptIds = turn2.mixedTurnKept!.map(m => m.id)
        expect(keptIds).not.toContain('t2-fail')  // 失败 tool 消息被剥离

        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})
        // 截断后结果里没有失败的 tool 消息
        expect(r.messages.find(m => m.toolCallId === 'tc-fail')).toBeUndefined()
        // 但成功的 toolCall 配对完整保留
        expect(r.messages.find(m => m.toolCallId === 'tc-success')).toBeDefined()

        const a2 = r.messages.find(m => m.id === 'a2')
        expect(a2?.toolCalls).toBeDefined()
        // assistant.toolCalls 里也剔除了 tc-fail（避免孤立 tool_use）
        expect(a2!.toolCalls!.map(tc => tc.id)).toEqual(['tc-success'])
    })

    it('混合 turn 全部失败 → 当作纯文本轮丢', () => {
        // 12 turns：turn 2 含 1 个失败的 toolCall
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 2) {
                msgs.push(makeAssistantMsg(2, 'a2', [{id: 'tc-fail', name: 'bash', arguments: {}}]))
                msgs.push(makeToolMsgWithError(2, 'tc-fail', 'failed', true))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }

        const turns = splitIntoTurns(msgs)
        const turn2 = turns[1]
        expect(turn2.hasToolCalls).toBe(false)  // 全部失败 ⇒ 当纯文本

        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})
        // turn 2 被丢；保留 firstTurn + 最近 10 轮（turn 3~12）= 11 turns = 22 msgs
        expect(r.droppedTurns).toBe(1)
        expect(r.afterCount).toBe(22)
        // turn 2 的内容不应保留（否则会有孤立 tool_use）
        expect(r.messages.find(m => m.id === 'a2')).toBeUndefined()
        expect(r.messages.find(m => m.id === 't2')).toBeUndefined()
    })

    it('tool 消息存在但无对应 toolCallId 配对 → 不算成功工具调用', () => {
        // turn 含孤立的 tool 消息（不是来自 turn 内 assistant 的 toolCalls）
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1'),
            makeToolMsg(1, 'orphan-id', 'some result'),
            makeUserMsg(2, 'q2'),
            makeAssistantMsg(2, 'a2'),
        ]
        const turns = splitIntoTurns(msgs)
        expect(turns[0].hasToolCalls).toBe(false)  // 孤立 tool 不算成功
        expect(turns[1].hasToolCalls).toBe(false)
    })
})
