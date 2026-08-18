/**
 * 缓存一致性回放诊断（v2）— 逐轮 token 校准定位不一致点（方案 2 调试）
 *
 * 校准模型（DeepSeek 前缀缓存语义）：
 *   第 n 次调用发送 = system + user + [轮0 assistant+tool] + ... + [轮 n-1 assistant+tool]
 *   其中前 n-1 轮内容已缓存（cache_read），第 n-1 轮刚生成的内容未命中（input_tokens）
 *   ⇒ input_tokens[n] ≈ 第 n-1 轮的「assistant 输出 + tool 消息」token 数（n>=1）
 *   ⇒ 逐轮对比：重建第 k 轮消息的估算 token 应 ≈ input_tokens[k+1]
 *
 * 使用方法（诊断用，非 CI 常规测试）：
 *   CONV_ID=... npx vitest run tests/main/agent/ipc/cacheReplay.verify.test.ts
 */
import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {convertMessages} from '@/main/agent/model/anthropicAdapter'
import type {ChatMessage} from '@/main/agent/model/types'

const CONV_ID = process.env.CONV_ID || 'conv-c4d73d64-afb4-4de7-9f5f-c75868623730'
const DB_PATH = process.env.HCLAW_DB || 'C:/Users/Hamlin/.hclaw/data/hclaw.db'

/** 粗略 token 估算（中文≈1/字，其他≈3.5字符/token；仅定位数量级错位） */
function estTokens(text: string): number {
    if (!text) return 0
    const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
    return cjk + Math.ceil((text.length - cjk) / 3.5)
}

/** 复刻 blocksToMessage + historyConverter（turnIndex 分组）完整重建路径，返回逐轮消息组 */
function rebuildPerTurn(
    db: Database.Database,
    msgId: string,
): { turns: Array<{assistant: ChatMessage; tools: ChatMessage[]; estTokens: number}> } {
    const blocks = db.prepare(
        'SELECT id, block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence',
    ).all(msgId) as Array<Record<string, unknown>>

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

    const groups = new Map<number, Array<Record<string, unknown>>>()
    let lastTurn: number | null = null
    let hasTurn = false
    for (const cb of contentBlocks) {
        const t = cb.turnIndex as number | undefined
        if (typeof t === 'number') {
            hasTurn = true
            lastTurn = t
            if (!groups.has(t)) groups.set(t, [])
            groups.get(t)!.push(cb)
        } else if (lastTurn !== null && hasTurn) {
            groups.get(lastTurn)!.push(cb)
        }
    }

    const turns: Array<{assistant: ChatMessage; tools: ChatMessage[]; estTokens: number}> = []
    const emitTurn = (reasoning: string, content: string, toolCalls: Array<Record<string, unknown>>) => {
        const assistant: ChatMessage = {
            role: 'assistant',
            content,
            reasoningContent: reasoning || undefined,
            toolCalls: toolCalls.map(tc => ({
                id: tc.id as string,
                name: tc.name as string,
                arguments: (tc.arguments || tc.input || {}) as Record<string, unknown>,
            })),
        } as ChatMessage
        const tools: ChatMessage[] = []
        for (const tc of toolCalls) {
            const raw = tc.result as {toolResult?: string; output?: unknown} | string | null | undefined
            let toolResult = ''
            if (raw && typeof raw === 'object' && raw.toolResult) toolResult = raw.toolResult
            else if (raw && typeof raw === 'object' && raw.output) toolResult = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output)
            else if (typeof raw === 'string') toolResult = raw
            tools.push({
                role: 'tool',
                content: '',
                toolCallId: tc.id as string,
                toolResult,
                isError: (raw === null || raw === undefined),
                functionName: tc.name as string,
            } as ChatMessage)
        }
        const est = estTokens(reasoning + content) + tools.reduce((s, t) => s + estTokens(t.toolResult || ''), 0)
        turns.push({assistant, tools, estTokens: est})
    }

    const turnKeys = [...groups.keys()].sort((a, b) => a - b)
    for (const turn of turnKeys) {
        const seg: {reasoning: string; contentParts: string[]; toolCalls: Array<Record<string, unknown>>} = {reasoning: '', contentParts: [], toolCalls: []}
        for (const cb of groups.get(turn)!) {
            if (cb.type === 'think') { if ((cb.thinkBlock as {content?: string})?.content) seg.reasoning += (cb.thinkBlock as {content: string}).content }
            else if (cb.type === 'text') { if (cb.text) seg.contentParts.push(cb.text as string) }
            else if (cb.type === 'tool_use') { if (cb.toolCall) seg.toolCalls.push(cb.toolCall as Record<string, unknown>) }
        }
        if (!seg.reasoning && seg.contentParts.length === 0 && seg.toolCalls.length === 0) continue
        emitTurn(seg.reasoning, seg.contentParts.join(''), seg.toolCalls)
    }
    return {turns}
}

describe('缓存一致性回放诊断 v2（逐轮校准）', () => {
    it('逐轮对比：重建每轮 token 估算 vs llm_usage input_tokens', () => {
        const db = new Database(DB_PATH, {readonly: true})
        const asstMsg = db.prepare(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1",
        ).get(CONV_ID) as {id: string} | undefined
        expect(asstMsg, '会话无 assistant 消息').toBeDefined()

        const {turns} = rebuildPerTurn(db, asstMsg!.id)
        console.log(`[diag] 重建轮数=${turns.length}`)

        const usage = db.prepare(
            'SELECT ROW_NUMBER() OVER (ORDER BY created_at) - 1 AS seq, input_tokens, cache_read_tokens, output_tokens, reasoning_tokens FROM llm_usage WHERE message_id = ? ORDER BY created_at',
        ).all(asstMsg!.id) as Array<{seq: number; input_tokens: number; cache_read_tokens: number; output_tokens: number; reasoning_tokens: number}>
        console.log(`[diag] llm_usage 调用数=${usage.length}`)

        // 逐轮对比：重建第 k 轮估算 vs 实际 input[k+1]（k>=0）
        // 第一轮 input[0] 包含 user 消息，单独处理
        const mismatchTurns: number[] = []
        for (let k = 0; k < turns.length; k++) {
            const est = turns[k].estTokens
            const actual = usage[k + 1]?.input_tokens
            if (actual === undefined) {
                console.log(`[diag] 轮${k}: 重建估算=${est}，无对应 input（轮数超调用数）⚠️`)
                mismatchTurns.push(k)
                continue
            }
            const ratio = est / actual
            const flag = ratio < 0.5 || ratio > 2 ? ' ❌错位' : (ratio < 0.7 || ratio > 1.5 ? ' ⚠️偏差' : ' ✓')
            console.log(`[diag] 轮${k}: 重建估算=${est} vs input[${k + 1}]=${actual} ratio=${ratio.toFixed(2)}${flag}`)
            if (ratio < 0.5 || ratio > 2) mismatchTurns.push(k)
        }

        // tool 数核对：重建 tool 消息数 vs tool_call 块数
        const toolCount = turns.reduce((s, t) => s + t.tools.length, 0)
        const toolBlocks = db.prepare("SELECT COUNT(*) c FROM message_blocks WHERE message_id = ? AND block_type = 'tool_call'").get(asstMsg!.id) as {c: number}
        console.log(`[diag] 重建 tool 数=${toolCount} vs DB tool_call 块=${toolBlocks.c}`)
        expect(toolCount).toBe(toolBlocks.c)

        // 关键：轮数对齐（方案 2 核心目标）
        expect(turns.length).toBe(usage.length)

        db.close()
    })
})
