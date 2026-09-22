/**
 * ★ 手动终止兜底收尾护栏：abort 后 assistant 消息必须有 ended_at
 *
 * 背景（缺陷）：abort() 在 WORKER_GRACEFUL_SHUTDOWN_MS 优雅窗口到期后直接
 * worker.terminate() + cleanup()；cleanup() 只丢弃 pendingAssistantMsg（不 finalize、
 * 不写 messages.ended_at），随后的 persistence.flush() + clearConversation() 也只写
 * 已累积的增量 patch。于是只要 worker 未在窗口内把 done(aborted) 回送主进程
 * （例如正在跑 bash 工具、正在等子 agent），该 assistant 消息的 ended_at 永久为
 * NULL——表现为「手动终止后没有记录终止时间」。
 *
 * 本用例断言（a）未发 done 时 abort 到期后 ended_at 非 NULL 且 ≥ timestamp；
 * （b）已落 ended_at 的消息不被兜底覆盖为更晚值（幂等）。
 *
 * 环境搭建对齐 manager.resultShrink.test.ts / manager.blockingSnapshot.e2e.test.ts：
 * config 重定向 tmpdir（绝不触碰真实 ~/.hclaw/data/hclaw.db）+ electron 空壳 +
 * 内存 sqlite（真实 schema 子集）；workers Map 直接注入假 worker，不 spawn 真实线程。
 * 优雅窗口的 1 秒用假定时器推进，绝不真等。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 隔离：config 重定向到独立临时目录 ──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-abort-finalize-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

// ── electron 空壳 ──
vi.mock('electron', () => ({
    BrowserWindow: class { static getAllWindows() { return [] } },
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'
import {WORKER_GRACEFUL_SHUTDOWN_MS} from '@/main/agent/manager.constants'
import type {PendingAssistantMsg} from '@/main/agent/manager.types'
import {getConversationPersistence} from '@/main/persistence/conversationPersistence'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {SqliteConversationRepository} from '@/main/repositories/sqlite/conversationRepository'
import {convertUserHistoryMessage} from '@/main/agent/utils/userContentBuilder'
import {convertAssistantHistoryMessage} from '@/main/agent/ipc/historyConverter'
import {PreprocessCache} from '@/main/agent/loop/preprocessCache'
import {normalizeToolCallMessages} from '@/main/agent/state'
import type {ChatMessage} from '@/main/agent/state'
import {AnthropicAdapter} from '@/main/agent/model/anthropicAdapter'

const CONV = 'conv-abort-finalize'

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

/** 重置 persistence 单例的进程内状态（定时器/监听器），防跨用例串扰 */
function resetPersistenceState(): void {
    const st: Map<string, {timer: ReturnType<typeof setTimeout> | null}> = (persistence as any).states
    for (const s of st.values()) if (s.timer) clearTimeout(s.timer)
    st.clear()
    ;(persistence as any).listeners.clear()
}

/** 注入假 worker（abort 只消费 postMessage / terminate 与 abortController） */
function injectWorker(convId: string, worker: {postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>}): void {
    const map = (manager as unknown as {workers: Map<string, unknown>}).workers
    map.set(convId, {worker, abortController: new AbortController()})
}

/** 经真实 handleStreamEvent 累积事件（与生产同路径） */
async function feed(event: unknown): Promise<void> {
    await (manager as any).handleStreamEvent(CONV, null, event)
}

function getPending(): PendingAssistantMsg {
    return (manager as any).pendingAssistantMsg.get(CONV)
}

function readRow(msgId: string): {timestamp: number; ended_at: number | null} {
    return db.prepare('SELECT timestamp, ended_at FROM messages WHERE id = ?').get(msgId) as {timestamp: number; ended_at: number | null}
}

/** 推进优雅窗口：假定时器 + await 异步回调（含动态 import 的微任务链） */
async function advanceGracefulWindow(): Promise<void> {
    await vi.advanceTimersByTimeAsync(WORKER_GRACEFUL_SHUTDOWN_MS)
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
    closeDatabase()
    vi.restoreAllMocks()
})

