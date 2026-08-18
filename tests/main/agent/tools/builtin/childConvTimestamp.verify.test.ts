/**
 * 子会话消息 timestamp/endedAt 回归测试
 *
 * 修复背景：子会话 assistant 消息最终落库时 timestamp 与 endedAt 被赋值为同一时刻
 * （buildCurrentMessage 每次重建时 timestamp: now + flushAccumulatorMessage final 时 endedAt: now），
 * 导致 UI 气泡右下角 formatDuration(endedAt - timestamp) 恒为 0 秒。
 * 修复：累积器固定 startTime（运行开始时刻），timestamp 不再随落库时刻漂移。
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 下的独立临时目录。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('../../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-timestamp-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../../src/main/repositories/sqlite/conversationRepository'
import {
    createChildConvAccumulator,
    handleChildEvent,
    flushAccumulatorMessage,
    finalizeChildConv,
} from '../../../../../src/main/agent/tools/builtin/childConvMessages'

const CONV_ID = 'conv-timestamp-verify'

describe('子会话消息 timestamp/endedAt 验证', () => {
    let repo: SqliteConversationRepository
    beforeEach(() => {
        repo = new SqliteConversationRepository()
        const db = getDatabase()
        db.exec('DROP TABLE IF EXISTS message_blocks')
        db.exec('DROP TABLE IF EXISTS messages')
        db.exec('DROP TABLE IF EXISTS llm_usage')
        db.exec('DROP TABLE IF EXISTS conversations')
        db.exec(`CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
            timestamp INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, llm_stats TEXT,
            is_partial INTEGER NOT NULL DEFAULT 0
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS message_blocks (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
            content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER, turn_index INTEGER
        )`)
        db.exec(`CREATE TABLE IF NOT EXISTS llm_usage (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
            provider_type TEXT NOT NULL, model TEXT NOT NULL,
            provider_name TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER NOT NULL DEFAULT 0,
            ttft_ms INTEGER, decode_ms INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )`)
        repo.create(CONV_ID, {
            id: CONV_ID,
            title: 'child',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            preview: '',
            status: 'active',
            parentConvId: 'conv-parent',
            isChildSession: true,
            sourceCapability: {type: 'agent', name: 'Implementer Agent'},
            sourceTask: 'task',
            workspacePath: '',
        } as unknown as import('@shared/types').ConversationMeta)
    })
    afterEach(() => {
        closeDatabase()
    })

    it('最终落库后 endedAt - timestamp === 真实运行时长（修复回归验证）', async () => {
        const acc = createChildConvAccumulator(CONV_ID)
        const startMs = acc.startTime

        // 模拟运行 150ms 后产生 llm_call_done（增量落库）
        await new Promise(r => setTimeout(r, 150))
        handleChildEvent(acc, {type: 'text', content: 'hello'})
        handleChildEvent(acc, {type: 'llm_call_done', conversationTitle: 'c', provider: 'p', providerType: 'x', providerName: 'n', model: 'm', duration: 100, inputTokens: 1, outputTokens: 1} as any)
        flushAccumulatorMessage(acc, repo, CONV_ID, false)

        // 再运行 100ms 后结束（最终落库）
        await new Promise(r => setTimeout(r, 100))
        finalizeChildConv(acc, repo, CONV_ID)

        const msgs = repo.readMessages(CONV_ID)
        const assistant = msgs.find(m => m.role === 'assistant')!
        const delta = assistant.endedAt! - assistant.timestamp

        expect(assistant.timestamp).toBe(startMs)          // timestamp 固定为运行开始时刻
        expect(delta).toBeGreaterThanOrEqual(200)          // 至少覆盖 150+100ms
        expect(delta).toBeLessThan(2000)                   // 且不超过合理上界
    })

    it('空累积兜底占位消息的 timestamp 同样固定为运行开始时刻', async () => {
        const acc = createChildConvAccumulator(CONV_ID)
        const startMs = acc.startTime

        await new Promise(r => setTimeout(r, 50))
        finalizeChildConv(acc, repo, CONV_ID)   // 无内容 → 走兜底占位分支

        const msgs = repo.readMessages(CONV_ID)
        const assistant = msgs.find(m => m.role === 'assistant')!
        const delta = assistant.endedAt! - assistant.timestamp

        expect(assistant.timestamp).toBe(startMs)
        expect(delta).toBeGreaterThanOrEqual(50)   // 覆盖运行等待时长
        expect(delta).toBeLessThan(2000)
    })
})
