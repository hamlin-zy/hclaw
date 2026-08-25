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
    db.exec('DROP TABLE IF EXISTS messages')
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
    // messages 表：queryAggregated/queryTrend 历史回填（llm_stats 列）依赖
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        timestamp INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, llm_stats TEXT,
        is_partial INTEGER DEFAULT 0
    )`)
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

    it('按服务商聚合（成本求和、totalTokens 降序、key = providerName）', () => {
        const rows = repo.queryAggregated({range: 'all', view: 'provider'}, mockGetMeta)
        expect(rows).toHaveLength(1)
        // 合并键 = 真实服务商名（providers.name），而非 providerType（API 风格）
        expect(rows[0]!.key).toBe('Deepseek-ant')
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

    it('同 model 跨服务商分行：NULL 匿名行与 named 行各自成组（不再 MAX 合并）', () => {
        // 同 model+provider_type：一条历史 NULL + 一条新数据 'Deepseek-ant' → SQL 分组含 provider_name，分行
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-9', '', '{}', 1000, 1000)
        repo.record(makeRecord({id: 'n1', conversationId: 'conv-9', model: 'deepseek-v4-flash', providerName: undefined}))
        repo.record(makeRecord({id: 'n2', conversationId: 'conv-9', model: 'deepseek-v4-flash', providerName: 'Deepseek-ant'}))
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        const named = rows.find(r => r.key === 'deepseek-v4-flash' && r.providerName === 'Deepseek-ant')
        expect(named).toBeDefined()
        expect(named!.requestCount).toBe(1)
        const anon = rows.find(r => r.key === 'deepseek-v4-flash' && !r.providerName)
        expect(anon).toBeDefined()
        expect(anon!.requestCount).toBe(1)
    })

    it('跨服务商同名模型 → model 视图分行（各自 providerName），provider 视图分组', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-9', '', '{}', 1000, 1000)
        // 两个不同服务商提供同名模型 gpt-4o（均 openai 风格）→ SQL 不得合并
        repo.record(makeRecord({id: 'd1', conversationId: 'conv-9', model: 'gpt-4o', providerType: 'openai', providerName: 'OpenRouter', inputTokens: 100}))
        repo.record(makeRecord({id: 'd2', conversationId: 'conv-9', model: 'gpt-4o', providerType: 'openai', providerName: 'aliyun', inputTokens: 200}))
        const modelRows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        const gptRows = modelRows.filter(r => r.key === 'gpt-4o')
        expect(gptRows).toHaveLength(2)
        expect(gptRows.map(r => r.providerName).sort()).toEqual(['OpenRouter', 'aliyun'])
        // provider 视图：同名模型跨服务商 → 按服务商分成 2 组
        const providerRows = repo.queryAggregated({range: 'all', view: 'provider'}, mockGetMeta)
        const targeted = providerRows.filter(r => r.key === 'OpenRouter' || r.key === 'aliyun')
        expect(targeted).toHaveLength(2)
        const aliyun = targeted.find(r => r.key === 'aliyun')!
        expect(aliyun.requestCount).toBe(1)
        expect(aliyun.totalTokens).toBe(520)   // 200 input + 20 output + 300 cacheRead（makeRecord 默认）
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

describe('queryTrend（按天/按小时趋势）', () => {
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

    it('granularity=hour：按小时分桶（YYYY-MM-DD HH:00 键 + 升序）', () => {
        const now = Date.now()
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-3', '', '{}', now, now)
        const h1 = new Date()
        h1.setHours(9, 15, 0, 0)
        const h2 = new Date()
        h2.setHours(9, 45, 0, 0)   // 同小时 → 合并
        const h3 = new Date()
        h3.setHours(14, 0, 0, 0)   // 不同小时
        repo.record(makeRecord({id: 'h1', conversationId: 'conv-3', createdAt: h1.getTime(), inputTokens: 100}))
        repo.record(makeRecord({id: 'h2', conversationId: 'conv-3', createdAt: h2.getTime(), inputTokens: 50}))
        repo.record(makeRecord({id: 'h3', conversationId: 'conv-3', createdAt: h3.getTime(), inputTokens: 200}))
        const trend = repo.queryTrend({range: 'all', granularity: 'hour'})
        expect(trend).toHaveLength(2)
        expect(trend[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/)
        // 同一小时 9 点的两条合并
        const h9 = trend.find(t => t.day.endsWith(' 09:00'))
        expect(h9?.inputTokens).toBe(150)
        const h14 = trend.find(t => t.day.endsWith(' 14:00'))
        expect(h14?.inputTokens).toBe(200)
        expect(trend[0]!.day < trend[1]!.day).toBe(true)  // 升序
    })

    it('自定义范围（闭区间）：仅统计 [start 0点, end 23:59:59.999] 内记录', () => {
        const now = Date.now()
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-3', '', '{}', now, now)
        // 2026-08-10 10:00 / 2026-08-11 20:00 / 2026-08-13 00:00（范围外）/ 2026-08-09 23:59（范围外）
        repo.record(makeRecord({id: 'c1', conversationId: 'conv-3', createdAt: new Date(2026, 7, 10, 10, 0).getTime(), inputTokens: 100}))
        repo.record(makeRecord({id: 'c2', conversationId: 'conv-3', createdAt: new Date(2026, 7, 11, 20, 0).getTime(), inputTokens: 200}))
        repo.record(makeRecord({id: 'c3', conversationId: 'conv-3', createdAt: new Date(2026, 7, 13, 0, 0).getTime(), inputTokens: 400}))
        repo.record(makeRecord({id: 'c4', conversationId: 'conv-3', createdAt: new Date(2026, 7, 9, 23, 59).getTime(), inputTokens: 800}))
        const trend = repo.queryTrend({range: 'custom', customStart: '2026-08-10', customEnd: '2026-08-12'})
        expect(trend).toHaveLength(2)
        expect(trend.reduce((s, t) => s + t.inputTokens, 0)).toBe(300)
        expect(trend[0]!.day).toBe('2026-08-10')
        expect(trend[1]!.day).toBe('2026-08-11')
    })
})

describe('queryAggregated（自定义范围）', () => {
    beforeEach(() => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-3', '', '{}', Date.now(), Date.now())
        // 固定时间轴：2026-08-08 / 08-10 / 08-12 各一条
        repo.record(makeRecord({id: 'x1', conversationId: 'conv-3', createdAt: new Date(2026, 7, 8, 8, 0).getTime(), inputTokens: 1}))
        repo.record(makeRecord({id: 'x2', conversationId: 'conv-3', createdAt: new Date(2026, 7, 10, 8, 0).getTime(), inputTokens: 2}))
        repo.record(makeRecord({id: 'x3', conversationId: 'conv-3', createdAt: new Date(2026, 7, 12, 8, 0).getTime(), inputTokens: 4}))
    })

    it('自定义范围过滤聚合行（含边界日）', () => {
        const rows = repo.queryAggregated({range: 'custom', customStart: '2026-08-10', customEnd: '2026-08-12', view: 'provider'}, mockGetMeta)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.requestCount).toBe(2)      // x2 + x3（x1 在 08-10 之前被排除）
        expect(rows[0]!.inputTokens).toBe(6)
    })

    it('自定义范围当日 23:59:59.999 边界：结束日末刻记录命中', () => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-4', '', '{}', Date.now(), Date.now())
        repo.record(makeRecord({id: 'x4', conversationId: 'conv-4', createdAt: new Date(2026, 7, 12, 23, 59, 59, 999).getTime(), inputTokens: 8}))
        const rows = repo.queryAggregated({range: 'custom', customStart: '2026-08-10', customEnd: '2026-08-12', view: 'provider'}, mockGetMeta)
        const row = rows.find(r => r.key === 'Deepseek-ant')
        expect(row?.requestCount).toBe(3)
        expect(row?.inputTokens).toBe(14)
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

describe('queryAggregated/queryTrend — 历史 llm_stats 回填（与右键弹窗 readUsageRaw 双源语义一致）', () => {
    /** 旧消息（llm_stats 列有值，llm_usage 无行）写入 messages 表 */
    function seedLegacyMessage(overrides: {id?: string; convId?: string; ts?: number; model?: string} = {}) {
        const stats = [{
            inputTokens: 50, outputTokens: 10, provider: 'anthropic', model: overrides.model ?? 'claude-sonnet-4',
            duration: 1000, ttftMs: 500, decodeMs: 2000,
        }]
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run(overrides.id ?? 'm-2', overrides.convId ?? 'conv-1', 'assistant', overrides.ts ?? 2000, JSON.stringify(stats))
    }

    beforeEach(() => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1000, 1000)
        // 新数据：llm_usage 一行（conv-1 / m-1），时间落在自定义范围测试的区间内（2026-08-11）
        repo.record(makeRecord({id: 'usage_m-1_0', conversationId: 'conv-1', messageId: 'm-1',
            model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, cacheReadTokens: 300,
            createdAt: new Date(2026, 7, 11).getTime()}))
    })

    it('llm_usage + 历史 llm_stats 合并聚合（请求数 / token / 时序 / 成本）', () => {
        seedLegacyMessage()
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        // llm_usage 行带 providerName（Deepseek-ant）；历史回填行无 providerName → 匿名组独立成组
        const usage = rows.find(r => r.key === 'claude-sonnet-4' && r.providerName === 'Deepseek-ant')
        expect(usage?.requestCount).toBe(1)          // 1 usage 行
        expect(usage?.inputTokens).toBe(100)
        expect(usage?.outputTokens).toBe(20)
        expect(usage?.cacheReadTokens).toBe(300)
        expect(usage?.decodeMs).toBe(5000)
        expect(usage?.costUsd).toBeCloseTo(100*3e-6 + 20*15e-6 + 300*0.3e-6, 10)
        const legacy = rows.find(r => r.key === 'claude-sonnet-4' && !r.providerName)
        expect(legacy?.requestCount).toBe(1)         // 1 历史消息
        expect(legacy?.inputTokens).toBe(50)
        expect(legacy?.outputTokens).toBe(10)
        expect(legacy?.decodeMs).toBe(2000)
        expect(legacy?.ttftCount).toBe(1)            // 500ms 样本
        // 合计口径不丢：两组合计 2 请求
        const total = rows.filter(r => r.key === 'claude-sonnet-4').reduce((s, r) => s + r.requestCount, 0)
        expect(total).toBe(2)
    })

    it('时间范围过滤历史回填（消息 timestamp 近似）', () => {
        seedLegacyMessage({ts: new Date(2026, 7, 15).getTime()})   // 范围外
        seedLegacyMessage({id: 'm-3', ts: new Date(2026, 7, 11).getTime()})  // 范围内
        const rows = repo.queryAggregated({range: 'custom', customStart: '2026-08-10', customEnd: '2026-08-12', view: 'model'}, mockGetMeta)
        // 范围内：1 usage 行（named）+ m-3 回填（匿名）→ 2 组；m-2 在范围外
        const usage = rows.find(r => r.key === 'claude-sonnet-4' && r.providerName === 'Deepseek-ant')
        expect(usage?.requestCount).toBe(1)
        const legacy = rows.find(r => r.key === 'claude-sonnet-4' && !r.providerName)
        expect(legacy?.requestCount).toBe(1)          // 仅 m-3（范围内）
        expect(legacy?.inputTokens).toBe(50)
    })

    it('趋势回填：历史 llm_stats 按消息 timestamp 归入对应日桶', () => {
        seedLegacyMessage({ts: new Date(2026, 7, 11, 10, 30).getTime()})
        const trend = repo.queryTrend({range: 'all', granularity: 'day'})
        const day = trend.find(t => t.day === '2026-08-11')
        // usage 行（createdAt 08-11，input 100）+ 历史回填（m-2，input 50）
        expect(day?.inputTokens).toBe(150)
        expect(day?.outputTokens).toBe(30)
    })
})

describe('queryAggregated/queryTrend — 双源防重（llm_usage 已有记录的消息不回填 llm_stats）', () => {
    /** 插入一条带 llm_stats 列的消息（模拟迁移前历史 / 双写残留数据源） */
    function seedMessageWithStats(id: string, inputTokens: number, outputTokens: number, ts: number) {
        const stats = [{inputTokens, outputTokens, provider: 'anthropic', model: 'claude-sonnet-4', duration: 1000, ttftMs: 500, decodeMs: 2000}]
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, llm_stats) VALUES (?, ?, ?, ?, ?)')
            .run(id, 'conv-1', 'assistant', ts, JSON.stringify(stats))
    }
    /** 同一条消息既写 llm_usage 又残留 llm_stats 列（历史写侧剥离前双写/膨胀场景） */
    const seedDuplicatedMessage = () => seedMessageWithStats('m-1', 50, 10, new Date(2026, 7, 11, 10, 30).getTime())
    /** 仅 llm_stats 列有值、llm_usage 无行（迁移前历史唯一源） */
    const seedLegacyOnlyMessage = () => seedMessageWithStats('m-2', 60, 12, new Date(2026, 7, 11, 10, 31).getTime())

    beforeEach(() => {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('conv-1', '', '{}', 1000, 1000)
        // llm_usage 行：m-1 一次调用（真实唯一源）
        repo.record(makeRecord({id: 'usage_m-1_0', conversationId: 'conv-1', messageId: 'm-1',
            model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, cacheReadTokens: 300,
            createdAt: new Date(2026, 7, 11, 10, 30).getTime()}))
    })

    it('同一消息双写（llm_usage + llm_stats 列）→ 聚合只计 llm_usage 一次，不重复计数', () => {
        seedDuplicatedMessage()
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        const b = rows.find(r => r.key === 'claude-sonnet-4')
        expect(b?.requestCount).toBe(1)      // 不叠加 llm_stats 的 1 条
        expect(b?.inputTokens).toBe(100)     // 不叠加 50
        expect(b?.outputTokens).toBe(20)     // 不叠加 10
        expect(b?.cacheReadTokens).toBe(300)
    })

    it('llm_usage 无记录的历史消息 → 仍正常回填（历史唯一源不受影响）', () => {
        seedLegacyOnlyMessage()
        const rows = repo.queryAggregated({range: 'all', view: 'model'}, mockGetMeta)
        // usage 行（named）+ m-2 回填（匿名，无 providerName）→ 2 组
        const usage = rows.find(r => r.key === 'claude-sonnet-4' && r.providerName === 'Deepseek-ant')
        expect(usage?.requestCount).toBe(1)
        expect(usage?.inputTokens).toBe(100)
        const legacy = rows.find(r => r.key === 'claude-sonnet-4' && !r.providerName)
        expect(legacy?.requestCount).toBe(1)      // m-2 历史
        expect(legacy?.inputTokens).toBe(60)      // 100 + 60
        expect(legacy?.outputTokens).toBe(12)
    })

    it('趋势查询同样防重：双写消息不回填、历史唯一源正常归桶', () => {
        seedDuplicatedMessage()
        seedLegacyOnlyMessage()
        const trend = repo.queryTrend({range: 'all', granularity: 'day'})
        const day = trend.find(t => t.day === '2026-08-11')
        // 100(usage) + 60(m-2)；m-1 的 llm_stats 残留 50 不回填
        expect(day?.inputTokens).toBe(160)
        expect(day?.outputTokens).toBe(32)
    })
})
