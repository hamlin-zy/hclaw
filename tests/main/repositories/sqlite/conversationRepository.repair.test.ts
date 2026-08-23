/**
 * conversationRepository.repairTextTail — 崩溃落库缺口修补（P0-改动2） 单元测试
 *
 * 场景：渲染进程崩溃导致流式期间未 flush 的 text 增量永久丢失，
 * 主进程保险丝 #mergeAndPersist 发现 DB 已有 blocks 时跳过内容写入。
 * 本函数以主进程累积的完整正文为基准，把 DB 缺失的尾部补齐：
 * - 已有 text 块 → 对 MAX(sequence) 的 text 块追加缺失尾部
 * - 无 text 块（仅 think 等块已落库）→ 插入完整 text 块
 * - 已完整 / DB 反超 → 不动（幂等 + 防覆盖）
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-repair-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'

let repo: SqliteConversationRepository
let db: ReturnType<typeof getDatabase>

beforeEach(() => {
    repo = new SqliteConversationRepository()
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
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
    // 消息行（blocks 的外键父行）
    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('conv-1', '', '{}', 1, 1)
    db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp) VALUES (?, ?, ?, ?)')
        .run('m-1', 'conv-1', 'assistant', 1000)
})

afterEach(() => { closeDatabase() })

function insertBlock(id: string, blockType: string, content: string | null, sequence: number): void {
    db.prepare(
        'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'm-1', blockType, content, null, sequence, 1000)
}

function readTextBlocks(): Array<{id: string; content: string; sequence: number}> {
    return db.prepare(
        "SELECT id, content, sequence FROM message_blocks WHERE message_id = 'm-1' AND block_type = 'text' ORDER BY sequence"
    ).all() as Array<{id: string; content: string; sequence: number}>
}

describe('repairTextTail — 崩溃落库缺口修补', () => {
    it('部分 text 已落库：对 MAX(sequence) text 块追加缺失尾部', () => {
        insertBlock('text-m-1-0', 'text', '第一段第二', 0)
        const ok = repo.repairTextTail('m-1', '第一段第二段完整结尾')
        expect(ok).toBe(true)
        const blocks = readTextBlocks()
        expect(blocks).toHaveLength(1)
        expect(blocks[0].content).toBe('第一段第二段完整结尾')
    })

    it('无 text 块（仅 think 已落库）：插入完整 text 块，sequence 排在已有块之后', () => {
        insertBlock('think-m-1-0', 'think', '思考内容', 0)
        const ok = repo.repairTextTail('m-1', '完整正文')
        expect(ok).toBe(true)
        const blocks = readTextBlocks()
        expect(blocks).toHaveLength(1)
        expect(blocks[0].content).toBe('完整正文')
        expect(blocks[0].sequence).toBe(1) // MAX(sequence)+1，排在 think 之后
    })

    it('完全无块时也可插入（消息行存在但从未落任何块的边界）', () => {
        const ok = repo.repairTextTail('m-1', '正文')
        expect(ok).toBe(true)
        expect(readTextBlocks()[0].content).toBe('正文')
    })

    it('已完整：幂等不动（不追加、不新增）', () => {
        insertBlock('text-m-1-0', 'text', '完整正文', 0)
        const ok = repo.repairTextTail('m-1', '完整正文')
        expect(ok).toBe(true)
        const blocks = readTextBlocks()
        expect(blocks).toHaveLength(1)
        expect(blocks[0].content).toBe('完整正文')
    })

    it('DB 文本反超 fullText（异常场景）：不裁剪不追加，防覆盖', () => {
        insertBlock('text-m-1-0', 'text', 'DB里比fullText长得多得多的内容', 0)
        const ok = repo.repairTextTail('m-1', '短')
        expect(ok).toBe(true)
        const blocks = readTextBlocks()
        expect(blocks).toHaveLength(1)
        expect(blocks[0].content).toBe('DB里比fullText长得多得多的内容')
    })

    it('消息不存在（无行无块）：返回 false 不产生孤儿块', () => {
        const ok = repo.repairTextTail('no-such-msg', '正文')
        expect(ok).toBe(false)
        expect(readTextBlocks()).toHaveLength(0)
    })

    it('多 text 块场景：按总长度计算缺口并追加到最后一块', () => {
        insertBlock('text-m-1-0', 'text', '段一', 0)
        insertBlock('text-m-1-3', 'text', '段二的开', 1)
        // DB 总长 6；全文 10 字符 → 追加 4 字符到 sequence=1 的块
        const ok = repo.repairTextTail('m-1', '段一段二的开头尾补全')
        expect(ok).toBe(true)
        const blocks = readTextBlocks()
        expect(blocks).toHaveLength(2)
        expect(blocks[0].content).toBe('段一')
        expect(blocks[1].content).toBe('段二的开头尾补全')
    })
})
