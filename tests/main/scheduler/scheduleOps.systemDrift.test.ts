// @vitest-environment node
/**
 * scheduleOps.systemScheduleDrift — 系统任务「还原默认」按钮漂移检测
 *
 * 钉住三条口径：
 * - 出厂配置（与 SYSTEM_SCHEDULE_DEFAULTS 同源）→ drifted=false；
 * - description / cronExpression / taskArgs 任一不等 → drifted=true 且 changedFields 正确；
 * - 仅 isSystem 记录进 map；defaults 中找不到 id 的记录不进 map。
 *
 * 隔离策略与 scheduleOps.isSystemImmutable.test.ts 一致：临时目录 + 假 worker_threads，走真实 SQLite。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-schedule-drift-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

vi.mock('worker_threads', () => {
    class FakeWorker {
        readonly posted: unknown[] = []
        readonly handlers: Record<string, (arg: unknown) => void> = {}
        on(event: string, handler: (arg: unknown) => void): void { this.handlers[event] = handler }
        postMessage(msg: unknown): void { this.posted.push(msg) }
        terminate(): Promise<void> { return Promise.resolve() }
    }
    return {Worker: FakeWorker}
})

import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {createSchedule, systemScheduleDrift} from '@/main/scheduler/scheduleOps'
import {scheduleRepo} from '@/main/scheduler/ScheduleRepository'
import {SYSTEM_SCHEDULE_DEFAULTS} from '@/main/agent/defaults/systemSchedules'

const DEF = SYSTEM_SCHEDULE_DEFAULTS[0]
if (!DEF) throw new Error('SYSTEM_SCHEDULE_DEFAULTS 为空')

function resetScheduleTable(): void {
    getDatabase().exec('DELETE FROM schedules')
}

/** 按出厂值播种一条系统任务（先 create 再由播种路径补 isSystem） */
function seedSystemTask(id: string, over: Record<string, unknown> = {}): void {
    const result = createSchedule({
        id,
        name: DEF.name,
        description: DEF.description,
        cronExpression: DEF.cronExpression,
        taskType: DEF.taskType,
        taskTarget: DEF.taskTarget,
        taskArgs: DEF.taskArgs,
        enabled: true,
        workspaceId: null,
        ...over,
    })
    if (!result.ok) throw new Error(result.error)
    if (over.isSystem !== false) scheduleRepo.update(id, {isSystem: true})
}

describe('scheduleOps.systemScheduleDrift', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('出厂配置 → drifted=false', () => {
        seedSystemTask(DEF.id)
        const result = systemScheduleDrift()
        expect(result.ok).toBe(true)
        expect(result.ok && result.data[DEF.id]).toEqual({drifted: false, changedFields: []})
    })

    it('description / cronExpression / taskArgs 任一不等 → drifted=true 且 changedFields 正确', () => {
        seedSystemTask(DEF.id, {description: '用户改过的描述', cronExpression: '0 5 * * *', taskArgs: ['改过的提示词']})
        const result = systemScheduleDrift()
        expect(result.ok).toBe(true)
        const info = result.ok ? result.data[DEF.id] : undefined
        expect(info!.drifted).toBe(true)
        expect(info!.changedFields.sort()).toEqual(['cronExpression', 'description', 'taskArgs'].sort())
    })

    it('仅改 cron → 只报 cronExpression', () => {
        seedSystemTask(DEF.id, {cronExpression: '30 8 * * *'})
        const result = systemScheduleDrift()
        expect(result.ok && result.data[DEF.id]).toEqual({drifted: true, changedFields: ['cronExpression']})
    })

    it('description null 与出厂空串等价（DB 中可能为 null）', () => {
        // 追加一个 description 为空串的假默认（SYSTEM_SCHEDULE_DEFAULTS 是可变数组），
        // 否则唯一出厂项 description 非空，null 归一等价无从构造
        const fakeDef = {id: 'sys-empty-desc', name: '空描述', description: '',
            cronExpression: '0 1 * * *', taskType: 'agent', taskTarget: 'X', taskArgs: []} as any
        SYSTEM_SCHEDULE_DEFAULTS.push(fakeDef)
        seedSystemTask('sys-empty-desc', {description: '', cronExpression: fakeDef.cronExpression, taskArgs: fakeDef.taskArgs})
        const result = systemScheduleDrift()
        expect(result.ok && result.data['sys-empty-desc']).toEqual({drifted: false, changedFields: []})
    })

    it('非系统任务不进 map；defaults 中找不到 id 的系统任务也不进 map', () => {
        seedSystemTask(DEF.id)
        seedSystemTask('user-1', {isSystem: false})
        seedSystemTask('sys-unknown-id')
        const result = systemScheduleDrift()
        expect(result.ok).toBe(true)
        const map = result.ok ? result.data : {}
        expect(Object.keys(map)).not.toContain('user-1')
        expect(Object.keys(map)).not.toContain('sys-unknown-id')
        expect(Object.keys(map)).toEqual([DEF.id])
    })
})

/**
 * 出厂 prompt 内容锚点：一次性迁移步骤曾长期驻留每小时的 cron prompt
 * （SKILL.md 已不存在 → 条件恒假，每轮白烧 token）。
 */
