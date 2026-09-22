/**
 * 记忆沉淀前置探针 — 纯函数 + 注入 deps 单测
 *
 * 背景：`sys-memory-accumulation` 每 2 小时整点起一次独立会话跑 LLM 循环，
 * 多数轮次只是「无待沉淀会话」的空转（LLM 自己查库后退出）。本模块把
 * 「有无待办」的判定前置到主进程本地 SQL，无待办则调用方直接短路。
 *
 * 本文件钉住三类行为：
 *   1. `readLastAnalyzedAt` 的容错口径：文件缺失 / JSON 损坏 / 字段缺失或非有限数 → 0
 *      （0 表示「分析全部历史」，与 prompt 里「文件不存在则设为 0」同源）
 *   2. fail-open：任何异常（读文件抛、查库抛）一律返回 true（放行），
 *      退回无探针时的行为 —— 探针坏掉不能把记忆沉淀整体静默停掉
 *   3. 默认 `countPending` 的 SQL 口径：真实内存 SQLite 建 conversations 表，
 *      验证时间窗 + IFNULL(channel) 排除两个条件同时生效
 *
 * 隔离：memoryProbe 只从 sqlite 模块取 `getDatabase`，此处把整个模块打桩成内存库，
 * 不触碰真实 ~/.hclaw/data/hclaw.db。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {DatabaseSync} from '@photostructure/sqlite'

const dbHolder = vi.hoisted(() => ({db: null as unknown}))
vi.mock('@/main/repositories/sqlite', () => ({
    getDatabase: () => dbHolder.db,
}))

import {
    MEMORY_COOLDOWN_MS,
    readLastAnalyzedAt,
    hasPendingConversations,
} from '@/main/scheduler/memoryProbe'

describe('readLastAnalyzedAt — 容错口径', () => {
    it('state 原文为 null（文件缺失）→ 0', () => {
        expect(readLastAnalyzedAt(null)).toBe(0)
    })

    it('空字符串 → 0', () => {
        expect(readLastAnalyzedAt('')).toBe(0)
    })

    it('JSON 损坏 → 0', () => {
        expect(readLastAnalyzedAt('{"lastAnalyzedAt":123')).toBe(0)
    })

    it('lastAnalyzedAt 字段缺失 → 0', () => {
        expect(readLastAnalyzedAt(JSON.stringify({lastConversationId: 'c1'}))).toBe(0)
    })

    it('lastAnalyzedAt 非数字（字符串 / null）→ 0', () => {
        expect(readLastAnalyzedAt(JSON.stringify({lastAnalyzedAt: '123'}))).toBe(0)
        expect(readLastAnalyzedAt(JSON.stringify({lastAnalyzedAt: null}))).toBe(0)
    })

    it('合法结构 → 取回数值', () => {
        expect(readLastAnalyzedAt(JSON.stringify({lastAnalyzedAt: 1758000000000, lastConversationId: 'c1'})))
            .toBe(1758000000000)
    })
})

describe('hasPendingConversations — 放行 / 跳过与 fail-open', () => {
    const now = 1758000000000

    it('countPending 返回 0 → false（跳过）', () => {
        expect(hasPendingConversations(now, {countPending: () => 0})).toBe(false)
    })

    it('countPending 返回 3 → true（放行）', () => {
        expect(hasPendingConversations(now, {countPending: () => 3})).toBe(true)
    })

    it('readStateFile 抛异常 → true，且不向调用方抛', () => {
        const boom = () => { throw new Error('EACCES') }
        expect(() => hasPendingConversations(now, {readStateFile: boom})).not.toThrow()
        expect(hasPendingConversations(now, {readStateFile: boom})).toBe(true)
    })

    it('countPending 抛异常 → true', () => {
        const boom = () => { throw new Error('db closed') }
        expect(hasPendingConversations(now, {countPending: boom})).toBe(true)
    })

    it('传给 countPending 的冷却截止 = now - 30 分钟', () => {
        const seen: number[] = []
        hasPendingConversations(now, {
            readStateFile: () => JSON.stringify({lastAnalyzedAt: 111}),
            countPending: (_last, cutoff) => { seen.push(cutoff); return 1 },
        })
        expect(seen).toEqual([now - 30 * 60 * 1000])
        expect(MEMORY_COOLDOWN_MS).toBe(30 * 60 * 1000)
    })

    it('lastAnalyzedAt 从 state 原文解析后传给 countPending（不经过二次加工）', () => {
        const seen: number[] = []
        hasPendingConversations(now, {
            readStateFile: () => JSON.stringify({lastAnalyzedAt: 111, lastConversationId: 'c'}),
            countPending: (last) => { seen.push(last); return 0 },
        })
        expect(seen).toEqual([111])
    })
})

/**
 * 钳制口径（第二轮修正）：未来时间戳视作 0。
 *
 * 探针引入前，每轮 LLM 都会读 `.state.json` 并在步骤 8 重写它，state 被写坏后能自愈；
 * 探针引入后，若 `lastAnalyzedAt` 是未来时间戳，窗口恒空 → 探针永久判「无待办」→
 * 任务永久静默停摆且永不进 LLM 自愈。fail-open 只兜异常，兜不住「合法但荒谬的有限数」。
 */
