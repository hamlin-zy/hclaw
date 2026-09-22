/**
 * 会话切换 A→B→A：system 缓存不串染 + 切回后前缀逐字节相等（组 C · P1-4）
 *
 * 契约（KV cache 前缀稳定前提：同会话每轮只允许尾部追加）：
 *
 * 1. system 缓存的**承载点**（先读清，再断言）：
 *    - 落盘载体 = `conversations.system_prompt` 列，**每会话一行**（行主键 id = sessionId），
 *      由 `SqliteConversationRepository.getSystemPrompt/setSystemPrompt` 读写；
 *    - 内存载体 = `controller.#mainLoop` 的局部变量 `cachedSystemPrompt`，
 *      每次 run 开始时从 `conversationRepo.getSystemPrompt(sessionId)` 读一次，
 *      run 内视为不可变 —— 局部变量随会话 run 结束而消失，不跨会话驻留。
 * 2. 复用门控 = `buildSystemPrompt` 的 `cacheSignature === cachedSignature`
 *    （签名 = f(workingDir, agentType, agentDefinition, customInstructions, languageSection)）。
 *
 * 结论（被本文件锁死）：A→B→A 的正确性由两层独立保证 ——
 *   ① DB 行按会话隔离：B 会话运行只写 B 的行，A 的字节不动；
 *   ② 签名门控：签名不一致时**强制重建**，绝不把别的会话文本当前缀复用。
 * 任一层被破坏（SQL 漏 WHERE id / 门控退化为"有缓存就用"）→ 本文件用例红。
 *
 * 隔离：路径桩重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
 * （桩法与 messageBlocksImmutable.test.ts 同款）。
 */
import {describe, expect, it, beforeAll, afterAll, vi} from 'vitest'

vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-prefixsess-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩

import {closeDatabase, getDatabase, runMigrations} from '@/main/repositories/sqlite'
import {SqliteConversationRepository} from '@/main/repositories/sqlite/conversationRepository'
import {buildSystemPrompt} from '@/main/agent/loop/setup'
import {buildSystemSignature} from '@/main/agent/loop/controller'

const CONV_A = 'conv-a'
const CONV_B = 'conv-b'
const WS_A = 'E:/ws-a'
const WS_B = 'E:/ws-b'

let repo: SqliteConversationRepository

beforeAll(() => {
    const db = getDatabase()
    runMigrations()
    for (const id of [CONV_A, CONV_B]) {
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, '', '{}', 1, 1)
    }
    repo = new SqliteConversationRepository()
})

afterAll(() => { closeDatabase() })

/** 清空某会话的 system 缓存行（用例间独立：等价于「该会话从未运行过」） */
function clearCache(convId: string): void {
    getDatabase().prepare('UPDATE conversations SET system_prompt = NULL WHERE id = ?').run(convId)
}

/** 构建 system 用的最小参数（与 setup.cacheSignature.test.ts 同款装配） */
const baseParams = {
    commandContext: null,
    agentDefinition: undefined,
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    agentTemplates: undefined,
}

/** 复刻 controller.#mainLoop 的缓存读写：读回 → 解析 → 门控复用 */
async function buildForSession(
    convId: string,
    workingDir: string,
): Promise<{bytes: string; payload: string; signature: string; reused: boolean}> {
    const raw = repo.getSystemPrompt(convId)
    const parsed = raw ? JSON.parse(raw) as {core: string; signature: string} : null
    const signature = buildSystemSignature(workingDir, 'General', undefined, undefined)
    const bytes = await buildSystemPrompt({
        ...baseParams,
        workingDir,
        agentType: 'General',
        customInstructions: undefined,
        cachedSystemPrompt: parsed?.core ?? null,
        cacheSignature: signature,
        cachedSignature: parsed?.signature ?? null,
    })
    const payload = JSON.stringify({core: bytes, signature})
    // controller 语义：载荷与缓存不同才写回
    if (payload !== raw) repo.setSystemPrompt(convId, payload)
    return {bytes, payload, signature, reused: parsed !== null && parsed.core === bytes}
}

describe('会话切换 A→B→A：system 缓存载体隔离', () => {
    it('B 会话运行期间不覆盖 A 的 system 缓存（每会话一行，字节不变）', async () => {
        // A 先建缓存（并落盘）
        const a = await buildForSession(CONV_A, WS_A)
        const aOnDisk = repo.getSystemPrompt(CONV_A)
        expect(aOnDisk).toBe(a.payload)

        // B 会话运行（不同 workspace → 不同签名 → 必须重建，写自己的行）
        const b = await buildForSession(CONV_B, WS_B)
        expect(b.signature).not.toBe(a.signature)
        expect(repo.getSystemPrompt(CONV_B)).toBe(b.payload)

        // ★ 核心断言：A 的行逐字节未被 B 的运行改写
        expect(repo.getSystemPrompt(CONV_A)).toBe(aOnDisk)
        expect(repo.getSystemPrompt(CONV_A)).not.toBe(repo.getSystemPrompt(CONV_B))
    })

    it('切回 A：签名一致 → 复用缓存，构建出的前缀与离开 A 时逐字节相等', async () => {
        clearCache(CONV_A)
        clearCache(CONV_B)
        const leave = await buildForSession(CONV_A, WS_A)
        expect(leave.reused).toBe(false)   // 首建

        // B 运行一拍
        await buildForSession(CONV_B, WS_B)

        // 切回 A：读同一行缓存 → 签名一致 → 复用，字节与离开时相等
        const back = await buildForSession(CONV_A, WS_A)
        expect(back.reused).toBe(true)
        expect(back.bytes).toBe(leave.bytes)
        expect(back.payload).toBe(leave.payload)
    })

    it('签名不一致（同会话换 workspace）→ 强制重建，绝不把旧前缀当缓存复用', async () => {
        const before = await buildForSession(CONV_A, WS_A)
        const after = await buildForSession(CONV_A, WS_B)
        // 签名变化 → 载荷签名位不同、字节必然不同（门控未退化）
        expect(after.signature).not.toBe(before.signature)
        expect(after.reused).toBe(false)
        expect(after.bytes).not.toBe(before.bytes)
        // 旧字节已不可复用：拿旧 core + 新签名去请求 → 仍重建
        const raw = repo.getSystemPrompt(CONV_A)
        const stored = JSON.parse(raw!) as {core: string; signature: string}
        const forced = await buildSystemPrompt({
            ...baseParams,
            workingDir: WS_B,
            agentType: 'General',
            customInstructions: undefined,
            cachedSystemPrompt: before.bytes,          // 陈旧 core
            cacheSignature: stored.signature,          // 新签名
            cachedSignature: before.signature,         // 与缓存载荷签名不符
        })
        expect(forced).not.toBe(before.bytes)
    })
})
