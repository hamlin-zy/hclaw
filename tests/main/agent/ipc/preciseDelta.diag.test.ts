/**
 * 精确诊断：每轮真实增量（delta_read 推算）vs 重建序列化字符数
 *
 * 原理：
 *   · delta_read[n] = cache_read[n] - cache_read[n-1] = 第 n 轮新增内容的精确 token 数
 *   · 重建第 n 轮消息的 JSON 序列化字符数应与 delta_read 成正比（同文本）
 *   · 对比第 1 轮的「字符/token 比」作为基线，若后续轮比例漂移 → 内容不同
 *
 * 关键：turns 的 assistant 输出长度（output_tokens）是已知精确值，
 * tool 消息长度未知——用 delta_read 反推。
 */
import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {convertMessages} from '@/main/agent/model/anthropicAdapter'
import type {ChatMessage} from '@/main/agent/model/types'

const CONV_ID = process.env.CONV_ID || 'conv-c4d73d64-afb4-4de7-9f5f-c75868623730'
const DB_PATH = process.env.HCLAW_DB || 'C:/Users/Hamlin/.hclaw/data/hclaw.db'

describe('精确增量诊断', () => {
    it('每轮 delta_read vs 重建序列化长度', () => {
        const db = new Database(DB_PATH, {readonly: true})
        const asst = db.prepare(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1",
        ).get(CONV_ID) as {id: string} | undefined
        expect(asst).toBeDefined()

        const blocks = db.prepare(
            'SELECT id, block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence',
        ).all(asst!.id) as Array<Record<string, unknown>>
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

        // 每轮重建为 ChatMessage（精确序列化）
        const turnMessages: ChatMessage[][] = []
        const turnKeys = [...groups.keys()].sort((a, b) => a - b)
        for (const turn of turnKeys) {
            const turnCbs = groups.get(turn) ?? []
            const seg: {reasoning: string; contentParts: string[]; toolCalls: Array<Record<string, unknown>>} = {reasoning: '', contentParts: [], toolCalls: []}
            for (const cb of turnCbs) {
                const tt = cb.type as string
                if (tt === 'think') { const tb = cb.thinkBlock as {content?: string} | undefined; if (tb?.content) seg.reasoning += tb.content }
                else if (tt === 'text') { const txt = cb.text as string | undefined; if (txt) seg.contentParts.push(txt) }
                else if (tt === 'tool_use') { const tc = cb.toolCall as Record<string, unknown> | undefined; if (tc) seg.toolCalls.push(tc) }
            }
            const turnMsgs: ChatMessage[] = [{
                role: 'assistant',
                content: seg.contentParts.join(''),
                reasoningContent: seg.reasoning || undefined,
                toolCalls: seg.toolCalls.map(tc => ({id: tc.id as string, name: tc.name as string, arguments: (tc.arguments || tc.input || {}) as Record<string, unknown>})),
            } as unknown as ChatMessage]
            for (const tc of seg.toolCalls) {
                const raw = tc.result as {toolResult?: string; output?: unknown} | string | null | undefined
                let tr = ''
                if (raw && typeof raw === 'object' && raw.toolResult) tr = raw.toolResult
                else if (raw && typeof raw === 'object' && raw.output) tr = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output)
                else if (typeof raw === 'string') tr = raw
                turnMsgs.push({role: 'tool', content: '', toolCallId: tc.id as string, toolResult: tr, functionName: tc.name as string} as ChatMessage)
            }
            turnMessages.push(turnMsgs)
        }

        // 精确序列化长度（每轮）
        const serializedLens = turnMessages.map(turn => JSON.stringify(convertMessages(turn, false, true).apiMessages).length)

        // delta_read 推算（精确 token 增量）
        const usage = db.prepare(
            'SELECT ROW_NUMBER() OVER (ORDER BY created_at) - 1 AS seq, input_tokens, cache_read_tokens, output_tokens FROM llm_usage WHERE message_id = ? ORDER BY created_at',
        ).all(asst!.id) as Array<{seq: number; input_tokens: number; cache_read_tokens: number; output_tokens: number}>

        // 第 0 轮 delta = cache_read[0] - system_prompt_est；用 cache_read[1]-cache_read[0] 推轮0
        // 更稳：轮 n 的 delta_read = cache_read[n+1] - cache_read[n]（n>=0），最后一个轮用 input 反推
        console.log('[diag] 轮 | 序列化字符 | delta_read(token) | 字符/token')
        for (let n = 0; n < turnMessages.length; n++) {
            const delta = n < usage.length - 1
                ? usage[n + 1].cache_read_tokens - usage[n].cache_read_tokens
                : usage[n].input_tokens // 最后一轮增量 = 最后 input（含新增）
            const slen = serializedLens[n]
            const ratio = slen / delta
            const flag = n === 0 ? ' (基线)' : (Math.abs(ratio - 1.5) > 1 ? ' ❌漂移' : '')
            console.log(`[diag] 轮${n} | ${slen} | ${delta} | ${ratio.toFixed(2)}${flag}`)
        }

        // 基线 = 第 0 轮 ratio（字符/token 稳定值），后续轮应相近
        const baseline = serializedLens[0] / (usage[1].cache_read_tokens - usage[0].cache_read_tokens)
        let drifted = 0
        for (let n = 1; n < turnMessages.length; n++) {
            const delta = n < usage.length - 1
                ? usage[n + 1].cache_read_tokens - usage[n].cache_read_tokens
                : usage[n].input_tokens
            const ratio = serializedLens[n] / delta
            if (Math.abs(ratio - baseline) / baseline > 0.4) {
                console.log(`[diag] ⚠️ 轮${n} ratio 漂移: ${ratio.toFixed(2)} vs 基线 ${baseline.toFixed(2)}`)
                drifted++
            }
        }
        console.log(`[diag] 漂移轮数: ${drifted}/${turnMessages.length}`)
        db.close()
    })
})