describe('★ abort 兜底收尾：ended_at 必落库', () => {
    it('(a) worker 未回送 done(aborted) → 优雅窗口到期后该消息 ended_at 非 NULL 且 ≥ timestamp', async () => {
        const postMessage = vi.fn()
        const terminate = vi.fn()
        injectWorker(CONV, {postMessage, terminate})

        // 运行态：文本 + 工具调用（工具进行中即「worker 来不及回 done」的典型场景）
        await feed({type: 'agent_start', agentType: 'general', model: 'test-model'})
        await feed({type: 'text', content: '正在执行长任务…'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'sleep 60'}}})
        const msgId = getPending().id

        // 运行中已按节流落库（消息行 + 块），此时 ended_at 必为 NULL —— 缺陷的起点
        persistence.flush(CONV)
        const before = readRow(msgId)
        expect(before.ended_at).toBeNull()

        // 用户手动终止：worker 不回 done（不喂任何 done 事件）
        await manager.abort(CONV)
        expect(postMessage).toHaveBeenCalledWith({type: WORKER_MESSAGE_TYPES.ABORT})

        await advanceGracefulWindow()

        const after = readRow(msgId)
        expect(after.ended_at).not.toBeNull()
        expect(after.ended_at!).toBeGreaterThanOrEqual(after.timestamp)
        // end 块同样补齐（与 ended_at 同源，验证走的是真实 finalize 而非旁路写）
        const endBlocks = db.prepare("SELECT id FROM message_blocks WHERE message_id = ? AND block_type = 'end'").all(msgId)
        expect(endBlocks).toHaveLength(1)
        expect(terminate).toHaveBeenCalled()
    })

    it('(b) 已落 ended_at 的消息：abort 兜底不得覆盖为更晚的值（幂等）', async () => {
        const terminate = vi.fn()
        injectWorker(CONV, {postMessage: vi.fn(), terminate})

        await feed({type: 'text', content: '任务已完成'})
        const msgId = getPending().id

        // 对照：done 已正常回送并走过 finalize（ended_at 已落库）
        await (manager as any).handleDoneEvent(CONV, {type: 'done', reason: 'completed'})
        const finalizedAt = readRow(msgId).ended_at
        expect(finalizedAt).not.toBeNull()

        // 优雅窗口到期（时间前进 1s）：兜底必须识别「已终结」并原值返回
        await manager.abort(CONV)
        await advanceGracefulWindow()

        const after = readRow(msgId)
        expect(after.ended_at).toBe(finalizedAt)
        const endBlocks = db.prepare("SELECT id FROM message_blocks WHERE message_id = ? AND block_type = 'end'").all(msgId)
        expect(endBlocks).toHaveLength(1)   // 不得补出第二个 end 块
    })

    it('(c) 无 pending 时兜底安全空转：不建行、不抛错', async () => {
        const terminate = vi.fn()
        injectWorker(CONV, {postMessage: vi.fn(), terminate})

        await manager.abort(CONV)
        await advanceGracefulWindow()

        const rows = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(CONV)
        expect(rows).toHaveLength(0)
        expect(terminate).toHaveBeenCalled()
    })
})


// ─────────────────────────────────────────────────────────
// P1-5 abort 后继续的前缀一致
//   abort 产生的半成品 assistant 行（含 [INTERRUPTED] 合成 tool_result、isolated
//   tool_use 合成）在重建后必须与下一轮请求前缀逐字节相等；且 abort → 继续
//   不得引入额外分叉（前部字节不动）。
// ─────────────────────────────────────────────────────────
const PREFIX_MODEL = 'claude-sonnet-4-20250514'
const PREFIX_SYSTEM = 'You are a helpful agent.'

/** 请求前缀：真实 AnthropicAdapter 组装的 {system, tools, messages} 字节 */
async function capturePrefix(messages: ReadonlyArray<ChatMessage>): Promise<{snapshot: string; api: any[]}> {
    const captured: any[] = []
    const fakeClient = {
        baseURL: '',
        messages: {
            stream: (params: any) => {
                captured.push(params)
                // eslint-disable-next-line require-yield -- 无流事件：只关心请求体
                return {abort() { /* no-op */ }, async *[Symbol.asyncIterator]() { /* 空流 */ }}
            },
        },
    }
    const adapter = new AnthropicAdapter(
        {model: PREFIX_MODEL, features: {systemContentBlocks: true}} as never, fakeClient as never)
    for await (const _chunk of adapter.chat({
        messages: [...messages], systemPrompt: PREFIX_SYSTEM, tools: [], maxTokens: 1024,
    } as never)) { void _chunk }
    const req = captured[0]
    return {
        snapshot: JSON.stringify({system: req.system ?? null, tools: req.tools ?? null, messages: req.messages}),
        api: req.messages,
    }
}

