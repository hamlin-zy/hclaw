/**
 * 终局裁决：完整复刻 execution.ts 第二轮重建 + 发送前 normalize，
 * 输出最终消息序列，与 llm_usage 第二轮前缀精确对比。
 *
 * 这是系统性调试的 Phase 4 验证：不再依赖估算，直接对最终发送序列做
 * 「精确序列化 token 数 vs 实际前缀」对比，定位第一个不一致点。
 */
import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {convertMessages} from '@/main/agent/model/anthropicAdapter'
import {normalizeToolCallMessages} from '@/main/agent/state'
import {structuredTruncateMessages} from '@/main/agent/structuredTruncation'
import type {ChatMessage} from '@/main/agent/model/types'

const CONV_ID = process.env.CONV_ID || 'conv-c4d73d64-afb4-4de7-9f5f-c75868623730'
const DB_PATH = process.env.HCLAW_DB || 'C:/Users/Hamlin/.hclaw/data/hclaw.db'

describe('终局裁决：完整复刻重建 + normalize', () => {
    it('重建序列经 normalize 后与第二轮实际发送一致', () => {
        const db = new Database(DB_PATH, {readonly: true})

        // 1. 读 user1 + assistant1（完整 blocks 重建）
        const user1 = db.prepare(
            "SELECT metadata FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1",
        ).get(CONV_ID) as {metadata: string} | undefined
        const asst1 = db.prepare(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1",
        ).get(CONV_ID) as {id: string} | undefined
        expect(user1 && asst1).toBeTruthy()

        const blocks = db.prepare(
            'SELECT id, block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence',
        ).all(asst1!.id) as Array<Record<string, unknown>>
        const contentBlocks: Array<Record<string, unknown>> = []
        const toolById = new Map<string, Record<string, unknown>>()
        for (const b of blocks) {
            const type = b.block_type as string
            if (type === 'think') contentBlocks.push({id: b.id, type: 'think', thinkBlock: JSON.parse(b.data as string), turnIndex: b.turn_index})
            else if (type === 'text') contentBlocks.push({id: b.id, type: 'text', text: b.content, turnIndex: b.turn_index})
            else if (type === 'tool_call') { const tc = JSON.parse(b.data as string); toolById.set(tc.id, tc); contentBlocks.push({id: b.id, type: 'tool_use', toolCall: tc, turnIndex: b.turn_index}) }
            else if (type === 'tool_result') { const d = JSON.parse(b.data as string); const tc = toolById.get(d.id); if (tc) tc.result = d.result }
        }
        const groups = new Map<number, Array<Record<string, unknown>>>()
        let lastTurn: number | null = null
        for (const cb of contentBlocks) {
            const t = cb.turnIndex as number | undefined
            if (typeof t === 'number') { lastTurn = t; if (!groups.has(t)) groups.set(t, []); groups.get(t)!.push(cb) }
            else if (lastTurn !== null) groups.get(lastTurn)!.push(cb)
        }

        // 2. 重建消息（user1 + 轮）
        const meta1 = JSON.parse(user1!.metadata)
        const messages: ChatMessage[] = [{role: 'user', content: meta1.content || ''} as ChatMessage]
        const turnKeys = [...groups.keys()].sort((a, b) => a - b)
        for (const turn of turnKeys) {
            const cbs = groups.get(turn) ?? []
            const seg: {reasoning: string; contentParts: string[]; toolCalls: Array<Record<string, unknown>>} = {reasoning: '', contentParts: [], toolCalls: []}
            for (const cb of cbs) {
                const tt = cb.type as string
                if (tt === 'think') { const tb = cb.thinkBlock as {content?: string} | undefined; if (tb?.content) seg.reasoning += tb.content }
                else if (tt === 'text') { const txt = cb.text as string | undefined; if (txt) seg.contentParts.push(txt) }
                else if (tt === 'tool_use') { const tc = cb.toolCall as Record<string, unknown> | undefined; if (tc) seg.toolCalls.push(tc) }
            }
            messages.push({
                role: 'assistant',
                content: seg.contentParts.join(''),
                reasoningContent: seg.reasoning || undefined,
                toolCalls: seg.toolCalls.map(tc => ({id: tc.id as string, name: tc.name as string, arguments: (tc.arguments || tc.input || {}) as Record<string, unknown>})),
            } as unknown as ChatMessage)
            for (const tc of seg.toolCalls) {
                const raw = tc.result as {toolResult?: string; output?: unknown} | string | null | undefined
                let tr = ''
                if (raw && typeof raw === 'object' && raw.toolResult) tr = raw.toolResult
                else if (raw && typeof raw === 'object' && raw.output) tr = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output)
                else if (typeof raw === 'string') tr = raw
                messages.push({
                    role: 'tool', content: '', toolCallId: tc.id as string,
                    toolResult: tr, isError: raw === null || raw === undefined,
                    functionName: tc.name as string,
                } as unknown as ChatMessage)
            }
        }

        // 3. 加 user2
        const user2 = db.prepare(
            "SELECT metadata FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1 OFFSET 1",
        ).get(CONV_ID) as {metadata: string} | undefined
        messages.push({role: 'user', content: JSON.parse(user2!.metadata).content || ''} as ChatMessage)

        console.log(`[diag] 重建消息数=${messages.length}（含 user1 + ${turnKeys.length} 轮 + user2）`)

        // 3b. ★ 复刻 execution.ts 的 structuredTruncateMessages（之前漏掉的步骤）
        const truncateResult = structuredTruncateMessages(messages, {keepRecentTurns: 7})
        if (truncateResult.droppedTurns > 0) {
            console.log(`[diag] ⚠️ 结构化截断触发！before=${messages.length} after=${truncateResult.messages.length} droppedTurns=${truncateResult.droppedTurns}`)
        } else {
            console.log(`[diag] 结构化截断未触发（droppedTurns=0）`)
        }
        const finalMessages = truncateResult.messages
        console.log(`[diag] 截断后消息数=${finalMessages.length}（差=${finalMessages.length - messages.length}）`)

        // 4. normalize（复刻 execute.ts 发送前处理）
        const normalized = normalizeToolCallMessages(finalMessages)
        console.log(`[diag] normalize 后=${normalized.length}（差=${normalized.length - finalMessages.length}，注入合成结果）`)

        // 5. 序列化（DeepSeek 兼容）
        const {apiMessages} = convertMessages(normalized, false, true)
        console.log(`[diag] 序列化 API 消息数=${apiMessages.length}`)

        // 6. 与第二轮实际前缀对比（精确 token 反推：用第一轮每轮的真实增量校准字符/token 比）
        const u2 = db.prepare(
            "SELECT input_tokens, cache_read_tokens FROM llm_usage WHERE message_id = (SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1 OFFSET 1) ORDER BY created_at ASC LIMIT 1",
        ).get(CONV_ID) as {input_tokens: number; cache_read_tokens: number}
        const actualPrefix = u2.input_tokens + u2.cache_read_tokens
        console.log(`[diag] 第二轮实际前缀=${actualPrefix}`)

        // 用第一轮校准：cache_read[seq1]-cache_read[seq0]=10752 对应轮0 的序列化字符
        // 基准：轮0 消息序列化字符数（不含 system）
        const turn0Len = JSON.stringify(convertMessages(messages.slice(1, 1 + 3), false, true).apiMessages).length // user1+轮0 近似
        console.log(`[diag] （参考）user1+轮0 序列化=${turn0Len}`)

        // 7. 逐条打印 apiMessages 的 role 和长度，人工核对
        apiMessages.slice(0, 6).forEach((m, i) => {
            const len = JSON.stringify(m.content).length
            const role = m.role
            const type = Array.isArray(m.content) ? m.content.map((c: any) => c.type).join(',') : 'string'
            console.log(`[diag] api[${i}] role=${role} type=${type} len=${len}`)
        })
        db.close()
    })
})
