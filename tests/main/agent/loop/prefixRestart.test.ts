/**
 * LLM 请求前缀稳定性 · 组 A：端到端前缀一致性（P0-1 / P1-12）
 *
 * 契约（brief 已确证，本文件不做根因调研）：
 *   缓存命中的前提是「请求前缀字节稳定」——同会话每轮新增内容只能 append 到 prompt 尾部。
 *   请求体在 anthropicAdapter.ts:53-84 组装为 {system, tools, messages}：
 *   system 断点 = system[0] 的 cache_control（:69-71），tools 末块 cache_control（:682-694）。
 *
 * 现有测试只**分段**验证各 pre-step 的幂等（languageGuard.integration / catalog.integration /
 * envPublish / injectedAppend.prefix / setup.cacheSignature 等），没有一条把五段注入
 * （CT / catalog / system-env / memory / language-guard）合并后的**整条前缀**做端到端比对。
 * 本文件补这个缺口。
 *
 * 端到端口径：请求快照不是手写公式，而是**真实 AnthropicAdapter.chat()** 组装出的
 * requestParams（注入假 client 捕获 this.client.messages.stream 入参），
 * 即 system 数组 / tools 数组 / apiMessages 三者的真实字节。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 本文件同时暴露了一个既有缺陷（未修，禁止在本任务内改 src/**）：
 *   `src/main/agent/utils/userContentBuilder.ts:146-155` 的 metadata 白名单
 *   （convertUserHistoryMessage）收拢了 catalog* / languageGuard* 字段，**漏了
 *   `envDigest`（system-env）与 `memoryDigest`（memory）**。
 *   buildMessagesFromRows 把 metadata 展开到消息顶层、`msg.metadata` 因此为 undefined，
 *   于是白名单是唯一保真通道 —— 漏收拢 ⇒ 重启/恢复后 restoreEnvState /
 *   restoreMemoryState 读不到 digest ⇒ 每轮重复注入环境快照与记忆消息 ⇒ 重建请求
 *   序列 ≠ 内存态序列（尾部多出 2 条），prompt 持续膨胀、前缀分叉。
 *   本文件以「剔除已知缺口后逐字节相等」的绿用例 + 一条 it.fails 的缺口护栏固化该行为。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ 隔离：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 独立临时目录（绝不触碰真实
 *   ~/.hclaw/data/hclaw.db）；DB 走 Node 内置 node:sqlite（better-sqlite3 在 vitest 解析不到）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {randomUUID} from 'crypto'
import {mkdirSync, writeFileSync} from 'fs'
import {join} from 'path'

vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-prefix-restart-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('../../../../src/main/hclawPaths', async () => await import('../../../../src/main/config'))

import {getHclawDir} from '../../../../src/main/config'
import {getDatabase, closeDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'
import type {Message, SystemSettings} from '../../../../src/shared/types'
import {
    SOURCE_KIND_CATALOG,
    SOURCE_KIND_COMMAND_TASK,
    SOURCE_KIND_SYSTEM_ENV,
    SOURCE_KIND_LANGUAGE_GUARD,
} from '../../../../src/shared/types/message'
import {MEMORY_SOURCE_KIND} from '../../../../src/shared/types/memory'
import {skillRegistry} from '../../../../src/main/agent/skills/registry'
import type {SkillDefinition} from '../../../../src/main/agent/skills/types'
import {
    runCatalogPreStep, restoreCatalogState, type CatalogState,
} from '../../../../src/main/agent/loop/catalogPublish'
import {runEnvPreStep, restoreEnvState, type EnvState} from '../../../../src/main/agent/loop/envPublish'
import {runMemoryPreStep, restoreMemoryState, type MemoryState} from '../../../../src/main/agent/loop/memoryPublish'
import {
    runLanguageGuardPreStep, restoreLanguageGuardState, isLanguageGuardIteration, type LanguageGuardState,
} from '../../../../src/main/agent/loop/languageGuardPublish'
import {shouldInjectCommandTaskCt} from '../../../../src/main/agent/loop/agentDefinitionCt'
import {buildCommandTaskContent, convertUserHistoryMessage} from '../../../../src/main/agent/utils/userContentBuilder'
import {convertAssistantHistoryMessage} from '../../../../src/main/agent/ipc/historyConverter'
import {createLoopState, addMessage, type LoopState} from '../../../../src/main/agent/state'
import type {ChatMessage} from '../../../../src/main/agent/state'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import {AnthropicAdapter} from '../../../../src/main/agent/model/anthropicAdapter'
import {buildSystemPrompt} from '../../../../src/main/agent/systemPrompt'
import {filterTools} from '../../../../src/main/agent/loop/setup'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

// ─── 固定量 ────────────────────────────────────────────────
const CONV_ID = 'conv-prefix-restart'
const WORKDIR = '/tmp/prefix-restart-ws'
const MODEL = 'claude-sonnet-4-20250514'
const CT_TEMPLATE = '# 测试技能指导\n\n步骤 1：读取文件。\n步骤 2：汇报结论。'
const SETTINGS = {
    language: {nativeLocale: 'zh-CN', strategy: 'first-and-drift', correctionLimit: 3},
} as SystemSettings

/** 历史缺口涉及的段（曾因重建白名单漏收拢 digest 而重复注入）；修复后 dropReInjected 对其为 no-op */
const DEFECT_KINDS = [SOURCE_KIND_SYSTEM_ENV, MEMORY_SOURCE_KIND]

