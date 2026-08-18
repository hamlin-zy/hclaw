import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-llm-usage-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteLlmUsageRepository} from '../../../../src/main/repositories/sqlite/llmUsageRepository'
import type {LlmUsageRecord} from '@shared/types'

let repo: SqliteLlmUsageRepository
let db: ReturnType<typeof getDatabase>

/** 注入的 mock 价格源：已知模型价格（美元/1M token → 换算成 /token） */
const mockGetMeta = (model: string): {inputPrice: number; outputPrice: number; cacheReadPrice: number} => {
    if (model === 'claude-sonnet-4') return {inputPrice: 3e-6, outputPrice: 15e-6, cacheReadPrice: 0.3e-6}
    if (model === 'claude-opus-4') return {inputPrice: 15e-6, outputPrice: 75e-6, cacheReadPrice: 1.5e-6}
    return {inputPrice: 0, outputPrice: 0, cacheReadPrice: 0}
}

function makeRecord(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
    return {
        id: 'usage_m-1_0',
        conversationId: 'conv-1',
        messageId: 'm-1',
        providerType: 'anthropic',
        providerName: 'Deepseek-ant',
        model: 'claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        ttftMs: 800,
        decodeMs: 5000,
        durationMs: 12345,
        createdAt: 1000,
        ...overrides,
    }
}