/** user 行落库（正文落 metadata.content；读侧展开到顶层） */
function writeUserRow(id: string, content: string, timestamp: number): void {
    new SqliteConversationRepository().writeMessagesDelta(
        CONV, {id, role: 'user', content, timestamp} as never)
}

/** startAgentCore.ts:201-220 同款历史重建 */
async function rebuildFromDb(): Promise<ChatMessage[]> {
    const rows = new SqliteConversationRepository().readMessages(CONV) as unknown as Array<Record<string, unknown>>
    const out: ChatMessage[] = []
    for (const row of rows) {
        if (row.role === 'user') {
            out.push(...(await convertUserHistoryMessage(row as never) as ChatMessage[]))
        } else if (row.role === 'assistant') {
            out.push(...(convertAssistantHistoryMessage(row) as ChatMessage[]))
        }
    }
    return out
}

/** 内存态 assistant（loop 内「一次 LLM 调用 = 一条 assistant」形态） */
function memoryAssistant(pending: PendingAssistantMsg): ChatMessage {
    return {
        id: pending.id,
        role: 'assistant',
        content: (pending.contentParts ?? []).join(''),
        toolCalls: pending.toolCalls.map(tc => ({id: tc.id, name: tc.name, arguments: tc.arguments})),
    } as unknown as ChatMessage
}

const userMsg = (id: string, content: string): ChatMessage =>
    ({id, role: 'user', content} as ChatMessage)