function makeSkill(id: string): SkillDefinition {
    return {
        id, name: id, description: `desc-${id}`, whenToUse: `trigger-${id}`,
        enabled: true, content: 'body',
    } as SkillDefinition
}

const TOOL_POOL: ToolDefinitionForLLM[] = ['file_read', 'file_write', 'bash', 'glob', 'grep'].map(name => ({
    name,
    description: `tool ${name}`,
    inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']},
}))

// ─── 请求快照：走真实 adapter 组装路径 ──────────────────────
interface RequestSnapshot {
    /** JSON.stringify(system 参数) —— 含 system[0].cache_control 断点 */
    system: string
    /** JSON.stringify(tools 参数) —— 含末块 cache_control */
    tools: string
    /** JSON.stringify(apiMessages) —— 含全部注入消息 */
    messages: string
}

/**
 * 通过真实 AnthropicAdapter.chat() 组装请求体并捕获 requestParams。
 * 每次调用新建 adapter 实例（convertCache 从 null 起 → 全量 convertMessages，
 * 与「进程重启后第一次请求」同构）。
 */
async function captureRequest(
    systemPrompt: string,
    tools: ToolDefinitionForLLM[],
    messages: ReadonlyArray<ChatMessage>,
): Promise<RequestSnapshot> {
    const captured: Array<Record<string, unknown>> = []
    const fakeClient = {
        baseURL: '',
        messages: {
            stream: (params: Record<string, unknown>) => {
                captured.push(params)
                return {
                    abort() { /* no-op */ },
                    // eslint-disable-next-line require-yield
                    async *[Symbol.asyncIterator]() { /* 无流事件：仅关心请求体 */ },
                }
            },
        },
    }
    const adapter = new AnthropicAdapter(
        {model: MODEL, features: {systemContentBlocks: true}} as never,
        fakeClient as never,
    )
    for await (const _chunk of adapter.chat({
        messages: [...messages], systemPrompt, tools, maxTokens: 8192,
    } as never)) { void _chunk }

    expect(captured).toHaveLength(1)
    const req = captured[0]
    return {
        system: JSON.stringify(req.system ?? null),
        tools: JSON.stringify(req.tools ?? null),
        messages: JSON.stringify(req.messages ?? null),
    }
}

// ─── 消息序列工具 ──────────────────────────────────────────
/**
 * 消息序列形态（role + content）：重建出来的 assistant 消息不带 id
 * （historyConverter 输出形态），而 id 不进 API 请求字节 —— 顺序与正文才是前缀判据。
 */
const shape = (messages: ReadonlyArray<ChatMessage>): string[] =>
    messages.map(m => `${m.role}|${String(m.content)}`)

const kindOf = (m: ChatMessage): string | undefined =>
    (m.metadata as Record<string, unknown> | undefined)?.sourceKind as string | undefined

/** 各注入段出现次数表 */
function kindCounts(messages: ReadonlyArray<ChatMessage>): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const m of messages) {
        const k = kindOf(m)
        if (k) counts[k] = (counts[k] ?? 0) + 1
    }
    return counts
}

