/**
 * ★ 独立对抗验证：abort 兜底收尾（#finalizePendingIfUnfinalized）——目的是打破它，不是确认它。
 *
 * 覆盖被审测试（manager.abortFinalize.test.ts）未覆盖的 4 类攻击面：
 *  a. done 先到 / done 晚到 的顺序竞态：ended_at 是否被推后、end 块是否重复；
 *  b. pending 存在但 DB 尚无消息行（首 flush 前终止）：是否凭空建空行 / 写垃圾块 / 抛错；
 *  c. 身份守卫复检：接管（新 worker）发生在「首检之前」与「兜底中途（await 之后）」两种时序；
 *  d. 行存在 + ended_at 为 NULL：end 块与 ended_at 是否同源（防「只写列不写块」半笔）；
 *  e. fail-open：ended_at 查询抛错时仍必须补写终止时间。
 *
 * 环境搭建与被审测试同源（config 重定向 tmpdir + electron 空壳 + 内存 sqlite 真实 schema 子集
 * + workers Map 直接注入假 worker），假定时器推进 1s 优雅窗口。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 隔离：config 重定向到独立临时目录 ──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-abort-verify-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

// ── electron 空壳 ──
vi.mock('electron', () => ({
    BrowserWindow: class { static getAllWindows() { return [] } },
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {createPendingMsg} from '@/main/agent/manager.accumulator'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'
import {WORKER_GRACEFUL_SHUTDOWN_MS} from '@/main/agent/manager.constants'
import type {PendingAssistantMsg} from '@/main/agent/manager.types'
import {getConversationPersistence} from '@/main/persistence/conversationPersistence'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'

const CONV = 'conv-abort-verify'

let manager: AgentManager
let db: ReturnType<typeof getDatabase>
let persistence: ReturnType<typeof getConversationPersistence>

function seedSchema(): void {
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
}

function resetPersistenceState(): void {
    const st: Map<string, {timer: ReturnType<typeof setTimeout> | null}> = (persistence as any).states
    for (const s of st.values()) if (s.timer) clearTimeout(s.timer)
    st.clear()
    ;(persistence as any).listeners.clear()
}

interface FakeWorker { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
function makeWorker(): FakeWorker {
    return {postMessage: vi.fn(), terminate: vi.fn()}
}
function injectWorker(convId: string, worker: FakeWorker): void {
    const map = (manager as unknown as {workers: Map<string, unknown>}).workers
    map.set(convId, {worker, abortController: new AbortController()})
}
function getWorkerEntry(convId: string): {worker: FakeWorker} | undefined {
    const map = (manager as unknown as {workers: Map<string, unknown>}).workers
    return map.get(convId) as {worker: FakeWorker} | undefined
}

async function feed(event: unknown): Promise<void> {
    await (manager as any).handleStreamEvent(CONV, null, event)
}

function getPending(): PendingAssistantMsg | null {
    return (manager as any).pendingAssistantMsg.get(CONV) ?? null
}
function setPending(p: PendingAssistantMsg | null): void {
    ;(manager as any).pendingAssistantMsg.set(CONV, p)
}

function readRow(msgId: string): {timestamp: number; ended_at: number | null} | undefined {
    return db.prepare('SELECT timestamp, ended_at FROM messages WHERE id = ?').get(msgId) as
        {timestamp: number; ended_at: number | null} | undefined
}
function countRows(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(CONV) as {c: number}).c
}
function blocksOf(msgId: string): Array<{id: string; block_type: string; content: string | null; data: string | null; sequence: number; ended_at: number | null}> {
    return db.prepare('SELECT id, block_type, content, data, sequence, ended_at FROM message_blocks WHERE message_id = ? ORDER BY sequence ASC')
        .all(msgId) as any
}
function endBlocksOf(msgId: string): Array<{id: string; data: string | null; sequence: number; ended_at: number | null}> {
    return blocksOf(msgId).filter(b => b.block_type === 'end')
}

/** 收集未处理的 Promise rejection（fake timer 回调内的异常不会被 vitest 直接捕获） */
function watchUnhandled(): {list: unknown[]; stop: () => void} {
    const list: unknown[] = []
    const onUR = (e: unknown): void => { list.push(e) }
    process.on('unhandledRejection', onUR)
    return {list, stop: () => process.off('unhandledRejection', onUR)}
}

