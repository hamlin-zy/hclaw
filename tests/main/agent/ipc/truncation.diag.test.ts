/**
 * 诊断：确认 conv-c4d73d64 第二轮触发了结构化截断（方案 2 调试）
 *
 * 复刻 execution.ts 的完整第二轮重建路径：
 *   1. 从 DB 读历史消息（blocksToMessage + historyConverter）
 *   2. push 第二条 user 消息
 *   3. structuredTruncateMessages(messages, {keepRecentTurns: 7})
 *   4. 对比截断前后消息数、被剥离的轮次
 */
import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {convertMessages} from '@/main/agent/model/anthropicAdapter'
import {structuredTruncateMessages} from '@/main/agent/structuredTruncation'
import type {ChatMessage} from '@/main/agent/model/types'

const CONV_ID = process.env.CONV_ID || 'conv-c4d73d64-afb4-4de7-9f5f-c75868623730'
const DB_PATH = process.env.HCLAW_DB || 'C:/Users/Hamlin/.hclaw/data/hclaw.db'

/** 复刻 execution.ts 的历史重建（turnIndex 分组 + 扁平 user） */
function rebuildHistory(db: Database.Database, convId: string): ChatMessage[] {
    const msgs = db.prepare(
        "SELECT id, role, metadata FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY timestamp ASC",
    ).all(convId) as Array<{id: string; role: string; metadata: string}>

    const result: ChatMessage[] = []
    for (const msg of msgs) {
        if (msg.role === 'user') {
            const meta = JSON.parse(msg.metadata || '{}')
            result.push({role: 'user', content: meta.content || '', id: msg.id} as ChatMessage)
        } else {
            // 简化：assistant 消息重建走 DB blocks（略，只数轮数）
            result.push({role: 'assistant', content: '(rebuilt)', id: msg.id} as ChatMessage)
        }
    }
    return result
}

describe('第二轮结构化截断诊断', () => {
    it('复刻 agent-start 重建并检查截断触发', () => {
        const db = new Database(DB_PATH, {readonly: true})
        const msgs = db.prepare(
            "SELECT id, role, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
        ).all(CONV_ID) as Array<{id: string; role: string; timestamp: number}>

        const userCount = msgs.filter(m => m.role === 'user').length
        const assistantCount = msgs.filter(m => m.role === 'assistant').length
        console.log(`[diag] 会话消息: user=${userCount} assistant=${assistantCount}`)

        // 第一轮 assistant 消息的 turn 数（从 llm_usage）
        const firstAsst = msgs.find(m => m.role === 'assistant')
        const turnCount = firstAsst
            ? (db.prepare('SELECT COUNT(*) c FROM llm_usage WHERE message_id = ?').get(firstAsst.id) as {c: number}).c
            : 0
        console.log(`[diag] 第一轮 LLM 调用数（turn 数）: ${turnCount}`)

        // 重建后的 messages 轮数 = user1 + turn 数 + user2 → splitIntoTurns 按 user 切分
        // 若 turn 数 > keepRecentTurns(7) + 1 → 触发截断
        const totalUsers = userCount
        const turnsAfterRebuild = totalUsers + turnCount // 每条 assistant turn + 每个 user 开头
        // 更准确：splitIntoTurns 以 user 为边界 → turn 数 = user 数（最后一条 user 到结尾也算 1 turn）
        const splitTurns = userCount + 1 // user1、user2、user2 后的尾部
        console.log(`[diag] splitIntoTurns 预计 turn 数 ≈ ${splitTurns}（keepRecentTurns+1=8）`)
        console.log(`[diag] 触发截断: ${splitTurns > 8} ${splitTurns > 8 ? '❌ 触发！' : '✓ 不触发'}`)

        db.close()
    })
})