/**
 * 剔除「已知缺口导致的重复注入」：同一 sourceKind 段的第二次及以后出现。
 * 生产修复（envDigest / memoryDigest 进重建白名单）后本函数对被测序列为 no-op，
 * 断言随之等价于「完整序列逐字节相等」。
 */
function dropReInjected(messages: ReadonlyArray<ChatMessage>): ChatMessage[] {
    const seen = new Set<string>()
    const out: ChatMessage[] = []
    for (const m of messages) {
        const k = kindOf(m)
        if (k && DEFECT_KINDS.includes(k)) {
            if (seen.has(k)) continue
            seen.add(k)
        }
        out.push(m)
    }
    return out
}

// ─── 会话装配 harness ──────────────────────────────────────
interface InjectionStates {
    catalog: CatalogState
    env: EnvState
    memory: MemoryState
    languageGuard: LanguageGuardState
}

/** 与生产同源的初值（restore* 从空消息流还原 = 全新会话） */
function emptyInjectionStates(): InjectionStates {
    return {
        catalog: restoreCatalogState([]),
        env: restoreEnvState([]),
        memory: restoreMemoryState([]),
        languageGuard: restoreLanguageGuardState([]),
    }
}

/** 从消息流还原四段状态（重启用） */
function restoreAll(messages: ReadonlyArray<ChatMessage>): InjectionStates {
    return {
        catalog: restoreCatalogState(messages),
        env: restoreEnvState(messages),
        memory: restoreMemoryState(messages),
        languageGuard: restoreLanguageGuardState(messages),
    }
}

/** 五段中除 CT 外的四段 pre-step，严格按 controller 的调用顺序与参数 */
function runPreSteps(
    state: LoopState,
    inj: InjectionStates,
    repo: SqliteConversationRepository | null,
    turnCount = 1,
): LoopState {
    const sid = repo ? CONV_ID : undefined
    let cur = state
    {
        const r = runCatalogPreStep(cur, inj.catalog, repo, sid, false, true)
        cur = r.state
        inj.catalog = r.catalogState
    }
    {
        const r = runEnvPreStep(cur, inj.env, repo, sid)
        cur = r.state
        inj.env = r.envState
    }
    {
        const r = runMemoryPreStep(cur, inj.memory, repo, sid, {
            hclawDir: getHclawDir(), workspacePath: WORKDIR, memoryEnabled: true,
        })
        cur = r.state
        inj.memory = r.memoryState
    }
    if (isLanguageGuardIteration(turnCount)) {
        const r = runLanguageGuardPreStep(cur, inj.languageGuard, repo, sid, SETTINGS)
        cur = r.state
        inj.languageGuard = r.languageGuardState
    }
    return cur
}

/** controller.ts:408-433 同款 CT 注入（含幂等守卫 + 落库） */
function injectCt(state: LoopState, repo: SqliteConversationRepository | null, template: string): LoopState {
    const ct: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: buildCommandTaskContent(template),
        metadata: {sourceKind: SOURCE_KIND_COMMAND_TASK},
    }
    if (!shouldInjectCommandTaskCt(state.messages, ct.content)) return state
    if (repo) repo.writeMessagesDelta(CONV_ID, {...ct, timestamp: Date.now()} as unknown as Message)
    return addMessage(state, ct)
}

/** startAgentCore.ts:201-220 同款历史重建（user 走转换函数，assistant 走 historyConverter） */
async function rebuildFromDb(repo: SqliteConversationRepository): Promise<ChatMessage[]> {
    const rows = repo.readMessages(CONV_ID) as Array<Message & Record<string, unknown>>
    const rebuilt: ChatMessage[] = []
    for (const row of rows) {
        if (row.role === 'user') {
            rebuilt.push(...await convertUserHistoryMessage(
                row as unknown as Parameters<typeof convertUserHistoryMessage>[0]) as unknown as ChatMessage[])
        } else if (row.role === 'assistant') {
            rebuilt.push(...convertAssistantHistoryMessage(row) as unknown as ChatMessage[])
        }
    }
    return rebuilt
}

/** user 行落库（user 正文落 metadata.content，metadata 展开到顶层） */
function writeUserRow(
    repo: SqliteConversationRepository, id: string, content: string, timestamp: number,
): void {
    repo.writeMessagesDelta(CONV_ID, {id, role: 'user', content, timestamp} as unknown as Message)
}

