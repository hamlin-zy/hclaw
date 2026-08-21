/**
 * conversationRepository.readUsageRaw 双源合并（历史 llm_stats 列 + 新 llm_usage 表） 单元测试（Task 6）
 *
 * 覆盖：
 * - 历史 llm_stats + 新 llm_usage 合并返回统一 LlmStats[]
 * - 仅有历史 → 只返回 llm_stats 数据
 * - 仅有新数据 → 只返回 llm_usage 数据
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-dual-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'
import type {Message} from '@shared/types'

let repo: SqliteConversationRepository
let db: ReturnType<typeof getDatabase>

beforeEach(() => {
    repo = new SqliteConversationRepository()
    db = getDatabase()
    // 每个用例独立表结构：DROP 后重建，避免跨用例数据残留（含 llm_usage 表）
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
})

afterEach(() => { closeDatabase() })

describe('readUsageRaw — 双源合并（历史 llm_stats + 新 llm_usage）', () => {
    it('历史 llm_stats + 新 llm_usage 合并返回统一 LlmStats[]', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1,
                JSON.stringify([{inputTokens: 100, outputTokens: 20, provider: '方案A', model: 'old-model', duration: 10}]))
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, provider_name, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('usage_new', 'conv-1', 'm-new', 'anthropic', 'Deepseek-ant', 'claude-sonnet-4', 50, 10, 100, 2)

        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        const list = llmStatsByConv.get('conv-1') ?? []
        expect(list).toHaveLength(2)
        // 历史：provider 脏值「方案A」的 model('old-model') 与 llm_usage 的 model('claude-sonnet-4') 不同，
        //       归一化不命中 → 保留原值（历史数据未被篡改）
        expect(list[0]!.provider).toBe('方案A')
        // 新：provider 精确
        expect(list[1]!.provider).toBe('anthropic')
        expect(list[1]!.providerName).toBe('Deepseek-ant')
        expect(list[1]!.model).toBe('claude-sonnet-4')
        expect(list[1]!.inputTokens).toBe(50)
        expect(list[1]!.duration).toBe(100)
        // 归一化命中语义：若 llm_usage 中存在与历史同 model 的行，则该行 provider 会被映射覆盖（见下方专门用例）
    })

    it('仅有历史 → 只返回 llm_stats 数据', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1, JSON.stringify([{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'm', duration: 1}]))
        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        expect(llmStatsByConv.get('conv-1')).toHaveLength(1)
    })

    it('仅有新数据 → 只返回 llm_usage 数据', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u1', 'conv-1', 'm1', 'openai', 'gpt-4o', 5, 1, 10, 2)
        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        expect(llmStatsByConv.get('conv-1')).toHaveLength(1)
        expect(llmStatsByConv.get('conv-1')![0]!.provider).toBe('openai')
        expect(llmStatsByConv.get('conv-1')![0]!.providerName).toBeUndefined()
    })

    it('llm_usage 历史行 provider_name 为 NULL → 同 model+provider_type 非 NULL 值兜底', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        // 同 model+provider_type 两条：一条 provider_name 为 NULL（加列前历史），一条 'Deepseek-ant'
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, provider_name, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u1', 'conv-1', 'm1', 'anthropic', 'deepseek-v4-flash', null, 5, 1, 10, 2)
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, provider_name, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u2', 'conv-1', 'm2', 'anthropic', 'deepseek-v4-flash', 'Deepseek-ant', 6, 1, 10, 3)

        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        const list = llmStatsByConv.get('conv-1') ?? []
        expect(list).toHaveLength(2)
        // 两条读回 providerName 均 'Deepseek-ant'（NULL 行按同组非 NULL 值兜底）
        expect(list[0]!.providerName).toBe('Deepseek-ant')
        expect(list[1]!.providerName).toBe('Deepseek-ant')
    })

    it('历史脏 provider（方案名）被 llm_usage 精确映射归一化', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        // 历史消息：provider 为方案名「mm&dp」，model 与 llm_usage 行一致
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1,
                JSON.stringify([{inputTokens: 100, outputTokens: 20, provider: 'mm&dp', model: 'deepseek-v4-flash', duration: 10}]))
        // llm_usage 行：同一 model 的精确 provider 归属
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u1', 'conv-1', 'm-hist', 'anthropic', 'deepseek-v4-flash', 50, 10, 100, 2)

        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        const list = llmStatsByConv.get('conv-1') ?? []
        expect(list).toHaveLength(2)
        // 历史行：脏 provider 被归一化为精确类型，model 保持原值
        expect(list[0]!.provider).toBe('anthropic')
        expect(list[0]!.model).toBe('deepseek-v4-flash')
        expect(list[0]!.inputTokens).toBe(100)
    })

    it('历史脏 provider 且 model 无 llm_usage 记录 → 保持原值不猜', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        // 只有历史消息，model 无任何 llm_usage 行可对照
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1,
                JSON.stringify([{inputTokens: 1, outputTokens: 1, provider: 'mm&dp', model: 'MiniMax-M2.7', duration: 1}]))

        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        const list = llmStatsByConv.get('conv-1') ?? []
        expect(list).toHaveLength(1)
        expect(list[0]!.provider).toBe('mm&dp')
        expect(list[0]!.model).toBe('MiniMax-M2.7')
    })

    it('历史已是精确 provider（anthropic）→ 不被覆盖', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        // 历史消息：provider 已是精确值 anthropic
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1,
                JSON.stringify([{inputTokens: 100, outputTokens: 20, provider: 'anthropic', model: 'claude-sonnet-4', duration: 10}]))
        // llm_usage 同 model 但归属 openai（异常场景，防御测试）
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u1', 'conv-1', 'm-hist', 'openai', 'claude-sonnet-4', 5, 1, 10, 2)

        const {llmStatsByConv} = repo.readUsageRaw(['conv-1'])
        const list = llmStatsByConv.get('conv-1') ?? []
        expect(list).toHaveLength(2)
        // 已是已知 ProviderType → KNOWN_PROVIDERS 防御，不被 llm_usage 覆盖
        expect(list[0]!.provider).toBe('anthropic')
        expect(list[1]!.provider).toBe('openai')
    })
})

describe('readMessages — B1 消息加载组装 Message.llmStats', () => {
    it('新消息（llm_stats 列 NULL）→ 从 llm_usage 按 message_id 组装', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        // 新消息：llm_stats 列保持 NULL（唯一源 = llm_usage）
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-new', 'conv-1', 'assistant', 2, null)
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, ttft_ms, decode_ms, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('usage_new', 'conv-1', 'm-new', 'anthropic', 'claude-sonnet-4', 50, 10, 5, 0, 3, 800, 100, 100, 2)

        const msgs = repo.readMessages('conv-1')
        expect(msgs).toHaveLength(1)
        expect(msgs[0]!.llmStats).toHaveLength(1)
        expect(msgs[0]!.llmStats![0]!.provider).toBe('anthropic')
        expect(msgs[0]!.llmStats![0]!.providerName).toBeUndefined()
        expect(msgs[0]!.llmStats![0]!.model).toBe('claude-sonnet-4')
        expect(msgs[0]!.llmStats![0]!.inputTokens).toBe(50)
        expect(msgs[0]!.llmStats![0]!.duration).toBe(100)
        expect(msgs[0]!.llmStats![0]!.cacheReadTokens).toBe(5)
        expect(msgs[0]!.llmStats![0]!.ttftMs).toBe(800)
        expect(msgs[0]!.llmStats![0]!.decodeMs).toBe(100)
    })

    it('历史消息（llm_stats 列有值）→ llm_usage 数据追加在历史之后', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        // 历史消息：llm_stats 列有旧数据（provider 为脏值「方案A」）
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1,
                JSON.stringify([{inputTokens: 100, outputTokens: 20, provider: '方案A', model: 'old-model', duration: 10}]))
        // 同一消息另有 llm_usage 新数据（崩溃恢复后补写的调用）
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u1', 'conv-1', 'm-hist', 'openai', 'gpt-4o', 5, 1, 10, 2)

        const msgs = repo.readMessages('conv-1')
        expect(msgs[0]!.llmStats).toHaveLength(2)
        // 历史在前
        expect(msgs[0]!.llmStats![0]!.provider).toBe('方案A')
        // llm_usage 新数据在后（provider 精确）
        expect(msgs[0]!.llmStats![1]!.provider).toBe('openai')
    })

    it('无 llm_usage 行 → 保持原样（历史消息/无调用消息不受影响）', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-hist', 'conv-1', 'assistant', 1, JSON.stringify([{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'm', duration: 1}]))
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-plain', 'conv-1', 'assistant', 2, null)

        const msgs = repo.readMessages('conv-1')
        expect(msgs).toHaveLength(2)
        expect(msgs[0]!.llmStats).toHaveLength(1)
        expect(msgs[1]!.llmStats).toBeUndefined()
    })

    it('readMessagesTail / readMessagesBefore 走同一公共路径', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-new', 'conv-1', 'assistant', 2, null)
        db.prepare('INSERT INTO llm_usage (id, conversation_id, message_id, provider_type, model, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('u1', 'conv-1', 'm-new', 'anthropic', 'claude-sonnet-4', 50, 10, 100, 2)

        const tail = repo.readMessagesTail('conv-1', 10)
        expect(tail.messages[0]!.llmStats![0]!.provider).toBe('anthropic')

        const before = repo.readMessagesBefore('conv-1', 9999, 10)
        expect(before.messages[0]!.llmStats![0]!.provider).toBe('anthropic')
    })
})

describe('writeMessagesDelta / writeMessages — B1 写侧剥离（llm_stats 不再随消息落库）', () => {
    function seedConv() {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1, 1)
    }

    /** 构造携带 llmStats 的消息（渲染层旧行为/读侧组装数据，模拟双写源头） */
    function makeMsg(overrides: Partial<Message> = {}): Message {
        return {
            id: 'm-1', role: 'assistant', content: 'hello', timestamp: 1,
            llmStats: [{inputTokens: 100, outputTokens: 20, provider: 'anthropic', model: 'deepseek-v4', duration: 500}],
            ...overrides,
        }
    }

    beforeEach(() => {
        seedConv()
    })

    it('writeMessagesDelta：消息携带 llmStats → 不写入 llm_stats 列（llm_usage 唯一源）', () => {
        repo.writeMessagesDelta('conv-1', makeMsg())
        const row = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m-1') as {llm_stats: string | null} | undefined
        expect(row?.llm_stats).toBeNull()
    })

    it('writeMessagesDelta：已有历史 llm_stats 列值 → 保留不被新 llmStats 覆盖', () => {
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-1', 'conv-1', 'assistant', 1, JSON.stringify([{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'm', duration: 1}]))
        repo.writeMessagesDelta('conv-1', makeMsg())
        const row = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m-1') as {llm_stats: string}
        const parsed = JSON.parse(row.llm_stats)
        expect(parsed).toHaveLength(1)
        expect(parsed[0]!.provider).toBe('p')      // 历史值保留
        expect(parsed[0]!.inputTokens).toBe(1)
    })

    it('writeMessages（批量）：消息携带 llmStats → 不写入 llm_stats 列', () => {
        repo.writeMessages('conv-1', [makeMsg()])
        const row = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m-1') as {llm_stats: string | null} | undefined
        expect(row?.llm_stats).toBeNull()
    })

    it('writeMessages（批量）：已有历史 llm_stats 列值 → 保留不被覆盖', () => {
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run('m-1', 'conv-1', 'assistant', 1, JSON.stringify([{inputTokens: 7, outputTokens: 2, provider: 'p', model: 'm', duration: 1}]))
        repo.writeMessages('conv-1', [makeMsg()])
        const row = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m-1') as {llm_stats: string}
        const parsed = JSON.parse(row.llm_stats)
        expect(parsed).toHaveLength(1)
        expect(parsed[0]!.inputTokens).toBe(7)     // 历史值保留
    })
})