beforeEach(() => {
    repo = new SqliteLlmUsageRepository()
    db = getDatabase()
    // 每个用例独立表结构：DROP 后重建（getDatabase 不跑迁移，手动建表）
    db.exec('DROP TABLE IF EXISTS llm_usage')
    db.exec('DROP TABLE IF EXISTS conversations')
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
        provider_type TEXT NOT NULL, model TEXT NOT NULL,
        provider_name TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER, decode_ms INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )`)
    db.exec('CREATE INDEX idx_llm_usage_conv ON llm_usage(conversation_id, created_at)')
    db.exec('CREATE INDEX idx_llm_usage_message ON llm_usage(message_id)')
    db.exec('CREATE INDEX idx_llm_usage_provider_model ON llm_usage(provider_type, model)')
    db.exec('CREATE INDEX idx_llm_usage_created ON llm_usage(created_at)')
})

afterEach(() => {
    closeDatabase()
})

describe('record（写入 + 幂等 + 外键）', () => {
    // enhance() 默认开启 foreign_keys：happy-path 用例需先建 conv-1（FK 用例用不存在的会话验证报错）
    beforeEach(() => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1000, 1000)
    })

    it('单条写入成功，读回字段一致', () => {
        repo.record(makeRecord())
        const row = db.prepare('SELECT * FROM llm_usage WHERE id = ?').get('usage_m-1_0') as Record<string, unknown>
        expect(row.conversation_id).toBe('conv-1')
        expect(row.message_id).toBe('m-1')
        expect(row.provider_type).toBe('anthropic')
        expect(row.provider_name).toBe('Deepseek-ant')
        expect(row.model).toBe('claude-sonnet-4')
        expect(row.input_tokens).toBe(100)
        expect(row.output_tokens).toBe(20)
        expect(row.cache_read_tokens).toBe(300)
        expect(row.reasoning_tokens).toBe(5)
        expect(row.ttft_ms).toBe(800)
        expect(row.decode_ms).toBe(5000)
        expect(row.duration_ms).toBe(12345)
        expect(row.created_at).toBe(1000)
    })

    it('同 ID 重复写入（INSERT OR IGNORE）→ 不报错、行数不变', () => {
        repo.record(makeRecord())
        repo.record(makeRecord())
        const {c} = db.prepare('SELECT COUNT(*) AS c FROM llm_usage').get() as {c: number}
        expect(c).toBe(1)
    })

    it('同一 message_id 不同 seq（路径 2 多次调用）→ 多条共存，ID 不冲突', () => {
        repo.record(makeRecord({id: 'usage_m-1_0', inputTokens: 100}))
        repo.record(makeRecord({id: 'usage_m-1_1', inputTokens: 200}))
        const rows = db.prepare('SELECT id, input_tokens FROM llm_usage ORDER BY id').all()
        expect(rows).toHaveLength(2)
        expect((rows[0] as {input_tokens: number}).input_tokens).toBe(100)
        expect((rows[1] as {input_tokens: number}).input_tokens).toBe(200)
    })

    it('conversation_id 外键：插入不存在的会话报错', () => {
        db.pragma('foreign_keys = ON')
        expect(() => repo.record(makeRecord({conversationId: 'missing'}))).toThrow()
    })
})

describe('queryAggregated（全局聚合 + 成本）', () => {
    beforeEach(() => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1000, 1000)
        repo.record(makeRecord({id: 'a', model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, cacheReadTokens: 300}))
        repo.record(makeRecord({id: 'b', model: 'claude-opus-4', inputTokens: 50, outputTokens: 10, cacheReadTokens: 100}))
    })

    it('按服务商聚合（成本求和、totalTokens 降序）', () => {
        const rows = repo.queryAggregated({range: 'all', view: 'provider'}, mockGetMeta)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.key).toBe('anthropic')
        expect(rows[0]!.providerName).toBe('Deepseek-ant')
        expect(rows[0]!.requestCount).toBe(2)
        expect(rows[0]!.inputTokens).toBe(150)
        expect(rows[0]!.outputTokens).toBe(30)
        expect(rows[0]!.cacheReadTokens).toBe(400)
        expect(rows[0]!.totalTokens).toBe(580)
        // 成本在模型粒度计算后按服务商求和：sonnet(100/3 + 20/15 + 300/0.3 e-6 = 0.00069)
        //                                    + opus(50/15 + 10/75 + 100/1.5 e-6 = 0.00165)
        //                                  = 0.00234
        expect(rows[0]!.costUsd).toBeCloseTo(0.00234, 10)
    })

    it('按模型聚合（每模型独立行 + 各自成本）', () => {
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        expect(rows).toHaveLength(2)
        // totalTokens 大的在前：sonnet(420) > opus(160)
        expect(rows[0]!.key).toBe('claude-sonnet-4')
        expect(rows[0]!.providerType).toBe('anthropic')
        expect(rows[1]!.key).toBe('claude-opus-4')
        // sonnet: 100/1e6*3 + 20/1e6*15 + 300/1e6*0.3 = 0.0003 + 0.0003 + 0.00009 = 0.00069
        expect(rows[0]!.costUsd).toBeCloseTo(0.00069, 10)
    })

    it('同 model 组内 provider_name 用 MAX 取非 NULL（历史 NULL + 新值 → 新值）', () => {
        // 同 model+provider_type：一条历史 NULL + 一条新数据 'Deepseek-ant' → 组内应取非 NULL 值
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-9', '', '{}', 1000, 1000)
        repo.record(makeRecord({id: 'n1', conversationId: 'conv-9', model: 'deepseek-v4-flash', providerName: undefined}))
        repo.record(makeRecord({id: 'n2', conversationId: 'conv-9', model: 'deepseek-v4-flash', providerName: 'Deepseek-ant'}))
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        const row = rows.find(r => r.key === 'deepseek-v4-flash')
        expect(row).toBeDefined()
        expect(row!.providerName).toBe('Deepseek-ant')
        expect(row!.requestCount).toBe(2)
    })

    it('空表 → 空数组', () => {
        db.exec('DELETE FROM llm_usage')
        expect(repo.queryAggregated({range: 'all', view: 'provider'}, mockGetMeta)).toEqual([])
    })

    it('时间范围过滤（created_at 范围外的记录不计入）', () => {
        const now = Date.now()
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-2', '', '{}', now, now)
        repo.record(makeRecord({id: 'c', conversationId: 'conv-2', createdAt: now - 1000}))
        repo.record(makeRecord({id: 'd', conversationId: 'conv-2', createdAt: now - 10 * 24 * 3600 * 1000}))
        const rows = repo.queryAggregated({range: '7d', view: 'provider'}, mockGetMeta)
        // a/b（createdAt=1000）与 d（10 天前）被过滤，仅 c 在 7 天内
        expect(rows[0]!.requestCount).toBe(1)
    })

    it('时序字段：SUM(decode_ms)、SUM(ttft_ms) 聚合，COUNT(ttft_ms) 忽略 NULL 样本', () => {
        // beforeEach 已插入 a/b（makeRecord 默认 decodeMs=5000、ttftMs=800）
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-9', '', '{}', 1000, 1000)
        // 历史行：有 decodeMs 但无 ttftMs（旧数据）→ 不计入 ttft_count
        repo.record(makeRecord({id: 't1', conversationId: 'conv-9', decodeMs: 10000, ttftMs: undefined}))
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)

        const totalDecode = rows.reduce((s, r) => s + (r.decodeMs ?? 0), 0)
        const totalTtft = rows.reduce((s, r) => s + (r.ttftMs ?? 0), 0)
        const ttftCount = rows.reduce((s, r) => s + (r.ttftCount ?? 0), 0)
        expect(totalDecode).toBe(20000)   // 5000 + 5000 + 10000
        expect(totalTtft).toBe(1600)      // 800 + 800（t1 无 ttft）
        expect(ttftCount).toBe(2)         // COUNT(ttft_ms) 忽略 NULL
    })

    it('mergeByProvider：时序字段按服务商累加（provider 视图同样携带）', () => {
        const rows = repo.queryAggregated({range: 'all', view: 'provider'}, mockGetMeta)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.decodeMs).toBe(10000)   // 5000 + 5000
        expect(rows[0]!.ttftMs).toBe(1600)      // 800 + 800
        expect(rows[0]!.ttftCount).toBe(2)
    })
})

describe('queryTrend（按天趋势）', () => {
    it('按天分组正确（跨天分桶 + 时间过滤）', () => {
        const now = Date.now()
        const day1 = new Date()
        day1.setHours(10, 0, 0, 0)
        const day2 = new Date()
        day2.setDate(day2.getDate() - 1)
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-3', '', '{}', now, now)
        repo.record(makeRecord({id: 't1', conversationId: 'conv-3', createdAt: day1.getTime(), inputTokens: 100}))
        repo.record(makeRecord({id: 't2', conversationId: 'conv-3', createdAt: day2.getTime(), inputTokens: 50}))
        const trend = repo.queryTrend({range: 'all'})
        expect(trend).toHaveLength(2)
        expect(trend[1]!.inputTokens).toBe(100)  // 升序，最新一天在末尾
        expect(trend[0]!.day).not.toBe(trend[1]!.day)
    })
})

describe('queryByConversation（会话弹窗分组）', () => {
    it('WHERE conversation_id IN (...) + 分组求和正确', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1000, 1000)
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-2', '', '{}', 1000, 1000)
        // conv-1 两行按模型聚合 + conv-2 一行
        repo.record(makeRecord({id: 'a', model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, cacheReadTokens: 300}))
        repo.record(makeRecord({id: 'b', model: 'claude-opus-4', inputTokens: 50, outputTokens: 10, cacheReadTokens: 100}))
        repo.record(makeRecord({id: 'x', conversationId: 'conv-2', model: 'claude-sonnet-4', inputTokens: 10}))
        const rows = repo.queryByConversation(['conv-1', 'conv-2'], 'model', mockGetMeta)
        expect(rows).toHaveLength(2)
        const sonnet = rows.find(r => r.key === 'claude-sonnet-4')
        expect(sonnet?.requestCount).toBe(2)
        expect(sonnet?.inputTokens).toBe(110)
    })

    it('空 convIds → 空数组', () => {
        expect(repo.queryByConversation([], 'provider', mockGetMeta)).toEqual([])
    })
})