/** assistant 行落库：一次用户发言 = 一条 assistant 行，行内多轮用 turnIndex 区分 */
function writeAssistantRow(
    repo: SqliteConversationRepository,
    id: string,
    blocks: Array<{id: string; type: 'text' | 'think'; text: string; turnIndex: number}>,
    timestamp: number,
): void {
    repo.writeMessagesDelta(CONV_ID, {
        id,
        role: 'assistant',
        content: '',
        timestamp,
        endedAt: timestamp + 10,
        contentBlocks: blocks.map(b => (b.type === 'text'
            ? {id: b.id, type: 'text' as const, text: b.text, turnIndex: b.turnIndex}
            : {id: b.id, type: 'think' as const, thinkBlock: {content: b.text, timestamp}, turnIndex: b.turnIndex})),
    } as unknown as Message)
}

/** 内存态 assistant 消息（loop 内「一次 LLM 调用 = 一条 assistant」形态） */
function assistantMsg(id: string, text: string): ChatMessage {
    return {id, role: 'assistant', content: text} as ChatMessage
}

/** 生产同款 system / tools 构建（重启前后参数完全相同 → 两段应逐字节相等） */
async function buildBase(): Promise<{toolDefs: ToolDefinitionForLLM[]; systemPrompt: string}> {
    const toolDefs = await filterTools(undefined, 'General', MODEL, undefined, TOOL_POOL)
    const systemPrompt = await buildSystemPrompt({
        workingDir: WORKDIR, tools: toolDefs, permissionMode: 'default', agentType: 'General',
    })
    return {toolDefs, systemPrompt}
}

// ─── DB harness ───────────────────────────────────────────
let repo: SqliteConversationRepository

function seedSchema(): void {
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
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-22T10:00:00'))

    seedSchema()
    repo = new SqliteConversationRepository()
    repo.create(CONV_ID, {
        id: CONV_ID, title: 't', workspacePath: WORKDIR,
        createdAt: 1, updatedAt: 1, preview: '', status: 'active',
    })

    skillRegistry.clear()
    skillRegistry.register(makeSkill('skill-prefix'))

    // 记忆文件（runMemoryPreStep → loadMemory 读 hclawDir/mem/ref/_user/preferences.md）
    const memDir = join(getHclawDir(), 'mem', 'ref', '_user')
    mkdirSync(memDir, {recursive: true})
    writeFileSync(join(memDir, 'preferences.md'), '# 用户偏好\n\n- 结论先行\n', 'utf8')
})

afterEach(() => {
    skillRegistry.clear()
    vi.useRealTimers()
    closeDatabase()
})

