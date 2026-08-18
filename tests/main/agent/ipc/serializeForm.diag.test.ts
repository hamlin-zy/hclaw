/**
 * 精确诊断：loop 内存态形态 vs DB 重建形态的序列化差异（方案 2 调试）
 *
 * 核心假设：第一轮内部 delta_read ≠ 上轮 input（差 20-50 token/轮），
 * 说明 loop 内存态消息与 DB 重建消息经 anthropicAdapter 序列化后
 * token 数不同——这是第二轮缓存断裂的直接原因。
 *
 * 方法：对每个 turn，构造两种形态的 ChatMessage 并序列化对比。
 */
import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {convertMessages} from '@/main/agent/model/anthropicAdapter'
import type {ChatMessage} from '@/main/agent/model/types'

const CONV_ID = process.env.CONV_ID || 'conv-c4d73d64-afb4-4de7-9f5f-c75868623730'
const DB_PATH = process.env.HCLAW_DB || 'C:/Users/Hamlin/.hclaw/data/hclaw.db'

/** JSON 序列化长度 = token 数近似（同字符集下逐字节可比） */
function jsonLen(v: unknown): number {
    return JSON.stringify(v).length
}

describe('序列化形态对比诊断', () => {
    it('每轮 loop 形态 vs DB 重建形态序列化 token 数', () => {
        const db = new Database(DB_PATH, {readonly: true})
        const asstMsg = db.prepare(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1",
        ).get(CONV_ID) as {id: string} | undefined
        expect(asstMsg).toBeDefined()
        const msgId = asstMsg!.id

        const blocks = db.prepare(
            'SELECT id, block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence',
        ).all(msgId) as Array<Record<string, unknown>>

        // 重建 contentBlocks
        const contentBlocks: Array<Record<string, unknown>> = []
        const toolById = new Map<string, Record<string, unknown>>()
        for (const b of blocks) {
            const type = b.block_type as string
            if (type === 'think') {
                contentBlocks.push({id: b.id, type: 'think', thinkBlock: JSON.parse(b.data as string), turnIndex: b.turn_index})
            } else if (type === 'text') {
                contentBlocks.push({id: b.id, type: 'text', text: b.content, turnIndex: b.turn_index})
            } else if (type === 'tool_call') {
                const tc = JSON.parse(b.data as string)
                toolById.set(tc.id, tc)
                contentBlocks.push({id: b.id, type: 'tool_use', toolCall: tc, turnIndex: b.turn_index})
            } else if (type === 'tool_result') {
                const d = JSON.parse(b.data as string)
                const tc = toolById.get(d.id)
                if (tc) tc.result = d.result
            }
        }

        // 按 turn 分组
        const groups = new Map<number, Array<Record<string, unknown>>>()
        let lastTurn: number | null = null
        for (const cb of contentBlocks) {
            const t = cb.turnIndex as number | undefined
            if (typeof t === 'number') { lastTurn = t; if (!groups.has(t)) groups.set(t, []); groups.get(t)!.push(cb) }
            else if (lastTurn !== null) groups.get(lastTurn)!.push(cb)
        }

        const usage = db.prepare(
            'SELECT ROW_NUMBER() OVER (ORDER BY created_at) - 1 AS seq, input_tokens, cache_read_tokens, output_tokens FROM llm_usage WHERE message_id = ? ORDER BY created_at',
        ).all(msgId) as Array<{seq: number; input_tokens: number; cache_read_tokens: number; output_tokens: number}>

        const turnKeys = [...groups.keys()].sort((a, b) => a - b)
        let prevTotal = 0

        for (let k = 0; k < turnKeys.length; k++) {
            const turn = turnKeys[k]
            const cbs = groups.get(turn)!
            const seg: {reasoning: string; contentParts: string[]; toolCalls: Array<Record<string, unknown>>} = {reasoning: '', contentParts: [], toolCalls: []}
            for (const cb of cbs) {
                if (cb.type === 'think') { if ((cb.thinkBlock as {content?: string})?.content) seg.reasoning += (cb.thinkBlock as {content: string}).content }
                else if (cb.type === 'text') { if (cb.text) seg.contentParts.push(cb.text as string) }
                else if (cb.type === 'tool_use') { if (cb.toolCall) seg.toolCalls.push(cb.toolCall as Record<string, unknown>) }
            }

            // DB 重建形态（historyConverter 输出）：reasoningContent（无 signature）
            const rebuilt: ChatMessage = {
                role: 'assistant',
                content: seg.contentParts.join(''),
                reasoningContent: seg.reasoning || undefined,
                toolCalls: seg.toolCalls.map(tc => ({
                    id: tc.id as string,
                    name: tc.name as string,
                    arguments: (tc.arguments || tc.input || {}) as Record<string, unknown>,
                })),
            } as ChatMessage

            // loop 内存态形态（createAssistantMessage 输出）：thinking + reasoningContent 双字段
            const loopForm: ChatMessage = {
                role: 'assistant',
                content: seg.contentParts.join(''),
                thinking: seg.reasoning || undefined,
                reasoningContent: seg.reasoning || undefined,
                toolCalls: seg.toolCalls.map(tc => ({
                    id: tc.id as string,
                    name: tc.name as string,
                    arguments: (tc.arguments || tc.input || {}) as Record<string, unknown>,
                })),
            } as ChatMessage

            // 序列化（needsCompatNormalization=true 模拟 DeepSeek）
            const {apiMessages: rebuiltApi} = convertMessages([rebuilt], false, true)
            const {apiMessages: loopApi} = convertMessages([loopForm], false, true)

            const rebuiltLen = jsonLen(rebuiltApi)
            const loopLen = jsonLen(loopApi)

            const actual = usage[k]?.input_tokens ?? usage[k - 1]?.input_tokens ?? 0
            const flag = rebuiltLen === loopLen ? ' ✓一致' : ' ❌差异!'
            console.log(`[diag] turn ${turn}: DB重建序列化=${rebuiltLen} | loop形态序列化=${loopLen} | input[${k}]=${actual}${flag}`)
            if (rebuiltLen !== loopLen) {
                console.log('  rebuilt:', JSON.stringify(rebuiltApi).slice(0, 200))
                console.log('  loop   :', JSON.stringify(loopApi).slice(0, 200))
            }
            prevTotal = actual
        }
        db.close()
    })
})