describe('SYSTEM_SCHEDULE_DEFAULTS 出厂 prompt 内容', () => {
    const memoryPrompt = () =>
        SYSTEM_SCHEDULE_DEFAULTS.find(d => d.id === 'sys-memory-accumulation')!.taskArgs.join('\n')
    /** 取 [from, to) 之间的段落，把断言限定在指定步骤内（避免别处的同名文案蒙混通过） */
    const section = (text: string, from: string, to: string) => {
        const start = text.indexOf(from)
        const end = text.indexOf(to)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        return text.slice(start, end)
    }
    const step2 = () => section(memoryPrompt(), '## 步骤 2', '## 步骤 3')
    const block1 = () => section(memoryPrompt(), '### 块 1', '### 块 2')
    const block2 = () => section(memoryPrompt(), '### 块 2', '### 块 3')
    const block3 = () => section(memoryPrompt(), '### 块 3', '### 数据量控制')

    it('记忆沉淀 prompt 不再含 SKILL.md 迁移步骤，且步骤序列连续', () => {
        const prompt = memoryPrompt()
        expect(prompt).not.toContain('SKILL.md')
        // 步骤 8 之后直接进「约束」段（无残留的步骤 9 / 断号）
        expect(prompt).toContain('## 步骤 8：更新状态')
        expect(prompt).toContain('## 约束')
    })

    it('用户消息取自 messages.metadata，不得 JOIN message_blocks（该组合恒空）', () => {
        // user 正文在 messages.metadata.content，message_blocks 对 user 常 0 行；
        // 曾因 JOIN message_blocks 使块 1 与 P0 探测恒返回空集，修复形同虚设
        for (const seg of [step2(), block1()]) {
            expect(seg).toContain('metadata')
            expect(seg).not.toContain('JOIN message_blocks')
        }
    })

    it('P0 豁免在步骤 2 与块 1 两处生效，且四个触发词都覆盖', () => {
        // 步骤 2 决定会话是否进入分析；块 1 决定 P0 短指令是否被取到——
        // 缺任一处，P0 豁免在流程上都不可达
        expect(step2()).toContain('P0 例外')
        // 断言必须带 SQL 上下文：切片内的散文/注释本身也含这四个词，
        // 只断言 toContain(word) 的话，删掉 SQL 分支测试仍会绿
        for (const word of ['记住', '以后都', 'always', '每次']) {
            expect(step2()).toContain(`LIKE '%${word}%'`)
            expect(block1()).toContain(`LIKE '%${word}%'`)
        }
    })

    it('P0 探测排除注入消息并限定时间窗', () => {
        // 注入正文本身含"记住"等词会污染 P0 判定；command-task 类注入不带
        // <system-reminder> 前缀，故须靠 sourceKind 判别而非前缀过滤
        const seg = step2()
        expect(seg).toContain('sourceKind')
        expect(seg).toContain('{lastAnalyzedAt}')
        // 与块 1 条件集对称：前缀过滤兜住 sourceKind 机制引入前的隐式注入
        expect(seg).toContain("NOT LIKE '<system-reminder>%'")
    })

    it('块 1/2/3 与步骤 2 同源限定消息级时间窗，块 1 按时间倒序取最近 N 条', () => {
        // 块 1/2/3 若缺消息级时间窗，会把上一轮已沉淀过的旧消息重复送入 LLM（与步骤 2 不对称）；
        // 块 1 的 ORDER BY 若为 ASC，数据量控制「超限取最近 N 条」会退化成取最老的一批
        // 断言必须锚定「消息级」字面量：三块本就含会话级 updated_at > {lastAnalyzedAt}，
        // 只断言 toContain('{lastAnalyzedAt}') 在改动前的旧文案上同样为真（恒真假阳性，已实测）
        expect(block1()).toContain('AND m.timestamp > {lastAnalyzedAt}')
        // 块 2 的时间窗落在 messages 子查询内（mb 取到的是 assistant 的 tool_call）
        expect(block2()).toMatch(/AND m\.timestamp > \{lastAnalyzedAt\}\s*\)/)
        // 块 3 的时间窗与 role 过滤同层
        expect(block3()).toMatch(/AND m\.role = 'assistant'[\s\S]*AND m\.timestamp > \{lastAnalyzedAt\}/)
        expect(block1()).toContain('ORDER BY m.timestamp DESC')
        expect(block1()).not.toContain('ORDER BY m.timestamp ASC')
        // 块 3 的跨消息方向须同为 DESC（配合「超限取最近 N 条」），防止被后人改回 ASC；
        // 组内排序（同 msg_id 取最大 sequence）须保持 ASC，防止被后人误改成 DESC
        expect(block3()).toContain('ORDER BY m.timestamp DESC, mb.sequence ASC')
        expect(block3()).not.toContain('ORDER BY m.timestamp ASC')
    })

    it('块 1 恢复取数后仍受数据量控制（超长消息截断）', () => {
        // 块 1 由恒空恢复取数后，单条超长粘贴会显著抬高每轮预算，
        // 故「数据量控制」段须含截断规则
        const seg = section(memoryPrompt(), '### 数据量控制', '## 步骤 4')
        expect(seg).toContain('2000')
        expect(seg).toContain('已截断')
    })
})
