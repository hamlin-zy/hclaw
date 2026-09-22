/**
 * 语言守卫真实链路集成测试（spec §9 T4 / T5 / T6）
 *
 * 为什么必须走真实链路：T4 的对象就是「DB 往返是否保留 metadata 白名单之外的字段」。
 * 在内存里直接构造带 metadata 的消息永远看不到丢字段的问题。
 * 组装范式参照 catalog.integration.test.ts（临时 SQLite + 真实
 * SqliteConversationRepository + 真实 convertUserHistoryMessage /
 * convertAssistantHistoryMessage）。
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 独立临时目录。
 *
 * ⚠️ seq() 是**规范化**序列化（对象 key 排序）：DB 重建出来的消息字面量键序
 * （role, content, id, ...）与内存态构造顺序不同，而 LLM 请求字节由各 adapter 按
 * 固定 schema 序列化，与 JS 对象的 key 插入顺序无关。比较的是"消息顺序 + 每条消息的
 * 键集合与值"，键序不参与。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-language-guard-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('../../../../src/main/hclawPaths', async () => await import('../../../../src/main/config'))

import {getDatabase, closeDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'
import type {Message, SystemSettings} from '../../../../src/shared/types'
import {SOURCE_KIND_LANGUAGE_GUARD} from '../../../../src/shared/types/message'
import {
    restoreLanguageGuardState,
    runLanguageGuardPreStep,
} from '../../../../src/main/agent/loop/languageGuardPublish'
import {createLoopState, addMessage, type LoopState} from '../../../../src/main/agent/state'
import type {ChatMessage} from '../../../../src/main/agent/state'
import {convertUserHistoryMessage} from '../../../../src/main/agent/utils/userContentBuilder'
import {convertAssistantHistoryMessage} from '../../../../src/main/agent/ipc/historyConverter'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'

const CONV_ID = 'conv-lg-it'
const CN: SystemSettings = {
    language: {nativeLocale: 'zh-CN', strategy: 'first-and-drift', correctionLimit: 3},
} as SystemSettings
/** 漂移样本：0 汉字、纯拉丁字母（≥ DRIFT_MIN_SAMPLE） */
const DRIFT_TEXT = 'I have refactored the module and all tests pass now so please continue.'

/** 规范化序列化（key 排序），仅用于前缀比对 —— 理由见文件头注释 */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        return Object.fromEntries(Object.keys(obj).sort().map(k => [k, canonical(obj[k])]))
    }
    return value
}
const seq = (messages: ReadonlyArray<ChatMessage>) => JSON.stringify(messages.map(canonical))

function lgMessages(state: LoopState): ChatMessage[] {
    return state.messages.filter(m =>
        (m.metadata as Record<string, unknown> | undefined)?.sourceKind === SOURCE_KIND_LANGUAGE_GUARD)
}

/** user 消息行落库（真实写入路径；user 正文落 metadata.content） */
function writeUserRow(repo: SqliteConversationRepository, id: string, content: string, timestamp: number): void {
    repo.writeMessagesDelta(CONV_ID, {id, role: 'user', content, timestamp} as unknown as Message)
}

/**
 * assistant 行落库：一次用户发言 = 一条 assistant 行，行内多轮 LLM 调用用 turnIndex 区分
 * （§3.2 的粒度事实 —— 本函数是 T6 反例的关键构造）
 */
function writeAssistantRow(
    repo: SqliteConversationRepository,
    id: string,
    blocks: Array<{id: string; text: string; turnIndex: number}>,
    timestamp: number,
): void {
    repo.writeMessagesDelta(CONV_ID, {
        id,
        role: 'assistant',
        content: '',
        timestamp,
        contentBlocks: blocks.map(b => ({id: b.id, type: 'text' as const, text: b.text, turnIndex: b.turnIndex})),
    } as unknown as Message)
}

/** execution.ts / startAgentCore 同款重建：user 走转换函数，assistant 走 historyConverter */
async function rebuildFromDb(repo: SqliteConversationRepository): Promise<ChatMessage[]> {
    const rows = repo.readMessages(CONV_ID) as Array<Message & Record<string, unknown>>
    const rebuilt: ChatMessage[] = []
    for (const row of rows) {
        if (row.role === 'user') {
            rebuilt.push(...await convertUserHistoryMessage(
                row as unknown as Parameters<typeof convertUserHistoryMessage>[0]))
        } else if (row.role === 'assistant') {
            rebuilt.push(...convertAssistantHistoryMessage(row))
        }
    }
    return rebuilt
}

