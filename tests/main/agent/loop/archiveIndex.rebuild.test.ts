/**
 * 归档卷索引注入 · 跨 run 重建序列一致性（集成，spec §9-T7）
 *
 * 为什么必须走真实链路：T7 的对象是「首轮注入的索引消息，在崩溃/重启后按 DB 重建时
 * 是否仍落在同一位置」。DB 层「一次用户发言 = 一条 assistant 行」与内存态「一次 LLM
 * 调用 = 一条 assistant 消息」的粒度差，只有在真实落库 + 真实重建路径上才可见。
 *
 * 口径与 tests/main/agent/loop/languageGuard.integration.test.ts 的跨 run 前缀用例
 * 保持一致：
 * - 正例：注入发生在 run 首轮 ⇒ 重建序列里注入点位置一致、前缀逐字节相等；
 * - 反例（判别力护栏）：若注入发生在 iteration ≥2（即 controller 侧 `turnCount === 1`
 *   门禁失守）⇒ 重建把注入排到 assistant 行之后、前缀分叉。反例是行为级断言（比对
 *   重建序列与运行态的索引位置），不是源码字符串断言。
 *
 * ⚠️ 字节口径（spec §4.5 / 裁决 R20）：断言只针对索引**正文 body ≤ maxBytes**，
 * `<system-reminder>` 包裹开销（标题行 + 指引行）不计入。
 *
 * ⚠️ 隔离：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 独立临时目录。
 */
import {describe, it, expect, vi, beforeEach, afterEach, afterAll} from 'vitest'
import {mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'

vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-archive-idx-rebuild-' + Date.now())
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
import type {Message} from '../../../../src/shared/types'
import {MEMORY_SOURCE_KIND, ARCHIVE_INDEX_DIGEST_KEY} from '../../../../src/shared/types/memory'
import type {MemoryState} from '../../../../src/shared/types/memory'
import {runArchiveIndexPreStep} from '../../../../src/main/agent/loop/archiveIndexPublish'
import {ARCHIVE_INDEX_DEFAULTS, clearArchiveIndexCache, buildArchiveIndex} from '../../../../src/main/agent/memory/archiveIndex'
import {createLoopState, type ChatMessage} from '../../../../src/main/agent/state'
import {convertUserHistoryMessage} from '../../../../src/main/agent/utils/userContentBuilder'
import {convertAssistantHistoryMessage} from '../../../../src/main/agent/ipc/historyConverter'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'

const CONV_ID = 'conv-idx-rebuild'
/** 一天的毫秒数 */
const DAY = 86_400_000
/** mtime 基准（固定值，避免依赖真实时间） */
const BASE_MTIME = Date.UTC(2026, 7, 1)
const EMPTY_IDX: MemoryState = {lastMemoryDigest: null, lastArchiveIndexDigest: null}
/** 指引行（第④段），用于从注入 content 中反解 body 边界 */
const GUIDE_LINE =
    '任务涉及上述主题时，用 file_read 读取对应卷全文后再动手；清单只是地图，不要凭卷名臆断内容。'

let hclawDir = ''
let repo: SqliteConversationRepository

/** 跨项目归档目录 mem/ref/_user/archive */
function crossArchiveDir(dir: string): string {
    return join(dir, 'mem', 'ref', '_user', 'archive')
}

/** 写一个归档卷并固定 mtime */
function writeVolume(dir: string, fileName: string, summary: string, mtimeMs: number): void {
    mkdirSync(dir, {recursive: true})
    const filePath = join(dir, fileName)
    writeFileSync(filePath, `# 归档卷：${fileName}\n\n> 摘要：${summary}\n\n正文\n`, 'utf8')
    utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
}

/** pre-step options（memoryEnabled 开启、无 workspace） */
function opts(overrides: Record<string, unknown> = {}) {
    return {
        hclawDir,
        workspacePath: null as string | null,
        memoryEnabled: true,
        ...overrides,
    }
}

/** 索引注入消息（sourceKind=memory 且带 archiveIndexDigest 的才是索引消息） */
function indexMessages(state: {messages: ReadonlyArray<ChatMessage>}): ChatMessage[] {
    return state.messages.filter(m => {
        const meta = m.metadata as Record<string, unknown> | undefined
        return meta?.sourceKind === MEMORY_SOURCE_KIND
            && typeof meta[ARCHIVE_INDEX_DIGEST_KEY] === 'string'
    })
}

/**
 * 从注入 content 反解索引正文 body（第②段内容）：
 * 固定五段 = ① 标签行 ② 标题行 + 空行 + body ③ 空行 ④ 指引行 ⑤ 结束标签行。
 * body = lines[3 .. guideIdx-2]（guideIdx-1 为空行）。
 */
function indexBody(content: string): string {
    const lines = content.split('\n')
    const guideIdx = lines.indexOf(GUIDE_LINE)
    expect(guideIdx).toBeGreaterThan(3)
    return lines.slice(3, guideIdx - 1).join('\n')
}

/** 规范化序列化（key 排序），仅用于前缀比对 —— 理由同 languageGuard.integration.test.ts 文件头 */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        return Object.fromEntries(Object.keys(obj).sort().map(k => [k, canonical(obj[k])]))
    }
    return value
}
const seq = (messages: ReadonlyArray<ChatMessage>) => JSON.stringify(messages.map(canonical))

