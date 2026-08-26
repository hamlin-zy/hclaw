/**
 * Task 9：能力目录缓存前缀集成测试（spec §8.4 验收证据）
 *
 * 全链路（Task 3 catalogInjector 纯函数 + Task 6 pre-step 接入）集成验证：
 * 1. 轮 1 发送 → 启用新技能（写真实 skillRegistry）→ 轮 2 发送：
 *    - system 字节不变
 *    - 到替换点前的消息前缀 JSON 序列化一致（前缀 hash 一致）
 *    - catalog 消息恰一条且包含新技能名（update-by-id 原地替换）
 * 2. §4.5 逐字还原：catalog user 消息进入 LLM 请求 messages 数组时 content
 *    与发布时 byte-equal（含标签与空白，无 trim/重排）
 * 3. DB 读回 metadata 保留性：writeMessagesDelta 落库后按 id 读回，
 *    metadata.sourceKind / catalogDigest / catalogEntries 完整保留
 *    （使用真实 SqliteConversationRepository，临时目录隔离）
 * 4. 恢复用例：序列化 state → 重建 state → 再跑一轮 pre-step →
 *    请求中 catalog 消息数仍为 1，且零落库写入
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 独立临时目录；
 *    CommandDispatcher mock 掉避免触及文件系统。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

// vi.mock 工厂被提升，路径在工厂内计算；重定向到独立临时目录
vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-catalog-int-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

vi.mock('../../../../src/main/plugin/commands', () => {
    return {
        CommandDispatcher: {
            getInstance: () => ({
                getAllCommands: () => ({pluginGroups: new Map(), userCommands: []}),
            }),
        },
    }
})

import {getDatabase, closeDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'
import type {Message} from '../../../../src/shared/types'
import {skillRegistry} from '../../../../src/main/agent/skills/registry'
import {agentRegistry} from '../../../../src/main/agent/agentRegistry'
import type {SkillDefinition} from '../../../../src/main/agent/skills/types'
import {
    restoreCatalogState,
    runCatalogPreStep,
    type CatalogState,
} from '../../../../src/main/agent/loop/catalogPublish'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import {createLoopState, addMessage, type LoopState} from '../../../../src/main/agent/state'
import type {ChatMessage} from '../../../../src/main/agent/state'
import {SOURCE_KIND_CATALOG} from '../../../../src/shared/types/message'

const CONV_ID = 'conv-it-9'

/** 固定 system prompt：模拟 controller 构建产物（catalog 已迁出 system prompt） */
const SYSTEM_PROMPT_V1 = 'You are a helpful agent.\n\n# Tools\n- bash\n- read'

function makeSkill(id: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
    return {
        id,
        name: id,
        description: `desc-${id}`,
        whenToUse: `trigger-${id}`,
        enabled: true,
        content: 'body',
        ...extra,
    } as SkillDefinition
}

interface RecordedRequest {
    systemPrompt: string
    messages: ChatMessage[]
}

/**
 * 模拟一轮 agent 循环的发送路径：
 * pre-step（catalog 发布/替换）→ preprocessCache normalize（execute.ts 同款）
 * → 记录 (systemPrompt, messages)。llmCaller 为 mock 边界，此处记录其入参。
 * 每轮请求以"本轮用户输入"收尾（与真实循环一致），该输入不进入持久化 state。
 */
let turnSeq = 0
function sendTurn(
    state: LoopState,
    cs: CatalogState,
    repo: SqliteConversationRepository,
    sessionId: string = CONV_ID,
    cache: PreprocessCache = new PreprocessCache(),
): {state: LoopState; catalogState: CatalogState; request: RecordedRequest} {
    const r = runCatalogPreStep(state, cs, repo, sessionId, false)
    turnSeq++
    const withTurnInput: ChatMessage[] = [
        ...r.state.messages,
        {id: `turn-input-${turnSeq}`, role: 'user', content: `input ${turnSeq}`},
    ]
    const messages = cache.process(withTurnInput)
    return {
        state: r.state,
        catalogState: r.catalogState,
        request: {systemPrompt: SYSTEM_PROMPT_V1, messages},
    }
}