let repo: SqliteConversationRepository

beforeEach(() => {
    repo = new SqliteConversationRepository()
    const db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS llm_usage')
    db.exec('DROP TABLE IF EXISTS conversations')
    // 最小 schema（与迁移 001 + 006 对齐，参照 catalog.integration.test.ts harness）
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
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER, turn_index INTEGER,
        FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
        provider_type TEXT NOT NULL, model TEXT NOT NULL, provider_name TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER, decode_ms INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )`)
    db.exec('PRAGMA foreign_keys = ON')
    repo.create(CONV_ID, {
        id: CONV_ID, title: 't', workspacePath: '/tmp/test-ws',
        createdAt: 1, updatedAt: 1, preview: '', status: 'active',
    })
})

afterEach(() => {
    vi.useRealTimers()
    closeDatabase()
})

describe('§9-T4 崩溃重启不重复 seed（真实链路）', () => {
    it('落库 → 读回 → user 重建 → createLoopState → restore：两字段不丢、零重复 seed', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T10:00:00'))

        writeUserRow(repo, 'u1', '你好', Date.now())
        const state = createLoopState([{id: 'u1', role: 'user', content: '你好'} as ChatMessage])
        const r1 = runLanguageGuardPreStep(state, restoreLanguageGuardState(state.messages), repo, CONV_ID, CN)
        const injected = lgMessages(r1.state)[0]
        expect(injected).toBeDefined()

        // ① DB 读侧约定：metadata 展开到消息顶层
        const rows = repo.readMessages(CONV_ID) as Array<Message & Record<string, unknown>>
        const back = rows.find(m => m.id === injected.id)
        expect(back).toBeDefined()
        expect(back!.sourceKind).toBe(SOURCE_KIND_LANGUAGE_GUARD)
        expect(back!.languageGuardCount).toBe(1)
        expect(back!.languageGuardDigest).toBe('zh-CN')

        // ② 白名单收拢：漏收拢则下面两个字段在 metadata 里消失
        const rebuilt = await rebuildFromDb(repo)
        const rebuiltInjected = rebuilt.find(m => m.id === injected.id)
        expect(rebuiltInjected).toBeDefined()
        expect(rebuiltInjected!.metadata).toMatchObject({
            sourceKind: SOURCE_KIND_LANGUAGE_GUARD,
            languageGuardCount: 1,
            languageGuardDigest: 'zh-CN',
        })

        // ③ 恢复后状态正确
        const revived = createLoopState(rebuilt)
        const restored = restoreLanguageGuardState(revived.messages)
        expect(restored).toEqual({seeded: true, injectedCount: 1, localeDigest: 'zh-CN'})

        // ④ 恢复后再跑 pre-step：零注入、零落库（重启不重复 seed、配额不重置）
        const before = repo.readMessages(CONV_ID).length
        const r2 = runLanguageGuardPreStep(revived, restored, repo, CONV_ID, CN)
        expect(lgMessages(r2.state)).toHaveLength(1)
        expect(repo.readMessages(CONV_ID).length).toBe(before)
    })
})

describe('§9-T5 同 run 内前缀契约', () => {
    it('注入只追加：前部逐字节不动，新消息落在末尾', () => {
        const prev: ChatMessage[] = [
            {id: 'u1', role: 'user', content: '继续'},
            {id: 'a1', role: 'assistant', content: DRIFT_TEXT},
        ]
        const state = createLoopState(prev)
        const r = runLanguageGuardPreStep(
            state, {seeded: true, injectedCount: 1, localeDigest: 'zh-CN'}, null, undefined, CN)
        expect(r.state.messages.length).toBe(prev.length + 1)
        expect(seq(r.state.messages.slice(0, prev.length))).toBe(seq(prev))
    })

    it('旧 language-guard 消息 content 字节不动，新消息追加在尾部', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T10:00:00'))
        const u1 = {id: 'u1', role: 'user', content: '你好'} as ChatMessage
        const r1 = runLanguageGuardPreStep(
            createLoopState([u1]), {seeded: false, injectedCount: 0}, repo, CONV_ID, CN)
        const first = lgMessages(r1.state)[0]
        const firstContent = String(first.content)

        vi.setSystemTime(new Date('2026-09-21T10:01:00'))
        const withAssistant = addMessage(r1.state, {id: 'a1', role: 'assistant', content: DRIFT_TEXT} as ChatMessage)
        const r2 = runLanguageGuardPreStep(withAssistant, r1.languageGuardState, repo, CONV_ID, CN)

        const all = lgMessages(r2.state)
        expect(all).toHaveLength(2)
        expect(all[0].id).toBe(first.id)
        expect(String(all[0].content)).toBe(firstContent)
        expect(seq(r2.state.messages.slice(0, withAssistant.messages.length))).toBe(seq(withAssistant.messages))
    })
})

describe('§9-T6 跨 run 重建前缀契约（§3.2 硬约束护栏）', () => {
    it('正例：注入在 run 首次迭代 → 重建序列中位置一致、前缀逐字节相等', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T10:00:00'))
        const cacheRun = new PreprocessCache()
        const cacheRebuilt = new PreprocessCache()

        writeUserRow(repo, 'u1', '你好', Date.now())
        const r1 = runLanguageGuardPreStep(
            createLoopState([{id: 'u1', role: 'user', content: '你好'} as ChatMessage]),
            restoreLanguageGuardState([]), repo, CONV_ID, CN)
        const injected = lgMessages(r1.state)[0]
        const runMsgs = cacheRun.process([...r1.state.messages])   // 本 turn 首次 LLM 调用请求序列

        // 本轮结束：assistant 行落库（timestamp 晚于注入消息 —— §3.2 成立的原因）
        vi.setSystemTime(new Date('2026-09-21T10:00:30'))
        writeAssistantRow(repo, 'a-turn', [{id: 'cb1', text: '好的，我改用中文回答。', turnIndex: 0}], Date.now())

        // 跨 run 重建（崩溃重启同路径）
        const revived = createLoopState(await rebuildFromDb(repo))
        const revivedMsgs = cacheRebuilt.process([...revived.messages])

        const injContent = String(injected.content)
        const idxRun = runMsgs.findIndex(m => String(m.content) === injContent)
        const idxRebuilt = revivedMsgs.findIndex(m => String(m.content) === injContent)
        expect(idxRun).toBe(1)                       // 紧跟 u1（assistant 行尚未创建）
        expect(idxRebuilt).toBe(idxRun)              // 位置未被 assistant 行跨越
        expect(seq(revivedMsgs.slice(0, idxRebuilt + 1))).toBe(seq(runMsgs.slice(0, idxRun + 1)))
    })

    it('反例（证明本护栏有判别力）：注入晚于 assistant 行 → 重建把注入排到 assistant 之后，前缀分叉', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T10:00:00'))
        const cacheRun = new PreprocessCache()
        const cacheRebuilt = new PreprocessCache()

        writeUserRow(repo, 'u1', '你好', Date.now())
        vi.setSystemTime(new Date('2026-09-21T10:00:30'))
        // 一次用户发言 = 一条 assistant 行，行内两个 turnIndex（= 两次 LLM 调用）
        writeAssistantRow(repo, 'a-turn', [
            {id: 'cb1', text: 'first call', turnIndex: 0},
            {id: 'cb2', text: 'second call', turnIndex: 1},
        ], Date.now())

        // run 内：iteration ≥2 中途注入 —— 内存态里它夹在两次 LLM 调用之间
        vi.setSystemTime(new Date('2026-09-21T10:01:00'))   // 晚于 assistant 行
        const u1 = {id: 'u1', role: 'user', content: '你好'} as ChatMessage
        const a1 = {id: 'a1', role: 'assistant', content: 'first call'} as ChatMessage
        const a2 = {id: 'a2', role: 'assistant', content: 'second call'} as ChatMessage
        const r = runLanguageGuardPreStep(
            createLoopState([u1, a1]), {seeded: false, injectedCount: 0}, repo, CONV_ID, CN)
        const injected = lgMessages(r.state)[0]
        const runMsgs = cacheRun.process([...r.state.messages, a2])

        const revived = createLoopState(await rebuildFromDb(repo))
        const revivedMsgs = cacheRebuilt.process([...revived.messages])

        const injContent = String(injected.content)
        const idxRun = runMsgs.findIndex(m => String(m.content) === injContent)
        const idxRebuilt = revivedMsgs.findIndex(m => String(m.content) === injContent)
        expect(idxRun).toBe(2)                        // 夹在两次调用之间
        expect(idxRebuilt).toBeGreaterThan(idxRun)    // 重建后落到 assistant 行之后 → 前缀分叉
    })
})
