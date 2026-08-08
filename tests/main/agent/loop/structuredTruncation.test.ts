/**
 * structuredTruncation 单元测试
 * v4（2026-12）：工具价值分级 + 中间区间剥离 + keepRecentTurns 7
 */

import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {
    splitIntoTurns,
    structuredTruncateMessages,
} from '../../../../src/main/agent/structuredTruncation'

function makeUserMsg(idx: number, text: string): ChatMessage {
    return {id: `u${idx}`, role: 'user', content: text}
}

function makeAssistantMsg(idx: number, text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
    return {id: `a${idx}`, role: 'assistant', content: text, toolCalls}
}

function makeToolMsg(idx: number, toolCallId: string, content: string): ChatMessage {
    return {id: `t${idx}`, role: 'tool', toolCallId, content, toolResult: content}
}

function makeToolMsgWithError(idx: number, toolCallId: string, content: string, isError: boolean): ChatMessage {
    return {id: `t${idx}`, role: 'tool', toolCallId, content, toolResult: content, isError}
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
        expect(turns[0]).toMatchObject({startIdx: 0, endIdx: 1, hasToolCalls: false, hasHighValueToolCalls: false})
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
        expect(turns[0]).toMatchObject({startIdx: 0, endIdx: 2, hasToolCalls: false, hasHighValueToolCalls: false})
        expect(turns[1]).toMatchObject({startIdx: 2, endIdx: 4, hasToolCalls: false, hasHighValueToolCalls: false})
    })

    it('v4：低价值工具（grep）hasHighValueToolCalls=false', () => {
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1', [{id: 'tc1', name: 'grep', arguments: {}}]),
            makeToolMsg(1, 'tc1', 'result'),
            makeUserMsg(2, 'q2'),
        ]
        const turns = splitIntoTurns(msgs)
        expect(turns[0].hasToolCalls).toBe(true)
        expect(turns[0].hasHighValueToolCalls).toBe(false)
    })

    it('v4：高价值工具（file_read）hasHighValueToolCalls=true', () => {
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1', [{id: 'tc1', name: 'file_read', arguments: {}}]),
            makeToolMsg(1, 'tc1', 'content'),
            makeUserMsg(2, 'q2'),
        ]
        const turns = splitIntoTurns(msgs)
        expect(turns[0].hasToolCalls).toBe(true)
        expect(turns[0].hasHighValueToolCalls).toBe(true)
    })

    it('v4：混合 grep + file_read 的 turn hasHighValueToolCalls=true', () => {
        const msgs = [
            makeUserMsg(1, 'q1'),
            makeAssistantMsg(1, 'a1', [
                {id: 'tc1', name: 'grep', arguments: {}},
                {id: 'tc2', name: 'file_read', arguments: {}},
            ]),
            makeToolMsg(1, 'tc1', 'grep result'),
            makeToolMsg(1, 'tc2', 'file content'),
            makeUserMsg(2, 'q2'),
        ]
        const turns = splitIntoTurns(msgs)
        expect(turns[0].hasToolCalls).toBe(true)
        expect(turns[0].hasHighValueToolCalls).toBe(true)  // file_read 存在
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

    it('v4：总轮数 ≤ keepRecentTurns + 1 → 不丢任何 turn', () => {
        // keepRecentTurns=7 → 8 轮以内不截断
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 8; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 7})
        expect(r.afterCount).toBe(16)
        expect(r.droppedTurns).toBe(0)
    })

    it('v4：默认 keepRecentTurns=7，11 轮时触发截断', () => {
        // 11 turns：firstTurn(1) + recentTurns(5~11) = 8 turns，中间剩 3 个纯文本 turn (2~4)
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 11; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            msgs.push(makeAssistantMsg(i, `a${i}`))
        }
        const r = structuredTruncateMessages(msgs)
        // keepRecentTurns=7 → 保留 turn 1 + turn 5~11 = 8 turns = 16 msgs
        // 中间区间 = turn 2~4（3 turns，全部纯文本被丢）
        expect(r.droppedTurns).toBe(3)
        expect(r.afterCount).toBe(16)   // 8 turns × 2 msgs
    })

    // ─── v4 核心：低价值工具轮丢弃 ───

    it('v4：中间区间仅含低价值工具（grep）的 turn 被丢弃', () => {
        // 11 turns：turn 3 含 bash（高价值），turn 5 含 grep（低价值），其他纯文本
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 11; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 3) {
                msgs.push(makeAssistantMsg(i, `a${i}`, [{id: `tc${i}`, name: 'bash', arguments: {}}]))
                msgs.push(makeToolMsg(i, `tc${i}`, 'bash result'))
            } else if (i === 5) {
                msgs.push(makeAssistantMsg(i, `a${i}`, [{id: `tc${i}`, name: 'grep', arguments: {}}]))
                msgs.push(makeToolMsg(i, `tc${i}`, 'grep result'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs)
        // keepRecentTurns=7 → firstTurn(1) + recent(5~11)
        // 中间区间 = turn 2~4
        //   turn 2: 纯文本 → 丢弃
        //   turn 3: bash（高价值）→ 保留（剥离 assistant 正文）
        //   turn 4: 纯文本 → 丢弃
        // droppedTurns = 2 (turn 2, 4)
        expect(r.droppedTurns).toBe(2)
        // turn 5 是最近 7 轮的一部分 → 完整保留
        expect(r.messages.find(m => m.id === 't5')).toBeDefined()
        expect(r.messages.find(m => m.id === 't5')!.content).toBe('grep result')
    })

    it('v4：中间区间混合轮（grep + bash）剥离低价值 tool 和 assistant 正文', () => {
        // 11 turns：turn 3 含 grep + bash
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 11; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 3) {
                msgs.push(makeAssistantMsg(i, 'assistant reasoning here', [
                    {id: 'tc-grep', name: 'grep', arguments: {}},
                    {id: 'tc-bash', name: 'bash', arguments: {}},
                ]))
                msgs.push(makeToolMsg(3, 'tc-grep', 'grep result'))
                msgs.push(makeToolMsg(3, 'tc-bash', 'bash result'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs)
        // turn 3 在中间区间 → v4 剥离
        const turn3User = r.messages.find(m => m.id === 'u3')
        expect(turn3User).toBeDefined()  // user 消息保留

        // assistant 的 content 被剥离
        const a3 = r.messages.find(m => m.id === 'a3')
        expect(a3?.content).toBe('')  // assistant 正文已剥离

        // grep 的 tool 消息被剥离
        const tGrep = r.messages.find(m => m.id === 't3' && m.toolCallId === 'tc-grep')
        expect(tGrep).toBeUndefined()

        // bash 的 tool 消息保留
        const tBash = r.messages.find(m => m.toolCallId === 'tc-bash')
        expect(tBash).toBeDefined()
        expect(tBash!.content).toBe('bash result')

        // assistant.toolCalls 中 grep 被剔除
        expect(a3?.toolCalls).toBeDefined()
        expect(a3!.toolCalls!.map(tc => tc.id)).not.toContain('tc-grep')
        expect(a3!.toolCalls!.map(tc => tc.id)).toContain('tc-bash')
    })

    it('v4：最近 7 轮不受 v4 剥离影响（assistant 正文和所有 toolCalls 保留）', () => {
        // 11 turns：turn 7（最近 7 轮内）含 grep + bash
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 11; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 7) {
                msgs.push(makeAssistantMsg(7, '完整推理内容', [
                    {id: 'tc-grep', name: 'grep', arguments: {}},
                    {id: 'tc-bash', name: 'bash', arguments: {}},
                ]))
                msgs.push(makeToolMsg(7, 'tc-grep', 'grep result'))
                msgs.push(makeToolMsg(7, 'tc-bash', 'bash result'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs)

        // turn 7 在最近 7 轮 → 完整保留
        const a7 = r.messages.find(m => m.id === 'a7')
        expect(a7?.content).toBe('完整推理内容')  // assistant 正文保留
        expect(a7?.toolCalls).toHaveLength(2)    // 所有 toolCalls 保留

        // grep 的 tool 消息也保留
        const tGrep = r.messages.find(m => m.toolCallId === 'tc-grep')
        expect(tGrep).toBeDefined()
    })

    it('v4：中间区间仅含低价值工具的 turn 丢弃，高价值工具的 turn 剥离后保留', () => {
        // 12 turns（keepRecentTurns=7）：
        //   firstTurn = turn 1
        //   middleTurns = turn 2~5
        //     turn 2: 纯文本 → 丢弃
        //     turn 3: 仅 grep（低价值）→ 丢弃
        //     turn 4: 纯文本 → 丢弃
        //     turn 5: 仅 file_read（高价值）→ 保留，剥离 assistant 正文
        //   recentTurns = turn 6~12
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 3) {
                msgs.push(makeAssistantMsg(3, 'grep reasoning', [{id: 'tc3', name: 'grep', arguments: {}}]))
                msgs.push(makeToolMsg(3, 'tc3', 'grep result'))
            } else if (i === 5) {
                msgs.push(makeAssistantMsg(5, 'file_read reasoning', [{id: 'tc5', name: 'file_read', arguments: {}}]))
                msgs.push(makeToolMsg(5, 'tc5', 'file content'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs)
        // turn 3 被丢（仅低价值，在中间区间）
        expect(r.messages.find(m => m.id === 't3')).toBeUndefined()
        // turn 5 在中间区间 → 保留但剥离 assistant 正文
        expect(r.messages.find(m => m.id === 't5')).toBeDefined()
        const a5 = r.messages.find(m => m.id === 'a5')
        // turn 5 在中间区间 → assistant content 被剥离
        expect(a5?.content).toBe('')
        // file_read 的 tool 消息保留
        expect(r.messages.find(m => m.toolCallId === 'tc5')).toBeDefined()
        // droppedTurns = turn 2,3,4 (3 turns)
        expect(r.droppedTurns).toBe(3)
    })

    // ─── v3 既有行为保持 ───

    it('v3：全失败 tool 的 turn 被识别为纯文本（hasToolCalls=false）', () => {
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
        // 用 keepRecentTurns=10 保留 v3 原始行为
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})
        expect(r.messages.find(m => m.id === 'a2')).toBeUndefined()
    })

    it('v3：混合 turn 含 1 成 1 败 → 失败 tool_use 和 tool_result 都剥离', () => {
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 12; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 2) {
                msgs.push(makeAssistantMsg(2, 'a2', [
                    {id: 'tc-success', name: 'bash', arguments: {}},
                    {id: 'tc-fail', name: 'read', arguments: {}},
                ]))
                msgs.push(makeToolMsg(2, 'tc-success', 'ok'))
                msgs.push(makeToolMsgWithError(2, 'tc-fail', 'fail', true))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})
        expect(r.messages.find(m => m.toolCallId === 'tc-fail')).toBeUndefined()
        expect(r.messages.find(m => m.toolCallId === 'tc-success')).toBeDefined()
    })

    it('保留下来的 messages 时序与原始一致（无乱序）', () => {
        const msgs: ChatMessage[] = []
        for (let i = 1; i <= 15; i++) {
            msgs.push(makeUserMsg(i, `q${i}`))
            if (i === 3) {
                // "read" 不是高价值工具（高价值用 file_read）→ 在中间区间被丢弃
                msgs.push(makeAssistantMsg(i, `a${i}`, [{id: `tc${i}`, name: 'read', arguments: {}}]))
                msgs.push(makeToolMsg(i, `tc${i}`, 'content'))
            } else {
                msgs.push(makeAssistantMsg(i, `a${i}`))
            }
        }
        const r = structuredTruncateMessages(msgs, {keepRecentTurns: 10})

        // firstTurn=1, recentTurn=6~15, middleTurns=2~5全部被丢（含turn3的低价值read）
        // 保留：1,6,7,8,9,10,11,12,13,14,15
        const userNumbers = r.messages
            .filter(m => m.role === 'user')
            .map(m => parseInt((typeof m.content === 'string' ? m.content : '').replace('q', ''), 10))
        expect(userNumbers).toEqual([1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    })
})
