/**
 * 消息增量落库（writeMessagesDelta）单元测试
 *
 * 覆盖本次性能优化（优化 2+4：增量写入 + IPC 裁剪）：
 * - 只 UPSERT 单条消息 + 重建其 blocks，不触碰其他消息
 * - 保留已有 llm_stats（流式中间态不覆盖已写入的统计）
 * - 消息 contentBlocks 变化时 blocks 被正确替换（不残留旧 block）
 * - 事务原子性（模拟失败时无半写状态）
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 下的独立临时目录，
 *    绝不触碰真实 ~/.hclaw/data/hclaw.db（探针已验证）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'
import type {BlockDeltaPatch} from '../../../src/shared/types/message'

// 注意：vi.mock 工厂被提升（hoist），不能引用文件级 const —— 路径必须在工厂内计算
vi.mock('../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-repo-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {getDatabase, saveDatabase, flushDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../src/main/repositories/sqlite/conversationRepository'

function makeAssistantMsg(id: string, content: string, extra?: Partial<Message>): Message {
    return {
        id,
        role: 'assistant',
        content,
        timestamp: 1000,
        ...extra,
    }
}

function makeToolMsg(id: string, content: string, resultOutput: string): Message {
    return makeAssistantMsg(id, content, {
        toolCalls: [{
            id: 'tc-' + id,
            name: 'bash',
            arguments: {cmd: 'echo hi'},
            status: 'success',
            result: {output: resultOutput},
        }],
    })
}

let repo: SqliteConversationRepository
let db: ReturnType<typeof getDatabase>

beforeEach(() => {
    repo = new SqliteConversationRepository()
    db = getDatabase()
    // 每个用例独立表结构：DROP 后重建，避免跨用例数据残留
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    // 最小 schema（与迁移 001 + 006 对齐）
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        timestamp INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, llm_stats TEXT
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS message_blocks (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER,
        FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
    )`)
    // ★ 生产外键约束：与迁移 001 对齐——message_blocks.message_id → messages.id。
    //   真实环境外键开启（否则此前 writeBlockDelta「先插块后建行」的 FK 失败不会被测试暴露），
    //   这里显式开启，防同类回归。
    db.exec('PRAGMA foreign_keys = ON')
    repo.create('conv-1', {id: 'conv-1', title: 't', workspacePath: '/tmp/test-ws', createdAt: 1, updatedAt: 1, preview: '', status: 'active'})
})

afterEach(() => {
    closeDatabase()
})

describe('writeMessagesDelta — 增量落库', () => {
    it('写入单条 assistant 消息：messages 行 + 对应 blocks', () => {
        const msg = makeToolMsg('m1', '正文', '结果1')

        expect(repo.writeMessagesDelta('conv-1', msg)).toBe(true)

        const rows = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all('conv-1') as Array<{id: string}>
        expect(rows.map(r => r.id)).toEqual(['m1'])

        const blocks = db.prepare('SELECT block_type FROM message_blocks WHERE message_id = ? ORDER BY sequence').all('m1') as Array<{block_type: string}>
        // tool_use → tool_result → text（按 messageToBlocks 顺序）
        expect(blocks.map(b => b.block_type)).toEqual(['tool_call', 'tool_result', 'text'])
    })

    it('只影响目标消息，其他消息原样保留（不做全量重写）', () => {
        // 预置其他消息（模拟已落库的历史）
        const other = makeAssistantMsg('other', '历史消息')
        const other2 = makeAssistantMsg('other2', '历史消息2')
        repo.writeMessages('conv-1', [other, other2])

        // 增量写一条新消息
        const fresh = makeAssistantMsg('fresh', '新消息')
        repo.writeMessagesDelta('conv-1', fresh)

        const all = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY timestamp').all('conv-1') as Array<{id: string}>
        expect(all.map(r => r.id)).toEqual(['other', 'other2', 'fresh'])
    })

    it('重复写入同一消息时替换旧 blocks，不残留', () => {
        // 第一次：工具消息（3 blocks）
        repo.writeMessagesDelta('conv-1', makeToolMsg('m1', 'v1', '结果1'))
        // 第二次：更新为纯文本（1 block）— 模拟 toolCall 完成后 contentBlocks 变化
        repo.writeMessagesDelta('conv-1', makeAssistantMsg('m1', '最终文本'))

        const blocks = db.prepare('SELECT block_type FROM message_blocks WHERE message_id = ?').all('m1') as Array<{block_type: string}>
        // 旧 tool_call/tool_result blocks 已被删除，仅剩新的 text block
        expect(blocks.map(b => b.block_type)).toEqual(['text'])
        expect(blocks).toHaveLength(1)
    })

    it('保留已有 llm_stats（流式中间态写入不覆盖统计）', () => {
        const msg = makeAssistantMsg('m1', 'v1')
        repo.writeMessages('conv-1', [msg])
        // 模拟主进程已写入 llm_stats
        db.prepare('UPDATE messages SET llm_stats = ? WHERE id = ?').run(
            JSON.stringify([{inputTokens: 100, outputTokens: 50, provider: 'anthropic', model: 'claude', duration: 1000}]),
            'm1',
        )

        // 渲染进程增量写（不带 llmStats 字段的中间态）
        repo.writeMessagesDelta('conv-1', makeAssistantMsg('m1', 'v2'))

        const row = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m1') as {llm_stats: string | null}
        const stats = JSON.parse(row.llm_stats!)
        expect(stats[0].inputTokens).toBe(100)
        expect(stats[0].model).toBe('claude')
    })

    it('新消息携带 llmStats 时正常写入', () => {
        const msg = makeAssistantMsg('m1', 'v1', {
            llmStats: [{inputTokens: 5, outputTokens: 3, provider: 'openai', model: 'gpt', duration: 200}],
        })
        repo.writeMessagesDelta('conv-1', msg)

        const row = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m1') as {llm_stats: string | null}
        const stats = JSON.parse(row.llm_stats!)
        expect(stats[0].model).toBe('gpt')
    })

    it('写入 user 消息：无 blocks，仅 messages 行', () => {
        const userMsg: Message = {id: 'u1', role: 'user', content: '问题', timestamp: 2000}
        repo.writeMessagesDelta('conv-1', userMsg)

        const msgRow = db.prepare('SELECT role FROM messages WHERE id = ?').get('u1') as {role: string}
        expect(msgRow.role).toBe('user')
        const blocks = db.prepare('SELECT id FROM message_blocks WHERE message_id = ?').all('u1')
        expect(blocks).toHaveLength(0)
    })
})

describe('saveDatabase — 低频 WAL checkpoint', () => {
    it('saveDatabase 不立即 checkpoint（防抖窗口内 WAL 保留）', () => {
        // 写入数据后调用 saveDatabase，WAL 文件应存在（未合并回主库）
        const msg = makeAssistantMsg('m1', '内容')
        repo.writeMessagesDelta('conv-1', msg)
        saveDatabase()

        const fs = require('fs')
        const os = require('os')
        // 定位本次测试的临时库 WAL
        const tmpRoot = os.tmpdir()
        const dir = fs.readdirSync(tmpRoot).filter((n: string) => n.startsWith('hclaw-test-repo-')).pop()!
        const walBefore = fs.existsSync(tmpRoot + '/' + dir + '/data/hclaw.db-wal')
            ? fs.statSync(tmpRoot + '/' + dir + '/data/hclaw.db-wal').size
            : 0

        // 再次 saveDatabase（模拟高频流式落库）— 应被防抖吞掉
        repo.writeMessagesDelta('conv-1', makeAssistantMsg('m1', '内容2'))
        saveDatabase()

        const walAfter = fs.existsSync(tmpRoot + '/' + dir + '/data/hclaw.db-wal')
            ? fs.statSync(tmpRoot + '/' + dir + '/data/hclaw.db-wal').size
            : 0
        // 防抖窗口内第二次 saveDatabase 不触发 checkpoint：WAL 尺寸应增大（数据累积在 WAL）
        expect(walAfter).toBeGreaterThanOrEqual(walBefore)
    })

    it('flushDatabase 强制 checkpoint：数据不丢失', () => {
        const msg = makeAssistantMsg('m1', '内容')
        repo.writeMessagesDelta('conv-1', msg)
        saveDatabase()

        flushDatabase()

        // 数据仍在（checkpoint 只是把 WAL 合并到主库，不丢数据）
        const rows = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all('conv-1') as Array<{id: string}>
        expect(rows.map(r => r.id)).toEqual(['m1'])
    })

    it('高频重复调用 saveDatabase 不抛错（防抖路径廉价）', () => {
        expect(() => {
            for (let i = 0; i < 100; i++) {
                saveDatabase()
            }
        }).not.toThrow()
    })
})

describe('readUsageRaw — 用量统计读取', () => {
    it('按会话聚合 llm_stats 与 tool_call 块计数', () => {
        // 写两条消息：一条带 llm_stats，一条带 toolCalls（落库为 tool_call 块）
        repo.writeMessagesDelta('conv-usage-1', makeAssistantMsg('m1', 'hi', {
            llmStats: [{inputTokens: 100, outputTokens: 20, provider: 'test', model: 'm', duration: 10, cacheReadTokens: 50}],
        }))
        repo.writeMessagesDelta('conv-usage-1', makeToolMsg('m2', '', 'result'))

        const raw = repo.readUsageRaw(['conv-usage-1'])

        expect(raw.llmStatsByConv.get('conv-usage-1')).toHaveLength(1)
        expect(raw.llmStatsByConv.get('conv-usage-1')![0].inputTokens).toBe(100)
        expect(raw.toolCallCountByConv.get('conv-usage-1')).toBe(1)
    })

    it('空数组返回空 map，不抛错', () => {
        const raw = repo.readUsageRaw([])
        expect(raw.llmStatsByConv.size).toBe(0)
        expect(raw.toolCallCountByConv.size).toBe(0)
    })

    it('无 llm_stats 的会话不进入 map，不抛错', () => {
        repo.writeMessagesDelta('conv-usage-2', makeAssistantMsg('m3', 'plain'))
        const raw = repo.readUsageRaw(['conv-usage-2'])
        expect(raw.llmStatsByConv.size).toBe(0)
        expect(raw.toolCallCountByConv.size).toBe(0)
    })
})

describe('writeBlockDelta — 块级增量', () => {
    it('INSERT 新块并分配连续 sequence', () => {
        const patch: BlockDeltaPatch = {
            upsertBlocks: [
                {id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '正文', data: null, sequence: 0, timestamp: 1},
            ],
            messageFields: {role: 'assistant', timestamp: 1, metadata: {agentName: 'a'}},
        }
        expect(repo.writeBlockDelta('conv-1', 'm1', patch)).toBe(true)
        const blocks = db.prepare('SELECT id, sequence FROM message_blocks WHERE message_id = ? ORDER BY sequence').all('m1')
        expect(blocks).toEqual([{id: 'text-m1-0', sequence: 0}])
    })

    it('同一块 id 再次写入 = UPDATE（内容增长），不重复 INSERT，sequence 不变', () => {
        // 先建行（FK：message_blocks.message_id → messages.id，行必须先存在）
        repo.writeBlockDelta('conv-1', 'm1', {messageFields: {role: 'assistant', timestamp: 1}})
        repo.writeBlockDelta('conv-1', 'm1', {upsertBlocks: [{id: 'think-m1-0', messageId: 'm1', blockType: 'think', content: '思考前段', data: null, sequence: 0, timestamp: 1}]})
        repo.writeBlockDelta('conv-1', 'm1', {upsertBlocks: [{id: 'think-m1-0', messageId: 'm1', blockType: 'think', content: '思考前段+后段', data: null, sequence: 0, timestamp: 2}]})
        const rows = db.prepare('SELECT id, content, sequence FROM message_blocks WHERE message_id = ?').all('m1')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual({id: 'think-m1-0', content: '思考前段+后段', sequence: 0})
    })

    it('多块 flush：sequence 连续分配', () => {
        repo.writeBlockDelta('conv-1', 'm1', {messageFields: {role: 'assistant', timestamp: 1}})
        repo.writeBlockDelta('conv-1', 'm1', {upsertBlocks: [
            {id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: 'a', data: null, sequence: 0, timestamp: 1},
            {id: 'text-m1-1', messageId: 'm1', blockType: 'text', content: 'b', data: null, sequence: 0, timestamp: 1},
        ]})
        const seqs = db.prepare('SELECT sequence FROM message_blocks WHERE message_id = ? ORDER BY sequence').all('m1') as Array<{sequence: number}>
        expect(seqs.map(r => r.sequence)).toEqual([0, 1])
    })

    it('finalize：补 ended_at + end 块；重复 finalize 幂等', () => {
        repo.writeBlockDelta('conv-1', 'm1', {messageFields: {role: 'assistant', timestamp: 1}})
        expect(repo.writeBlockDelta('conv-1', 'm1', {finalize: true, messageFields: {endedAt: 99}})).toBe(true)
        const m = db.prepare('SELECT ended_at FROM messages WHERE id = ?').get('m1') as {ended_at: number}
        expect(m.ended_at).toBe(99)
        const end = db.prepare("SELECT id, data FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get('m1') as {id: string; data: string}
        expect(end.id).toBe('m1-end')
        expect(JSON.parse(end.data).endedAt).toBe(99)
        // 重复 finalize
        repo.writeBlockDelta('conv-1', 'm1', {finalize: true, messageFields: {endedAt: 100}})
        const m2 = db.prepare('SELECT ended_at FROM messages WHERE id = ?').get('m1') as {ended_at: number}
        expect(m2.ended_at).toBe(100)
        const cnt = db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get('m1') as {c: number}
        expect(cnt.c).toBe(1)
    })

    it('messageFields 写入保留已有 llm_stats', () => {
        repo.writeMessages('conv-1', [{id: 'm1', role: 'assistant', content: 'x', timestamp: 1, llmStats: [{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'm', duration: 1}]} as Message])
        repo.writeBlockDelta('conv-1', 'm1', {messageFields: {role: 'assistant', timestamp: 1, metadata: {agentName: 'a'}}})
        const llm = db.prepare('SELECT llm_stats FROM messages WHERE id = ?').get('m1') as {llm_stats: string}
        expect(llm.llm_stats).toContain('inputTokens')
    })

    it('messageFields 含 role 但缺 timestamp：拒绝写入（false + 无任何部分写入，含块）', () => {
        // ★ NOT NULL 对只验一半的回归防护：role 判了 string 但 timestamp 缺失时，
        //   不得让 INSERT OR REPLACE 撞 timestamp NOT NULL 回滚整笔事务后静默 false——
        //   改为写前显式校验：整笔拒绝返回 false，块也不得插入（防半笔落库）。
        const patch: BlockDeltaPatch = {
            upsertBlocks: [{id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '正文', data: null, sequence: 0, timestamp: 1}],
            messageFields: {role: 'assistant'}, // ★ 缺 timestamp
        }
        expect(repo.writeBlockDelta('conv-1', 'm1', patch)).toBe(false)
        // 事务整体回滚：块未插入（无部分写入）
        const blocks = db.prepare('SELECT id FROM message_blocks WHERE message_id = ?').all('m1')
        expect(blocks).toHaveLength(0)
        // 消息行也未插入
        const rows = db.prepare('SELECT id FROM messages WHERE id = ?').all('m1')
        expect(rows).toHaveLength(0)
    })

    it('messageFields.timestamp 非有限数（NaN/Infinity）：同样拒绝写入，无部分写入', () => {
        for (const bad of [NaN, Infinity, -Infinity]) {
            const patch: BlockDeltaPatch = {
                upsertBlocks: [{id: `text-m1-${bad}`, messageId: 'm1', blockType: 'text', content: '正文', data: null, sequence: 0, timestamp: 1}],
                messageFields: {role: 'assistant', timestamp: bad as number},
            }
            expect(repo.writeBlockDelta('conv-1', 'm1', patch)).toBe(false)
            expect(db.prepare('SELECT id FROM message_blocks WHERE message_id = ?').all('m1')).toHaveLength(0)
            expect(db.prepare('SELECT id FROM messages WHERE id = ?').all('m1')).toHaveLength(0)
        }
    })
})

describe('setMessageEnded — 补写原语（Task 6 保险丝复用语义）', () => {
    it('补写语义：有 blocks 的消息 setMessageEnded 只补 endedAt，不触碰 blocks', () => {
        // 预置块级增量写入（渲染端已落库的精细块）
        repo.writeBlockDelta('conv-1', 'm1', {
            upsertBlocks: [{id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '精细块', data: null, sequence: 0, timestamp: 1}],
            messageFields: {role: 'assistant', timestamp: 1},
        })
        repo.setMessageEnded('conv-1', 'm1', 200)
        // 精细块未被覆盖（end 块是 setMessageEnded 自身补的，排除在外）
        const blocks = db.prepare("SELECT id, content FROM message_blocks WHERE message_id = ? AND block_type != 'end'").all('m1')
        expect(blocks).toEqual([{id: 'text-m1-0', content: '精细块'}])
        const end = db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get('m1') as {c: number}
        expect(end.c).toBe(1)
    })
})