/** 推进优雅窗口 + 刷新微任务（含动态 import 链）*/
async function advanceGracefulWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(WORKER_GRACEFUL_SHUTDOWN_MS)
    await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
    vi.useFakeTimers()
    manager = new AgentManager()
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    seedSchema()
    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(CONV, '', '{}', 1, 1)

    persistence = getConversationPersistence()
    resetPersistenceState()
})

afterEach(() => {
    resetPersistenceState()
    vi.useRealTimers()
    vi.restoreAllMocks()
    closeDatabase()
})

describe('对抗验证：abort 兜底收尾', () => {
    it('a1) done 先到（窗口内正常 finalize）+ abort 超时后到：ended_at 不得被推后、end 块唯一', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '这条消息会在窗口内正常完成'})
        const msgId = getPending()!.id
        expect(readRow(msgId)).toBeUndefined()   // 尚未 flush，DB 无行

        // 用户先点了终止（注册兜底定时器），随后 worker 在窗口内回送 done(aborted)
        await manager.abort(CONV)
        await feed({type: 'done', reason: 'aborted'})
        const finalizedAt = readRow(msgId)?.ended_at
        expect(finalizedAt).toBeTypeOf('number')
        expect(endBlocksOf(msgId)).toHaveLength(1)

        // 窗口到期 → 兜底必须识别「已终结」并原样返回
        await advanceGracefulWindow()

        const after = readRow(msgId)
        expect(after?.ended_at).toBe(finalizedAt)
        expect(endBlocksOf(msgId)).toHaveLength(1)
    })

    it('a2) abort 超时先到（兜底终结 + terminate + cleanup），done 晚到：不得二次改写、不得补第二个 end 块', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '兜底先落地'})
        const msgId = getPending()!.id

        await manager.abort(CONV)
        await advanceGracefulWindow()
        expect(worker.terminate).toHaveBeenCalledTimes(1)
        const afterFallback = readRow(msgId)?.ended_at
        expect(afterFallback).toBeTypeOf('number')
        expect(endBlocksOf(msgId)).toHaveLength(1)

        // worker 迟到的 done（terminate 后事件仍可能已在主线程队列里）
        const guard = watchUnhandled()
        await feed({type: 'done', reason: 'aborted'})
        await vi.advanceTimersByTimeAsync(0)
        guard.stop()

        expect(readRow(msgId)?.ended_at).toBe(afterFallback)
        expect(endBlocksOf(msgId)).toHaveLength(1)
        expect(guard.list).toHaveLength(0)
    })

    it('b1) pending 存在但内容为空 + DB 无行：不得凭空建出空消息行/空块，且不得抛错', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        // 空 thinking 事件即创建 pending（manager.impl.ts:1167-1169），但无任何正文/工具
        await feed({type: 'thinking', content: ''})
        const pending = getPending()
        expect(pending).not.toBeNull()
        expect(pending!.content).toBe('')
        expect(pending!.toolCalls).toHaveLength(0)
        expect(countRows()).toBe(0)

        // ★ 剥离 persistence 干扰：清空累积 patch 与节流定时器，
        //   确保随后窗口推进期间不会有 flush 路径（ensureMessageRow→writeBlockDelta）建行，
        //   使观测到的行/块只能来自 abort 兜底。
        resetPersistenceState()

        const guard = watchUnhandled()
        await manager.abort(CONV)
        await advanceGracefulWindow()
        guard.stop()

        expect(countRows()).toBe(0)                                    // 无凭空消息行
        expect(db.prepare('SELECT COUNT(*) AS c FROM message_blocks').get()).toMatchObject({c: 0})
        expect(guard.list).toHaveLength(0)                             // 兜底异常已被吞（不得逃逸）
        expect(worker.terminate).toHaveBeenCalled()
    })

    it('b2) pending 有正文 + DB 尚无行（首 flush 前终止）：兜底可补写正文行，但不得写垃圾块', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '首 flush 之前就被终止的正文'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'sleep 60'}}})
        const msgId = getPending()!.id
        expect(countRows()).toBe(0)
        // 同 b1：剥离 persistence flush 路径干扰，只观测兜底自身写下的内容
        resetPersistenceState()

        const guard = watchUnhandled()
        await manager.abort(CONV)
        await advanceGracefulWindow()
        guard.stop()

        const row = readRow(msgId)
        expect(row).toBeDefined()                                  // 有正文时兜底必须补写（不得丢正文）
        const blocks = blocksOf(msgId)
        // eslint-disable-next-line no-console -- 观测点：兜底全量写路径的块构成
        console.log('[verify] b2 兜底补写的块类型 =', blocks.map(b => `${b.block_type}:${b.content === null ? 'null' : b.content.length}`).join(', '))
        const text = blocks.filter(b => b.block_type === 'text')
        expect(text.length).toBeGreaterThan(0)
        expect(text.map(b => b.content ?? '').join('')).toContain('首 flush 之前就被终止的正文')
        // 不得出现预料之外的块类型（尤其空 think 块等垃圾块）
        expect(new Set(blocks.map(b => b.block_type))).toSatisfy((s: Set<string>) =>
            [...s].every(t => ['text', 'tool_call', 'end'].includes(t)))
        for (const b of blocks) {
            if (b.block_type === 'text') expect(b.content).toBeTruthy()
        }
        expect(row!.ended_at).toBeTypeOf('number')
        expect(guard.list).toHaveLength(0)
    })

    it('c1) 接管发生在首检之前（模拟 start() 重建）：新 worker 绝不得被 terminate/cleanup', async () => {
        const oldWorker = makeWorker()
        injectWorker(CONV, oldWorker)

        await feed({type: 'text', content: '旧会话进行中的内容'})
        const oldMsgId = getPending()!.id
        persistence.flush(CONV)
        const beforeAbort = readRow(oldMsgId)
        expect(beforeAbort?.ended_at).toBeNull()

        await manager.abort(CONV)                 // 定时器 A

        // 复刻 start() 的接管语义（manager.impl.ts:231-233、258）
        await manager.abort(CONV, false)          // 定时器 B（start 内部先 abort）
        const newWorker = makeWorker()
        setPending(null)
        injectWorker(CONV, newWorker)

        await advanceGracefulWindow()

        expect(newWorker.terminate).not.toHaveBeenCalled()                    // 不误杀新 worker
        expect(getWorkerEntry(CONV)?.worker).toBe(newWorker)                 // 新 entry 未被 cleanup 删除
        expect(oldWorker.terminate).not.toHaveBeenCalled()                   // 首检失败 → 旧回调整体早退
        // 观测（非断言目标）：接管场景下旧消息 ended_at 是否仍为 NULL —— 见报告
        // eslint-disable-next-line no-console -- 观测点，供人工核对覆盖缺口
        console.log('[verify] c1 旧消息 ended_at =', readRow(oldMsgId)?.ended_at, 'end 块数 =', endBlocksOf(oldMsgId).length)
    })

    it('c2) 接管发生在兜底中途（await 之后）：新 worker 存活，但兜底是否误终结新消息', async () => {
        const oldWorker = makeWorker()
        injectWorker(CONV, oldWorker)

        await feed({type: 'text', content: '旧会话内容'})
        const oldMsgId = getPending()!.id

        // 新 worker 的「进行中」消息（已落行 + 块，ended_at 为 NULL）——模拟 start() 后新轮已开跑
        const newPending = createPendingMsg()
        db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(newPending.id, CONV, 'assistant', newPending.timestamp, null, '{}', null, 1)
        db.prepare('INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(`text-${newPending.id}-0`, newPending.id, 'text', '新轮进行中', '{}', 0, newPending.timestamp, null, 0)

        const newWorker = makeWorker()
        const origFinalize = persistence.finalizeMessage.bind(persistence)
        vi.spyOn(persistence, 'finalizeMessage').mockImplementation((c: string, m: string, t: number) => {
            // 在兜底已通过首检、即将 finalize 的时刻接管会话
            setPending(newPending)
            injectWorker(CONV, newWorker)
            return origFinalize(c, m, t)
        })

        await manager.abort(CONV)
        await advanceGracefulWindow()

        expect(newWorker.terminate).not.toHaveBeenCalled()                   // 复检生效：不误杀
        expect(getWorkerEntry(CONV)?.worker).toBe(newWorker)
        // 观测：新轮消息的 ended_at 是否被兜底提前写死（潜在的「误终结」）
        // eslint-disable-next-line no-console -- 观测点
        console.log('[verify] c2 新消息 ended_at =', readRow(newPending.id)?.ended_at, '（NULL = 未被误终结）',
            '| 旧消息 ended_at =', readRow(oldMsgId)?.ended_at)
    })

    it('d) 行存在且 ended_at 为 NULL：兜底补出的 end 块与 messages.ended_at 同源，且 end 恒为最大 sequence', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '正文A'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'sleep 60'}}})
        const msgId = getPending()!.id
        persistence.flush(CONV)                      // 行 + 精细块已落库，ended_at 仍为 NULL
        const before = readRow(msgId)
        expect(before?.ended_at).toBeNull()
        expect(blocksOf(msgId).length).toBeGreaterThan(0)

        await manager.abort(CONV)
        await advanceGracefulWindow()

        const row = readRow(msgId)!
        const ends = endBlocksOf(msgId)
        expect(ends).toHaveLength(1)
        expect(row.ended_at).toBeTypeOf('number')
        expect(ends[0].ended_at).toBe(row.ended_at)                              // 块 ended_at 与列同源
        expect(JSON.parse(ends[0].data ?? '{}').endedAt).toBe(row.ended_at)       // data.endedAt 与列同源
        expect(row.ended_at!).toBeGreaterThanOrEqual(row.timestamp)
        const maxSeq = Math.max(...blocksOf(msgId).map(b => b.sequence))
        expect(ends[0].sequence).toBe(maxSeq)                                    // end 恒为最大 sequence
    })

    it('e) fail-open：ended_at 查询抛错时必须仍补写终止时间（不得静默漏写）', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '查询会失败但仍须收尾'})
        const msgId = getPending()!.id
        persistence.flush(CONV)

        const origPrepare = db.prepare.bind(db)
        vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
            if (typeof sql === 'string' && sql.includes('SELECT ended_at FROM messages')) {
                throw new Error('boom: 查询 ended_at 失败')
            }
            return origPrepare(sql as any)
        }) as any)

        await manager.abort(CONV)
        await advanceGracefulWindow()

        vi.mocked(db.prepare).mockRestore()
        expect(readRow(msgId)?.ended_at).toBeTypeOf('number')   // fail-open 生效
    })

    it('g) 兜底 finalize 自身抛错：必须被吞并告警，且 terminate/cleanup 链路不得被阻断', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: 'finalize 会抛错'})
        const msgId = getPending()!.id
        persistence.flush(CONV)

        vi.spyOn(persistence, 'finalizeMessage').mockImplementation(() => {
            throw new Error('boom: finalize 抛错')
        })

        const guard = watchUnhandled()
        await manager.abort(CONV)
        await advanceGracefulWindow()
        guard.stop()

        expect(guard.list).toHaveLength(0)                       // 异常不得逃逸（setTimeout 回调最后兜底）
        expect(worker.terminate).toHaveBeenCalledTimes(1)        // 收尾链路不被阻断
        expect(getWorkerEntry(CONV)).toBeUndefined()             // cleanup 正常执行
        // 观测：finalize 失败时 ended_at 仍缺失（与 JSDoc「终止时间仍缺失」一致，属 fail-silent 取舍）
        // eslint-disable-next-line no-console -- 观测点
        console.log('[verify] g finalize 抛错后 ended_at =', readRow(msgId)?.ended_at)
    })

    it('h) 行存在且 ended_at 非 NULL（半笔：无 end 块）：兜底不得覆盖，也不补块（JSDoc 语义复检）', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '半笔状态：列有值、块缺失'})
        const msgId = getPending()!.id
        persistence.flush(CONV)
        db.prepare('UPDATE messages SET ended_at = ? WHERE id = ?').run(12345, msgId)
        expect(endBlocksOf(msgId)).toHaveLength(0)

        await manager.abort(CONV)
        await advanceGracefulWindow()

        expect(readRow(msgId)?.ended_at).toBe(12345)             // 不覆盖既有结束时间（注释声明）
        // 观测：早退导致半笔状态（有 ended_at 无 end 块）不被修复
        // eslint-disable-next-line no-console -- 观测点
        console.log('[verify] h 半笔状态的 end 块数 =', endBlocksOf(msgId).length)
    })

    it('f) 重复 abort（用户连点终止）：幂等，ended_at 单值、end 块唯一、无未处理异常', async () => {
        const worker = makeWorker()
        injectWorker(CONV, worker)

        await feed({type: 'text', content: '连点终止'})
        const msgId = getPending()!.id

        const guard = watchUnhandled()
        await manager.abort(CONV)
        await manager.abort(CONV)
        await advanceGracefulWindow()
        guard.stop()

        const row = readRow(msgId)!
        expect(row.ended_at).toBeTypeOf('number')
        expect(endBlocksOf(msgId)).toHaveLength(1)
        expect(guard.list).toHaveLength(0)
    })
})