function catalogsOf(messages: ReadonlyArray<ChatMessage>): ChatMessage[] {
    return messages.filter(m => (m.metadata as Record<string, unknown> | undefined)?.sourceKind === SOURCE_KIND_CATALOG)
}

let repo: SqliteConversationRepository

beforeEach(() => {
    skillRegistry.clear()
    agentRegistry.clear()
    repo = new SqliteConversationRepository()
    const db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS llm_usage')
    db.exec('DROP TABLE IF EXISTS conversations')
    // 最小 schema（与迁移 001 + 006 对齐，参照 conversationRepository.delta.test.ts harness）
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
        provider_type TEXT NOT NULL, model TEXT NOT NULL,
        provider_name TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER, decode_ms INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )`)
    db.exec('PRAGMA foreign_keys = ON')
    repo.create(CONV_ID, {id: CONV_ID, title: 't', workspacePath: '/tmp/test-ws', createdAt: 1, updatedAt: 1, preview: '', status: 'active'})

    skillRegistry.register(makeSkill('skill-a'))
})

afterEach(() => {
    skillRegistry.clear()
    agentRegistry.clear()
    closeDatabase()
})

describe('能力目录 缓存前缀集成（Task 9）', () => {
    it('轮2：system 字节不变、前缀 hash 一致、catalog 恰一条且含新技能名', () => {
        // 初始消息流：一条用户消息
        let state = createLoopState([
            {id: 'u1', role: 'user', content: 'hello'},
        ])
        let cs: CatalogState = {incompleteStreak: 0}

        // ── 轮 1 ──
        const t1 = sendTurn(state, cs, repo)
        state = t1.state
        cs = t1.catalogState
        expect(catalogsOf(t1.request.messages)).toHaveLength(1)

        // 轮间无追加：每轮请求以 turn-input 收尾（sendTurn 内部模拟）

        // 运行中启用新技能（写真实 registry）
        skillRegistry.register(makeSkill('skill-fresh'))

        // ── 轮 2 ──
        const t2 = sendTurn(state, cs, repo)

        // system 字节不变
        expect(t2.request.systemPrompt).toBe(t1.request.systemPrompt)

        // 到替换点前的前缀一致（brief 断言逐字实现）
        const prefixOf = (req: RecordedRequest) => JSON.stringify(req.messages.slice(0, -2))
        expect(prefixOf(t2.request)).toBe(prefixOf(t1.request))

        // 更强断言：除 catalog 消息与各轮 turn-input 外全部消息逐位不变（位置保持，无重排）
        const stable = (req: RecordedRequest) => req.messages.filter(m =>
            !((m.metadata as Record<string, unknown> | undefined)?.sourceKind === SOURCE_KIND_CATALOG)
            && !(m.id ?? '').startsWith('turn-input-'))
        expect(stable(t2.request)).toEqual(stable(t1.request))

        // catalog 恰一条且含新技能名
        const catalogs = t2.request.messages.filter(m => (m.metadata)?.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogs).toHaveLength(1)
        expect(catalogs[0].content).toContain('skill-fresh')
    })

    it('§4.5 逐字还原：LLM 请求中的 catalog content 与发布时 byte-equal（含标签与空白）', () => {
        let state = createLoopState([{id: 'u1', role: 'user', content: 'go'}])
        let cs: CatalogState = {incompleteStreak: 0}

        const t1 = sendTurn(state, cs, repo)
        state = t1.state
        cs = t1.catalogState

        // 发布时刻的逐字内容（含 <system-reminder> 标签与换行空白）
        const publishedContent = String(catalogsOf(t1.request.messages)[0].content)
        expect(publishedContent.startsWith('<system-reminder>\n')).toBe(true)
        expect(publishedContent.endsWith('</system-reminder>')).toBe(true)

        state = addMessage(state, {id: 'a1', role: 'assistant', content: 'ok'} as ChatMessage)
        skillRegistry.register(makeSkill('skill-fresh'))
        const t2 = sendTurn(state, cs, repo)

        // 发布形态基准：本轮 replace 决策落盘的消息（replacement 文案，与轮 1 first 文案不同属预期）
        const replacedInState = catalogsOf(t2.state.messages)[0]
        expect(String(replacedInState.content)).not.toBe(publishedContent) // replacement ≠ first 文案
        const expectedContent = String(replacedInState.content)

        // 替换后的 catalog 进入请求 messages 时与发布形态 byte-equal：无 trim、无重排
        const req2Catalog = catalogsOf(t2.request.messages)[0]
        const req2Content = String(req2Catalog.content)
        expect(req2Content).toBe(expectedContent)
        // 显式字节级校验：首尾字符与长度均未被规范化
        expect(req2Content.charCodeAt(0)).toBe(expectedContent.charCodeAt(0))
        expect(req2Content.length).toBe(expectedContent.length)
        // 标签结构完整：开闭标签各恰一次
        expect(req2Content.split('<system-reminder>').length - 1).toBe(1)
        expect(req2Content.split('</system-reminder>').length - 1).toBe(1)
    })

    it('DB 读回 metadata 保留性：writeMessagesDelta 落库后按 id 读回 sourceKind/catalogDigest 完整', () => {
        let state = createLoopState([{id: 'u1', role: 'user', content: 'go'}])
        let cs: CatalogState = {incompleteStreak: 0}

        const t1 = sendTurn(state, cs, repo)
        state = t1.state
        cs = t1.catalogState
        const published = catalogsOf(t1.request.messages)[0]
        const digest1 = (published.metadata as Record<string, unknown>).catalogDigest as string
        expect(digest1).toBeTruthy()

        // 从真实 SQLite 读回（repo.readMessages → buildMessagesFromRows）
        // 读侧约定：metadata JSON 展开到消息顶层（content 同理取 metadata.content）
        const rows = repo.readMessages(CONV_ID)
        const back = rows.find(m => m.id === published.id) as (Message & Record<string, unknown>) | undefined
        expect(back).toBeDefined()
        expect(back!.sourceKind).toBe(SOURCE_KIND_CATALOG)
        expect(back!.catalogDigest).toBe(digest1)
        expect(Array.isArray(back!.catalogEntries)).toBe(true)

        // 轮 2 原地替换后再次读回：metadata 随 update-by-id 更新为新 digest，仍完整
        skillRegistry.register(makeSkill('skill-fresh'))
        const t2 = sendTurn(state, cs, repo)
        const replaced = catalogsOf(t2.request.messages)[0]
        const digest2 = (replaced.metadata as Record<string, unknown>).catalogDigest as string
        expect(digest2).not.toBe(digest1)

        const rows2 = repo.readMessages(CONV_ID) as Array<Message & Record<string, unknown>>
        // catalog 恰一行（update-by-id，未产生第二条）
        const catalogRows = rows2.filter(m => m.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogRows).toHaveLength(1)
        const back2 = rows2.find(m => m.id === replaced.id)!
        expect(back2.sourceKind).toBe(SOURCE_KIND_CATALOG)
        expect(back2.catalogDigest).toBe(digest2)
        expect(Array.isArray(back2.catalogEntries)).toBe(true)
        // §4.5 延伸：DB 读回的 content 与请求中 byte-equal（metadata.content 为唯一权威）
        expect(back2.content).toBe(replaced.content)
    })

    it('恢复用例：序列化 state → 重建 state → 再跑一轮 pre-step → catalog 仍为 1 且零写入', () => {
        let state = createLoopState([{id: 'u1', role: 'user', content: 'go'}])
        let cs: CatalogState = {incompleteStreak: 0}

        const t1 = sendTurn(state, cs, repo)
        const originalId = catalogsOf(t1.request.messages)[0].id

        // ── 序列化 / 重建（会话恢复路径）──
        const serialized = JSON.stringify(t1.state.messages)
        const revived = createLoopState(JSON.parse(serialized) as ChatMessage[])
        const restoredCs = restoreCatalogState(revived.messages)
        expect(restoredCs.publishedMessageId).toBe(originalId)

        // 恢复后再跑一轮 pre-step：digest 未变 → none，catalog 仍恰一条，零落库
        const before = (repo.readMessages(CONV_ID) as Array<{id: string}>).length
        const r = runCatalogPreStep(revived, restoredCs, repo, CONV_ID, false)
        const cache = new PreprocessCache()
        const request: RecordedRequest = {systemPrompt: SYSTEM_PROMPT_V1, messages: cache.process(r.state.messages)}
        expect(catalogsOf(request.messages)).toHaveLength(1)
        expect(catalogsOf(request.messages)[0].id).toBe(originalId)
        expect(r.state.messages.length).toBe(revived.messages.length)
        expect((repo.readMessages(CONV_ID) as Array<{id: string}>).length).toBe(before)
    })

    it('端到端恢复（真实链路）：DB 读回 → execution.ts 同款重建 → createLoopState → restoreCatalogState → pre-step，catalog 仍恰一条且零写入', () => {
        // 锁死 Critical：execution.ts agent-start user 分支必须把顶层展开的
        // catalog 字段收拢回 metadata，否则恢复后重复发布第二条 catalog。
        let state = createLoopState([{id: 'u1', role: 'user', content: 'go'}])
        let cs: CatalogState = {incompleteStreak: 0}

        const t1 = sendTurn(state, cs, repo)
        const originalId = catalogsOf(t1.request.messages)[0].id
        const digest1 = (catalogsOf(t1.request.messages)[0].metadata as Record<string, unknown>).catalogDigest as string

        // ── 真实恢复链路 ──
        const dbRows = repo.readMessages(CONV_ID) as Array<Message & Record<string, unknown>>

        // execution.ts 同款重建：user 分支白名单收拢顶层字段回 metadata
        const rebuilt: ChatMessage[] = dbRows.map(m => {
            if (m.role !== 'user') return m as unknown as ChatMessage
            const histMetadata = {
                ...(m.metadata || {}),
                ...(m.sourceKind !== undefined ? {sourceKind: m.sourceKind} : {}),
                ...(m.catalogDigest !== undefined ? {catalogDigest: m.catalogDigest} : {}),
                ...(m.catalogEntries !== undefined ? {catalogEntries: m.catalogEntries} : {}),
                ...(m.catalogSuperseded !== undefined ? {catalogSuperseded: m.catalogSuperseded} : {}),
            }
            return {
                role: 'user' as const,
                content: m.content,
                id: m.id,
                ...(Object.keys(histMetadata).length > 0 ? {metadata: histMetadata} : {}),
            } as ChatMessage
        })

        const revived = createLoopState(rebuilt)
        const restoredCs = restoreCatalogState(revived.messages)
        // 关键断言：重建后 catalog 状态可被扫到（digest 与发布时一致）
        expect(restoredCs.publishedMessageId).toBe(originalId)
        expect(restoredCs.lastDigest).toBe(digest1)

        // 恢复后跑一轮 pre-step：digest 未变 → none，catalog 仍恰一条，零落库写入
        const before = (repo.readMessages(CONV_ID) as Array<{id: string}>).length
        skillRegistry.register(makeSkill('skill-recover-noop')) // 即使 registry 有变化也不应触发重发？——digest 相同则 none
        const r = runCatalogPreStep(revived, restoredCs, repo, CONV_ID, false)
        expect(catalogsOf(r.state.messages)).toHaveLength(1)
        expect(catalogsOf(r.state.messages)[0].id).toBe(originalId)
        expect((repo.readMessages(CONV_ID) as Array<{id: string}>).length).toBe(before)
    })
})