// ─────────────────────────────────────────────────────────
// P0-1 冷启动端到端前缀一致
// ─────────────────────────────────────────────────────────
describe('P0-1 冷启动：内存态请求序列 ≡ 重启后按 DB 重建的请求序列（system + tools + messages）', () => {
    /** 一段含五段注入的会话（run1 注入四段 pre-step + lg seed；run2 注入 CT） */
    async function buildColdStartSession(): Promise<{
        memoryMessages: ChatMessage[]
        memoryApiMessages: ChatMessage[]
        snapshotMemory: RequestSnapshot
        toolDefs: ToolDefinitionForLLM[]
        systemPrompt: string
        rowsBefore: number
    }> {
        const t0 = Date.now()
        vi.setSystemTime(t0)
        writeUserRow(repo, 'u1', '你好，请帮我看看这个模块', t0)

        const inj = emptyInjectionStates()
        let state = createLoopState([
            {id: 'u1', role: 'user', content: '你好，请帮我看看这个模块'} as ChatMessage,
        ])
        state = runPreSteps(state, inj, repo, 1)      // catalog / system-env / memory / language-guard seed

        vi.setSystemTime(t0 + 1000)
        const A1_TEXT = '好的，我先读一下这个模块的入口文件，再给出结论。'
        writeAssistantRow(repo, 'a1', [{id: 'a1-t0', type: 'text', text: A1_TEXT, turnIndex: 0}], Date.now())
        state = addMessage(state, assistantMsg('a1', A1_TEXT))

        vi.setSystemTime(t0 + 2000)
        writeUserRow(repo, 'u2', '继续', Date.now())
        state = addMessage(state, {id: 'u2', role: 'user', content: '继续'} as ChatMessage)

        vi.setSystemTime(t0 + 3000)
        state = injectCt(state, repo, CT_TEMPLATE)

        const memoryMessages = [...state.messages]
        // 内存态首枪请求（同一 PreprocessCache 实例内 process）
        const memoryApiMessages = new PreprocessCache().process(memoryMessages)
        const {toolDefs, systemPrompt} = await buildBase()
        const snapshotMemory = await captureRequest(systemPrompt, toolDefs, memoryApiMessages)

        return {
            memoryMessages, memoryApiMessages, snapshotMemory, toolDefs, systemPrompt,
            rowsBefore: repo.readMessages(CONV_ID).length,
        }
    }

    it('五段注入合并态：重建序列零改写、注入位置不变；剔除已知缺口（env/memory digest 未入白名单）后请求逐字节相等', async () => {
        const s = await buildColdStartSession()

        // 内存态：五段各恰一条，顺序 = u1 → catalog → env → memory → lg → a1 → u2 → CT
        expect(kindCounts(s.memoryMessages)).toEqual({
            [SOURCE_KIND_CATALOG]: 1,
            [SOURCE_KIND_SYSTEM_ENV]: 1,
            [MEMORY_SOURCE_KIND]: 1,
            [SOURCE_KIND_LANGUAGE_GUARD]: 1,
            [SOURCE_KIND_COMMAND_TASK]: 1,
        })
        expect(s.memoryMessages.map(kindOf)).toEqual([
            undefined, SOURCE_KIND_CATALOG, SOURCE_KIND_SYSTEM_ENV, MEMORY_SOURCE_KIND,
            SOURCE_KIND_LANGUAGE_GUARD, undefined, undefined, SOURCE_KIND_COMMAND_TASK,
        ])

        // ── 模拟重启：丢弃全部进程内状态，仅余 DB ──
        const rebuilt = await rebuildFromDb(repo)
        // 位置与正文不变（id 不进请求字节，故比 (role, content) 形态）
        expect(shape(rebuilt)).toEqual(shape(s.memoryMessages))

        // 重建后 controller 仍走同一套注入点：CT 幂等守卫 + digest 门控
        const rinj = restoreAll(rebuilt)
        let rstate = createLoopState(rebuilt)
        rstate = injectCt(rstate, repo, CT_TEMPLATE)
        rstate = runPreSteps(rstate, rinj, repo, 1)

        // 门控完全恢复后零重复注入（曾因 envDigest/memoryDigest 未进重建白名单而各多 1 条）
        const memCounts = kindCounts(s.memoryMessages)
        const reCounts = kindCounts(rstate.messages)
        const extras = Object.entries(reCounts)
            .flatMap(([k, n]) => Array.from({length: Math.max(0, n - (memCounts[k] ?? 0))}, () => k))
        expect(extras).toEqual([])
        // 五段全部零注入零落库（CT / catalog / lg / env / memory）
        expect(repo.readMessages(CONV_ID).length).toBe(s.rowsBefore)

        // ── 端到端比对（剔除已知缺口的重复段后）──
        const restartCache = new PreprocessCache()
        const {toolDefs, systemPrompt} = await buildBase()
        const snapshotRestart = await captureRequest(
            systemPrompt, toolDefs, restartCache.process(dropReInjected(rstate.messages)))

        expect(snapshotRestart.system).toBe(s.snapshotMemory.system)
        expect(snapshotRestart.tools).toBe(s.snapshotMemory.tools)
        expect(snapshotRestart.messages).toBe(s.snapshotMemory.messages)

        // 更强形式：剔除缺口后与内存态请求序列同形（role + content 逐条相等）
        const dropped = restartCache.process(dropReInjected(rstate.messages))
        expect(shape(dropped)).toEqual(shape(s.memoryApiMessages))
    })

    // ★ 回归护栏：曾在 userContentBuilder.ts 的重建白名单漏收拢 `envDigest` / `memoryDigest`，
    //   导致恢复后 env / memory 门控失效、两段重复注入（已修复）。本用例为最强形式：
    //   不做任何剔除，重建请求与内存态请求逐字节相等。
    it('不剔除任何缺口时，五段合并态重建请求与内存态请求逐字节相等', async () => {
        const s = await buildColdStartSession()

        const rebuilt = await rebuildFromDb(repo)
        let rstate = createLoopState(rebuilt)
        const rinj = restoreAll(rebuilt)
        rstate = injectCt(rstate, repo, CT_TEMPLATE)
        rstate = runPreSteps(rstate, rinj, repo, 1)

        const {toolDefs, systemPrompt} = await buildBase()
        const snapshotRestart = await captureRequest(
            systemPrompt, toolDefs, new PreprocessCache().process([...rstate.messages]))

        expect(snapshotRestart.messages).toBe(s.snapshotMemory.messages)
        expect(snapshotRestart.system).toBe(s.snapshotMemory.system)
        expect(snapshotRestart.tools).toBe(s.snapshotMemory.tools)
    })

    it('反例（判别力）：挪动注入位置 / 改写旧消息会变红；sourceKind 只做门控、不进请求字节', async () => {
        const s = await buildColdStartSession()
        const baseline = s.snapshotMemory

        const rebuilt = await rebuildFromDb(repo)
        expect(shape(rebuilt)).toEqual(shape(s.memoryMessages))

        // 反例 1：注入位置变化（catalog 消息从 a1 之前挪到 a1 之后 → 前缀分叉）
        const moved = [...rebuilt]
        const catIdx = moved.findIndex(m => kindOf(m) === SOURCE_KIND_CATALOG)
        expect(catIdx).toBe(1)
        const [catalog] = moved.splice(catIdx, 1)
        moved.splice(5, 0, catalog)
        const bad1 = await captureRequest(s.systemPrompt, s.toolDefs, new PreprocessCache().process(moved))
        expect(bad1.messages).not.toBe(baseline.messages)

        // 反例 2：重建路径改写了旧消息字节（a1 正文多一个空格）
        const rewritten = rebuilt.map(m => (m.id === undefined && m.role === 'assistant'
            ? {...m, content: `${String(m.content)} `} : m))
        const bad2 = await captureRequest(s.systemPrompt, s.toolDefs, new PreprocessCache().process(rewritten))
        expect(bad2.messages).not.toBe(baseline.messages)

        // 反例 3：注入消息丢失 sourceKind → 请求字节不变（固化「sourceKind 只做门控」的边界）
        const stripped = rebuilt.map(m => (m.id === catalog.id ? {...m, metadata: undefined} : m))
        const bad3 = await captureRequest(s.systemPrompt, s.toolDefs, new PreprocessCache().process(stripped))
        expect(bad3.messages).toBe(baseline.messages)
        expect(bad3).toEqual(baseline)
    })
})