describe('hasPendingConversations — lastAnalyzedAt 未来时间戳钳制', () => {
    const now = 1758000000000

    /** 记录传给 countPending 的窗口下界 */
    function seenLast(raw: string | null): number[] {
        const seen: number[] = []
        hasPendingConversations(now, {
            readStateFile: () => raw,
            countPending: (last) => { seen.push(last); return 0 },
        })
        return seen
    }

    it('未来时间戳（state 被写坏）→ 钳到 0（全量重扫，换 LLM 自愈）', () => {
        expect(seenLast(JSON.stringify({lastAnalyzedAt: now + 1e9}))).toEqual([0])
    })

    it('lastAnalyzedAt === now（边界，等于当前时刻）→ 原样透传，不钳', () => {
        expect(seenLast(JSON.stringify({lastAnalyzedAt: now}))).toEqual([now])
    })

    it('lastAnalyzedAt 为负值 → 原样透传（窗口从 -1 起算等价于从 0 起算，无害）', () => {
        expect(seenLast(JSON.stringify({lastAnalyzedAt: -1}))).toEqual([-1])
    })
})

describe('默认 countPending — 真实内存 SQLite 的 SQL 口径', () => {
    const lastAnalyzedAt = 1_000_000
    const cooldownCutoff = 2_000_000
    /** 由 hasPendingConversations 推出的 now：冷却截止 = now - 30min */
    const now = cooldownCutoff + MEMORY_COOLDOWN_MS

    let db: InstanceType<typeof DatabaseSync>

    beforeEach(() => {
        db = new DatabaseSync(':memory:')
        db.exec(`CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            workspace_path TEXT,
            meta TEXT,
            created_at INTEGER,
            updated_at INTEGER
        )`)
        dbHolder.db = db

        const insert = db.prepare(
            'INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        // 窗口外（早于 lastAnalyzedAt）
        insert.run('before-window', 'E:/ws', '{}', 1, lastAnalyzedAt - 500_000)
        // 窗口内 + meta 无 channel 键（json_extract 返回 NULL —— IFNULL 回归点）
        insert.run('in-window-no-channel', 'E:/ws', '{}', 1, 1_500_000)
        // 窗口内 + 有 channel 键但非 schedule
        insert.run('in-window-other-channel', 'E:/ws', '{"channel":"wechat"}', 1, 1_450_000)
        // 窗口内 + channel='schedule'（定时任务自身产生的会话）
        insert.run('in-window-schedule', 'E:/ws', '{"channel":"schedule"}', 1, 1_600_000)
        // 冷却期内（updated_at > 冷却截止）
        insert.run('in-cooldown', 'E:/ws', '{}', 1, cooldownCutoff + 1)
    })

    afterEach(() => {
        db.close()
        dbHolder.db = null
    })

    it('窗口 + IFNULL 两层过滤同时生效：只剩 meta 无 channel 键那一行也仍判为「有待办」', () => {
        const readStateFile = () => JSON.stringify({lastAnalyzedAt})
        // 注入 readStateFile 只替换读取来源，countPending 走默认（真实 SQL）
        expect(hasPendingConversations(now, {readStateFile})).toBe(true)

        // 逐条核验判别力：删掉 schedule 那一行不影响结论
        db.prepare("DELETE FROM conversations WHERE id = 'in-window-schedule'").run()
        expect(hasPendingConversations(now, {readStateFile})).toBe(true)

        // 只剩 meta 里没有 channel 键的那一行（json_extract → NULL）——
        // 若 SQL 丢了 IFNULL，此行会被 NULL != 'schedule' 判成非真而漏掉，这里会翻成 false
        db.prepare("DELETE FROM conversations WHERE id != 'in-window-no-channel'").run()
        expect(hasPendingConversations(now, {readStateFile})).toBe(true)

        // 只剩定时任务自身产生的会话（窗口内）→ 无待办
        db.prepare("DELETE FROM conversations WHERE id = 'in-window-no-channel'").run()
        db.prepare(`INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at)
                    VALUES ('only-schedule', 'E:/ws', '{"channel":"schedule"}', 1, 1_700_000)`).run()
        expect(hasPendingConversations(now, {readStateFile})).toBe(false)

        // 窗口外（早于 lastAnalyzedAt）+ 冷却期内（晚于截止）都不算候选 → 无待办
        db.prepare("DELETE FROM conversations WHERE id = 'only-schedule'").run()
        db.prepare(`INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at)
                    VALUES ('too-old', 'E:/ws', '{}', 1, ?)`).run(lastAnalyzedAt - 1)
        db.prepare(`INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at)
                    VALUES ('in-cooldown-2', 'E:/ws', '{}', 1, ?)`).run(cooldownCutoff)
        expect(hasPendingConversations(now, {readStateFile})).toBe(false)
    })

    it('state 为 0（文件缺失）→ 窗口从 0 起算，冷却期仍生效', () => {
        const readStateFile = () => null
        // before-window 那行（updated_at = 500000）此时落在窗口内 → 有 3 行合法候选
        expect(hasPendingConversations(now, {readStateFile})).toBe(true)
        db.prepare('DELETE FROM conversations WHERE updated_at < ?').run(cooldownCutoff)
        expect(hasPendingConversations(now, {readStateFile})).toBe(false)
    })
})