/** user 消息行落库（真实写入路径；user 正文落 metadata.content） */
function writeUserRow(repoRef: SqliteConversationRepository, id: string, content: string, timestamp: number): void {
    repoRef.writeMessagesDelta(CONV_ID, {id, role: 'user', content, timestamp} as unknown as Message)
}

/**
 * assistant 行落库：一次用户发言 = 一条 assistant 行，行内多轮 LLM 调用用 turnIndex 区分
 * （§3.2 的粒度事实 —— 反例用例的关键构造）
 */
function writeAssistantRow(
    repoRef: SqliteConversationRepository,
    id: string,
    blocks: Array<{id: string; text: string; turnIndex: number}>,
    timestamp: number,
): void {
    repoRef.writeMessagesDelta(CONV_ID, {
        id,
        role: 'assistant',
        content: '',
        timestamp,
        contentBlocks: blocks.map(b => ({id: b.id, type: 'text' as const, text: b.text, turnIndex: b.turnIndex})),
    } as unknown as Message)
}

/** 与 execution.ts / startAgentCore 同款重建：user 走转换函数，assistant 走 historyConverter */
async function rebuildFromDb(repoRef: SqliteConversationRepository): Promise<ChatMessage[]> {
    const rows = repoRef.readMessages(CONV_ID) as Array<Message & Record<string, unknown>>
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

beforeEach(() => {
    hclawDir = mkdtempSync(join(tmpdir(), 'hclaw-idx-rebuild-'))
    clearArchiveIndexCache()
    repo = new SqliteConversationRepository()
    const db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS llm_usage')
    db.exec('DROP TABLE IF EXISTS conversations')
    // 最小 schema（与迁移 001 + 006 对齐，参照 languageGuard.integration.test.ts harness）
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
    clearArchiveIndexCache()
    closeDatabase()
    rmSync(hclawDir, {recursive: true, force: true})
})

afterAll(async () => {
    // 清理 vi.mock 重定向出的独立临时目录（数据库 hclaw.db 落在其 data/ 下）。
    // Windows 上 sqlite 句柄释放滞后于 closeDatabase()（实测数百 ms 后目录才可删）：
    // 重试上限 ~3s；极端情况下仍失败则留给系统临时目录回收，不让套件因此失败。
    const {getHclawDir} = await import('../../../../src/main/config')
    const dir = getHclawDir()
    for (let attempt = 0; attempt < 15; attempt++) {
        try {
            rmSync(dir, {recursive: true, force: true})
            return
        } catch {
            await new Promise(resolve => setTimeout(resolve, 200))
        }
    }
})

describe('§9-T7 归档卷索引注入位置在跨 run 重建后保持一致', () => {
    it('正例：首轮注入 → 重建序列中索引位置与运行态一致，注入点前缀逐字节相等', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T10:00:00'))
        const cacheRun = new PreprocessCache()
        const cacheRebuilt = new PreprocessCache()

        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        writeUserRow(repo, 'u1', '继续', Date.now())

        const r1 = runArchiveIndexPreStep(
            createLoopState([{id: 'u1', role: 'user', content: '继续'} as ChatMessage]),
            EMPTY_IDX, repo, CONV_ID, opts())
        const injected = indexMessages(r1.state)[0]
        expect(injected).toBeDefined()
        const runMsgs = cacheRun.process([...r1.state.messages])   // 本 turn 首次 LLM 调用请求序列

        // 本轮结束：assistant 行落库（timestamp 晚于注入消息 —— §3.2 成立的原因）
        vi.setSystemTime(new Date('2026-09-21T10:00:30'))
        writeAssistantRow(repo, 'a-turn', [{id: 'cb1', text: '好的，我接着处理。', turnIndex: 0}], Date.now())

        // 跨 run 重建（崩溃重启同路径）
        const revived = createLoopState(await rebuildFromDb(repo))
        const revivedMsgs = cacheRebuilt.process([...revived.messages])

        const injContent = String(injected.content)
        const idxRun = runMsgs.findIndex(m => String(m.content) === injContent)
        const idxRebuilt = revivedMsgs.findIndex(m => String(m.content) === injContent)
        expect(idxRun).toBe(1)                        // 紧跟 u1（assistant 行尚未创建）
        expect(idxRebuilt).toBe(idxRun)               // 位置未被 assistant 行跨越
        expect(seq(revivedMsgs.slice(0, idxRebuilt + 1))).toBe(seq(runMsgs.slice(0, idxRun + 1)))

        // 判别力对照：若重建链路丢失注入消息 metadata（白名单漏收拢 archiveIndexDigest 的
        // 等价后果），上面这条前缀比对立刻分叉 —— 证明该断言不是恒真。
        const dropped = revivedMsgs.map(m =>
            String(m.content) === injContent ? {...m, metadata: undefined} : m)
        expect(seq(dropped.slice(0, idxRebuilt + 1))).not.toBe(seq(runMsgs.slice(0, idxRun + 1)))
    })

    it('★ 反例（行为级判别力）：注入晚于 assistant 行（iteration ≥2）→ 重建把索引排到 assistant 之后，前缀分叉', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T10:00:00'))
        const cacheRun = new PreprocessCache()
        const cacheRebuilt = new PreprocessCache()

        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        writeUserRow(repo, 'u1', '继续', Date.now())
        vi.setSystemTime(new Date('2026-09-21T10:00:30'))
        // 一次用户发言 = 一条 assistant 行，行内两个 turnIndex（= 两次 LLM 调用）
        writeAssistantRow(repo, 'a-turn', [
            {id: 'cb1', text: 'first call', turnIndex: 0},
            {id: 'cb2', text: 'second call', turnIndex: 1},
        ], Date.now())

        // 门禁失守的模拟：注入发生在 iteration ≥2（时间晚于 assistant 行）
        vi.setSystemTime(new Date('2026-09-21T10:01:00'))
        const u1 = {id: 'u1', role: 'user', content: '继续'} as ChatMessage
        const a1 = {id: 'a1', role: 'assistant', content: 'first call'} as ChatMessage
        const a2 = {id: 'a2', role: 'assistant', content: 'second call'} as ChatMessage
        const r = runArchiveIndexPreStep(
            createLoopState([u1, a1]), EMPTY_IDX, repo, CONV_ID, opts())
        const injected = indexMessages(r.state)[0]
        expect(injected).toBeDefined()
        const runMsgs = cacheRun.process([...r.state.messages, a2])

        const revived = createLoopState(await rebuildFromDb(repo))
        const revivedMsgs = cacheRebuilt.process([...revived.messages])

        const injContent = String(injected.content)
        const idxRun = runMsgs.findIndex(m => String(m.content) === injContent)
        const idxRebuilt = revivedMsgs.findIndex(m => String(m.content) === injContent)
        expect(idxRun).toBe(2)                        // 运行态：夹在两次 LLM 调用之间
        expect(idxRebuilt).toBeGreaterThan(idxRun)    // 重建后落到 assistant 行之后 → 前缀分叉（锁住「必须首轮」）
    })

    it('字节口径：正文自然长度超预算 → 必须截断，且 body ≤ maxBytes（<system-reminder> 包裹开销不计入）', () => {
        const limits = {maxBytes: 400, summaryMaxChars: 40, recentKeep: 15}
        const WS_PATH = '/tmp/test-ws'
        // 多卷 + 长摘要（超过 summaryMaxChars 即被截断，单行仍达百余字节）：
        // 自然长度远超预算，正文必须走截断路径 —— 避免「单卷自然长度远小于预算」的恒真形态
        const longSummary = '用于撑爆索引预算的归档卷摘要内容'.repeat(3)
        for (let i = 0; i < 10; i++) {
            writeVolume(crossArchiveDir(hclawDir), `2026-08-cross-${i}.md`, longSummary, BASE_MTIME + i)
        }
        // 项目级卷：需 index.json 登记当前 workspace（dir 决定 mem/ref/<dir>/archive 落点）
        const refDir = join(hclawDir, 'mem', 'ref')
        mkdirSync(refDir, {recursive: true})
        writeFileSync(join(refDir, 'index.json'),
            JSON.stringify({[WS_PATH]: {dir: 'proj-a', projectName: '测试项目'}}), 'utf8')
        for (let i = 0; i < 10; i++) {
            writeVolume(join(refDir, 'proj-a', 'archive'), `2026-08-proj-${i}.md`, longSummary, BASE_MTIME + i)
        }

        const r = runArchiveIndexPreStep(
            createLoopState([{id: 'u1', role: 'user', content: '继续'} as ChatMessage]),
            EMPTY_IDX, null, 'sess', opts({workspacePath: WS_PATH, limits}))
        const content = String(indexMessages(r.state)[0].content)
        const body = indexBody(content)

        // 口径①：注入消息里反解出的正文 ≤ maxBytes（标题行 / 空行 / 指引行等包裹开销不计入）
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(limits.maxBytes)
        // 口径②（判别力）：预算被有效使用 —— 截断只削掉一部分，而不是把正文压得远小于预算
        expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(limits.maxBytes * 0.5)
        // 口径③（判别力）：截断确实发生；实现若漏了截断路径，此断言与口径①同时红
        const built = buildArchiveIndex({hclawDir, workspacePath: WS_PATH, limits})
        expect(built?.truncated).toBe(true)
        // 两个口径同源：注入消息里的正文就是构建器产出的 body（装配时仅归一尾部换行）
        expect(body).toBe(String(built?.body).replace(/\n$/, ''))
        // 防恒真护栏：反解出的确实是含两级（跨项目 + 本项目）卷名的正文，不是空串或残片
        expect(body).toContain('cross-9')
        expect(body).toContain('proj-9')
        // 默认预算值仅作口径基线（默认值是否透传不影响本用例）
        expect(ARCHIVE_INDEX_DEFAULTS.maxBytes).toBe(3072)
    })
})
