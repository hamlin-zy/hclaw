/**
 * 终局验证：完整重建第二轮第一次请求的前缀 token，与 llm_usage 实际值对比
 *
 * 目标：确认「重建消息序列 + system prompt」的 token 总数是否 ≈ 75268（第二轮实际）。
 * 若吻合 → 重建正确，问题在服务端缓存或 system prompt 变化；
 * 若偏差 → 重建仍有内容差异。
 */
import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {convertMessages} from '@/main/agent/model/anthropicAdapter'
import type {ChatMessage} from '@/main/agent/model/types'

const CONV_ID = process.env.CONV_ID || 'conv-c4d73d64-afb4-4de7-9f5f-c75868623730'
const DB_PATH = process.env.HCLAW_DB || 'C:/Users/Hamlin/.hclaw/data/hclaw.db'

/** 粗略 token 估算（与 DeepSeek 接近的比例） */
function estTokens(text: string): number {
    if (!text) return 0
    const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
    return cjk + Math.ceil((text.length - cjk) / 3.5)
}

describe('终局：第二轮前缀 token 校准', () => {
    it('重建序列 + system 估算 ≈ 第二轮实际前缀', () => {
        const db = new Database(DB_PATH, {readonly: true})

        // 1. user 消息（第一条含 commandTemplate）
        const user1 = db.prepare(
            "SELECT metadata FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1",
        ).get(CONV_ID) as {metadata: string} | undefined
        expect(user1).toBeDefined()
        const meta1 = JSON.parse(user1!.metadata)
        const user1Content = meta1.content || ''
        const cmdTemplate = meta1.commandTemplate || ''

        // 2. assistant 消息重建（完整 11 轮）
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

        // 3. 重建为 ChatMessage 序列（user1 + 11 轮 assistant/tool）
        const messages: ChatMessage[] = [{role: 'user', content: user1Content} as ChatMessage]
        const turnKeys = [...groups.keys()].sort((a, b) => a - b)
        for (const turn of turnKeys) {
            const seg: {reasoning: string; contentParts: string[]; toolCalls: Array<Record<string, unknown>>} = {reasoning: '', contentParts: [], toolCalls: []}
            for (const cb of groups.get(turn)!) {
                if (cb.type === 'think') { if ((cb.thinkBlock as {content?: string})?.content) seg.reasoning += (cb.thinkBlock as {content: string}).content }
                else if (cb.type === 'text') { if (cb.text) seg.contentParts.push(cb.text as string) }
                else if (cb.type === 'tool_use') { if (cb.toolCall) seg.toolCalls.push(cb.toolCall as Record<string, unknown>) }
            }
            messages.push({
                role: 'assistant',
                content: seg.contentParts.join(''),
                reasoningContent: seg.reasoning || undefined,
                toolCalls: seg.toolCalls.map(tc => ({id: tc.id as string, name: tc.name as string, arguments: (tc.arguments || tc.input || {}) as Record<string, unknown>})),
            } as ChatMessage)
            for (const tc of seg.toolCalls) {
                const raw = tc.result as {toolResult?: string; output?: unknown} | string | null | undefined
                let tr = ''
                if (raw && typeof raw === 'object' && raw.toolResult) tr = raw.toolResult
                else if (raw && typeof raw === 'object' && raw.output) tr = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output)
                else if (typeof raw === 'string') tr = raw
                messages.push({role: 'tool', content: '', toolCallId: tc.id as string, toolResult: tr, functionName: tc.name as string} as ChatMessage)
            }
        }

        // 4. 序列化（含 tool 消息合并进 user）
        const {apiMessages} = convertMessages(messages, false, true)

        // 5. 估算 token：system(cmdTemplate 在 system?) + user1 + 各轮
        // commandTemplate 是否在 system prompt 里？检查：loop 里 commandTemplate 传给 buildSystemPrompt
        // 这里估算两种口径
        const systemEst = estTokens(cmdTemplate) // commandTemplate 作为 system 一部分
        let msgsEst = 0
        for (const m of apiMessages) {
            msgsEst += estTokens(JSON.stringify(m.content))
        }
        const totalWithTemplate = systemEst + msgsEst
        const totalWithout = msgsEst

        console.log(`[diag] 重建消息数=${messages.length} API消息=${apiMessages.length}`)
        console.log(`[diag] user1 content=${user1Content.length}字符 cmdTemplate=${cmdTemplate.length}字符`)
        console.log(`[diag] 估算: 不含template=${totalWithout} 含template=${totalWithTemplate}`)

        // 实际值
        const u2 = db.prepare(
            "SELECT input_tokens, cache_read_tokens FROM llm_usage WHERE message_id = (SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1 OFFSET 1) ORDER BY created_at ASC LIMIT 1",
        ).get(CONV_ID) as {input_tokens: number; cache_read_tokens: number} | undefined
        if (u2) {
            const actualTotal = u2.input_tokens + u2.cache_read_tokens
            console.log(`[diag] 第二轮第一次实际前缀=${actualTotal}`)
            console.log(`[diag] 偏差(含template): ${((totalWithTemplate - actualTotal) / actualTotal * 100).toFixed(1)}%`)
            console.log(`[diag] 偏差(不含template): ${((totalWithout - actualTotal) / actualTotal * 100).toFixed(1)}%`)
        }

        db.close()
    })
})