describe('P1-5 abort 后继续：半成品 assistant 行的重建前缀一致性', () => {
    // readMessages 会批量查 llm_usage（B1 双源合并）；本文件既有 seedSchema 未建该表，
    // 缺失时 repo 会打 console.error 噪音（不影响结果）—— 仅为本 describe 补表消噪。
    beforeEach(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS llm_usage (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
            provider_type TEXT NOT NULL, model TEXT NOT NULL, provider_name TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER NOT NULL DEFAULT 0,
            ttft_ms INTEGER, decode_ms INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )`)
    })

    it('abort 半成品行（isolated tool_use → [INTERRUPTED] 合成）重建后与内存态下一轮请求前缀逐字节相等', async () => {
        injectWorker(CONV, {postMessage: vi.fn(), terminate: vi.fn()})

        writeUserRow('u1', '跑一下长任务', Date.now())
        await feed({type: 'agent_start', agentType: 'general', model: PREFIX_MODEL})
        await feed({type: 'text', content: '正在执行长任务…'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'sleep 60'}}})
        const pending: PendingAssistantMsg = {...getPending(), toolCalls: [...getPending().toolCalls]}

        // 用户手动终止（worker 不回 done）
        await manager.abort(CONV)
        await advanceGracefulWindow()
        expect(readRow(pending.id).ended_at).not.toBeNull()

        // abort 后继续：新用户消息落库（timestamp 晚于半成品行）
        vi.setSystemTime(Date.now() + 1000)
        writeUserRow('u2', '继续', Date.now())

        // ── 内存态：loop 内未落库时的 request 序列 ──
        const memoryApi = new PreprocessCache().process([
            userMsg('u1', '跑一下长任务'), memoryAssistant(pending), userMsg('u2', '继续'),
        ])
        // ── 重建态：仅按 DB 重建 ──
        const rebuilt = await rebuildFromDb()
        // 重建路径自身为 isolated tool_use 合成 [INTERRUPTED] tool 消息（historyConverter）
        expect(rebuilt.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
        const rebuiltApi = new PreprocessCache().process(rebuilt)

        const a = await capturePrefix(memoryApi)
        const b = await capturePrefix(rebuiltApi)
        expect(b.snapshot).toBe(a.snapshot)
        // 合成确为 [INTERRUPTED]（isolated tool_use 兜底）：apiMessages = [u1, assistant, user(tool_result), u2]
        expect(b.api[2].content[0].content).toContain('[INTERRUPTED]')
    })

    it('合成内容确定性：同输入两次合成字节相等（重复调用 + 跨 PreprocessCache 实例）', async () => {
        injectWorker(CONV, {postMessage: vi.fn(), terminate: vi.fn()})

        await feed({type: 'text', content: '正在执行…'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'sleep 60'}}})
        const pending: PendingAssistantMsg = {...getPending(), toolCalls: [...getPending().toolCalls]}
        await manager.abort(CONV)
        await advanceGracefulWindow()

        const input = [userMsg('u1', '跑一下'), memoryAssistant(pending)]
        const once = normalizeToolCallMessages(input)
        const twice = normalizeToolCallMessages(input)
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
        expect(new PreprocessCache().process(input)).toEqual(new PreprocessCache().process(input))
        expect(new PreprocessCache().process(input)).toEqual(once)
        expect(once.filter(m => m.isError === true)).toHaveLength(1)
    })

    it('abort→继续不引入额外分叉：下一轮请求以 abort 时点的前缀为前缀（只在尾部追加用户新输入）', async () => {
        injectWorker(CONV, {postMessage: vi.fn(), terminate: vi.fn()})

        await feed({type: 'agent_start', agentType: 'general', model: PREFIX_MODEL})
        await feed({type: 'text', content: '正在执行…'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'ls'}}})
        const pending: PendingAssistantMsg = {...getPending(), toolCalls: [...getPending().toolCalls]}

        await manager.abort(CONV)
        await advanceGracefulWindow()

        // abort 时点：u1 + 半成品 assistant（含合成 [INTERRUPTED] tool_result）
        const atAbort = await capturePrefix(new PreprocessCache().process([
            userMsg('u1', '跑一下'), memoryAssistant(pending),
        ]))
        // abort 后继续：同上 + 新用户输入
        const afterAbort = await capturePrefix(new PreprocessCache().process([
            userMsg('u1', '跑一下'), memoryAssistant(pending), userMsg('u2', '继续'),
        ]))

        expect(atAbort.api.length).toBe(3)      // u1 / assistant(tool_use) / user(合成 tool_result)
        expect(afterAbort.api.length).toBe(4)   // + 新用户输入
        expect(afterAbort.api[2].content[0].content).toContain('[INTERRUPTED]')
        // 前缀逐字节不变（abort 不改写既有段、不重排）
        expect(JSON.stringify(afterAbort.api.slice(0, atAbort.api.length))).toBe(JSON.stringify(atAbort.api))
        expect(afterAbort.api.slice(0, atAbort.api.length).map((m: any) => m.role))
            .toEqual(atAbort.api.map((m: any) => m.role))
    })

    // ★ 回归护栏（缺陷已修复）：正常完成（tool_result 已回送）的 assistant 行，其 tool_call
    //   块 data 带 textOffset ⇒ blocksToMessage 的 textOffset 防御性重排（messageBlockHelper.ts）
    //   会重建 text 块；修复前产物 `rt-*` 不带 turnIndex，convertFromTurnIndex 会丢弃
    //   「首个无 turnIndex 块」（historyConverter.ts）⇒ 重建出的 assistant 正文为空、
    //   请求前缀丢中段正文。现重排产物继承原 text 块的 turnIndex，正文完整。
    it('正常完成（带 tool_result）的 assistant 行重建后不得丢正文', async () => {
        injectWorker(CONV, {postMessage: vi.fn(), terminate: vi.fn()})

        writeUserRow('u1', '跑一下', Date.now())
        await feed({type: 'agent_start', agentType: 'general', model: PREFIX_MODEL})
        await feed({type: 'text', content: '正在执行…'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {command: 'ls'}}})
        await feed({type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'ok'}})
        await (manager as any).handleDoneEvent(CONV, {type: 'done', reason: 'completed'})
        persistence.flush(CONV)

        const rebuilt = await rebuildFromDb()
        const assistant = rebuilt.find(m => m.role === 'assistant')
        expect(assistant).toBeDefined()
        expect(String(assistant!.content)).toBe('正在执行…')
    })
})