// ─────────────────────────────────────────────────────────
// P1-12 历史恢复（continue / resume）整体前缀一致
// ─────────────────────────────────────────────────────────
describe('P1-12 历史恢复（continue/resume）：恢复路径产出的请求前缀与恢复前的尾状态逐字节一致', () => {
    /** 多轮历史：u1 → a1(行内两轮) → u2 → a2 → u3 → CT，全部落库 */
    async function buildHistory(): Promise<{
        tail: ChatMessage[]
        tailApi: ChatMessage[]
        snapshotTail: RequestSnapshot
        toolDefs: ToolDefinitionForLLM[]
        systemPrompt: string
    }> {
        const t0 = Date.now()
        vi.setSystemTime(t0)
        writeUserRow(repo, 'u1', '第一条需求', t0)
        const inj = emptyInjectionStates()
        let state = createLoopState([{id: 'u1', role: 'user', content: '第一条需求'} as ChatMessage])
        state = runPreSteps(state, inj, repo, 1)

        vi.setSystemTime(t0 + 1000)
        // 一次用户发言 = 一条 assistant 行；行内两次 LLM 调用（turnIndex 0/1）
        writeAssistantRow(repo, 'a1', [
            {id: 'a1-t0', type: 'text', text: '第一轮回复', turnIndex: 0},
            {id: 'a1-t1', type: 'text', text: '第二轮回复', turnIndex: 1},
        ], Date.now())
        state = addMessage(state, assistantMsg('a1-t0', '第一轮回复'))
        state = addMessage(state, assistantMsg('a1-t1', '第二轮回复'))

        vi.setSystemTime(t0 + 2000)
        writeUserRow(repo, 'u2', '第二条需求', Date.now())
        state = addMessage(state, {id: 'u2', role: 'user', content: '第二条需求'} as ChatMessage)

        vi.setSystemTime(t0 + 3000)
        writeAssistantRow(repo, 'a2', [{id: 'a2-t0', type: 'text', text: '第二条回复', turnIndex: 0}], Date.now())
        state = addMessage(state, assistantMsg('a2-t0', '第二条回复'))

        vi.setSystemTime(t0 + 4000)
        writeUserRow(repo, 'u3', '继续', Date.now())
        state = addMessage(state, {id: 'u3', role: 'user', content: '继续'} as ChatMessage)

        vi.setSystemTime(t0 + 5000)
        state = injectCt(state, repo, CT_TEMPLATE)

        const tail = [...state.messages]
        const tailApi = new PreprocessCache().process(tail)
        const {toolDefs, systemPrompt} = await buildBase()
        const snapshotTail = await captureRequest(systemPrompt, toolDefs, tailApi)
        return {tail, tailApi, snapshotTail, toolDefs, systemPrompt}
    }

    /** resume：按 DB 重建 + 恢复四段状态 + CT 守卫 */
    async function resume(toolDefs: ToolDefinitionForLLM[], systemPrompt: string): Promise<{
        state: LoopState
        api: ChatMessage[]
        snapshot: RequestSnapshot
        rowsBefore: number
    }> {
        const rebuilt = await rebuildFromDb(repo)
        let rstate = createLoopState(rebuilt)
        const rinj = restoreAll(rebuilt)
        const rowsBefore = repo.readMessages(CONV_ID).length
        rstate = injectCt(rstate, repo, CT_TEMPLATE)
        rstate = runPreSteps(rstate, rinj, repo, 1)
        const cache = new PreprocessCache()
        const api = cache.process(dropReInjected([...rstate.messages]))
        const snapshot = await captureRequest(systemPrompt, toolDefs, api)
        return {state: rstate, api, snapshot, rowsBefore}
    }

    it('恢复后直接请求：尾状态请求的三段（system/tools/messages）逐字节保持，assistant 行内 turnIndex 分组无损', async () => {
        const h = await buildHistory()
        const rebuilt = await rebuildFromDb(repo)
        expect(shape(rebuilt)).toEqual(shape(h.tail))
        // 行内两轮重建为两条 assistant（turnIndex 分组）——顺序与正文无损
        expect(rebuilt.filter(m => m.role === 'assistant').map(m => m.content))
            .toEqual(['第一轮回复', '第二轮回复', '第二条回复'])

        const r = await resume(h.toolDefs, h.systemPrompt)
        expect(r.snapshot.system).toBe(h.snapshotTail.system)
        expect(r.snapshot.tools).toBe(h.snapshotTail.tools)
        expect(r.snapshot.messages).toBe(h.snapshotTail.messages)
        expect(shape(r.api)).toEqual(shape(h.tailApi))
        // 零写入：CT 幂等守卫 + 四段 digest 门控全部生效（含 env / memory）
        expect(repo.readMessages(CONV_ID).length).toBe(r.rowsBefore)
    })

    it('resume 后继续追加新输入：新请求以「恢复请求」为前缀（只在尾部 append）', async () => {
        const h = await buildHistory()
        const r = await resume(h.toolDefs, h.systemPrompt)

        vi.setSystemTime(Date.now() + 1000)
        writeUserRow(repo, 'u4', '再补一句', Date.now())
        const continued = addMessage(r.state, {id: 'u4', role: 'user', content: '再补一句'} as ChatMessage)
        const snapshotContinued = await captureRequest(
            h.systemPrompt, h.toolDefs, new PreprocessCache().process(dropReInjected([...continued.messages])))

        // system / tools 两段完全不变
        expect(snapshotContinued.system).toBe(h.snapshotTail.system)
        expect(snapshotContinued.tools).toBe(h.snapshotTail.tools)

        // apiMessages：前一段逐字节不变，尾部恰多 1 条（新用户输入）
        const resumeApi = JSON.parse(r.snapshot.messages) as unknown[]
        const contApi = JSON.parse(snapshotContinued.messages) as unknown[]
        expect(contApi.length).toBe(resumeApi.length + 1)
        expect(JSON.stringify(contApi.slice(0, resumeApi.length))).toBe(r.snapshot.messages)
    })
})
