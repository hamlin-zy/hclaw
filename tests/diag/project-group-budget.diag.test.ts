/**
 * spec §10.3 补充断言 / Task 23（R-CL）：组视图浏览 N 个项目后的渲染端内存驻留口径。
 *
 * 场景：组视图下 10 个项目 × 5 会话摘要全部在列表里可达，用户逐段「浏览」（切换 active，
 * 走 setActiveConversation → loadMessagesInitial 水合路径，即组视图里点开各段会话的真实路径）。
 * 断言驻留量：
 *   (a) 全局 messagesMap 键数 ≤ 30（全局安全阀 GLOBAL_MESSAGES_MAP_HARD_CAP）；
 *   (b) 每个项目的驻留键数 ≤ 3（每项目预算 MAX_RESIDENT_PER_PROJECT）——**(b) 才是判别力所在**：
 *       旧的「全局单阈值」实现（20 或 30）下 (a) 同样会通过（20 ≤ 30），只有按项目预算
 *       才让 (b) 成立；且 10 项目 × 3 = 30 恰在安全阀上，项目数继续增长也不会突破 (a)。
 *   (c) 非空性反假绿：浏览后激活会话必须在册且键数 > 0（否则「全驱逐」也能骗过 (a)(b)）。
 *
 * 判别力反向验证（Task 23 报告 §2.3 记录了实测证据，两个变体）：
 *   变体 A：每项目预算放宽为 50、全局仍 30 → 快路径按每项目常量早返回而短路，
 *           全局安全阀随之失效 → 驻留 50（随项目数线性增长），(a)(b) 双红；
 *   变体 B：每项目 20 / 全局 20（模拟旧的「全局单阈值」实现）→ (a) 绿（20 ≤ 30）、(b) 红
 *           （项目驻留 5 > 3）——即 (b) 的每项目 ≤ 3 才是把新旧实现区分开的判别力断言。
 *
 * 运行：npm run diag:memory（vitest.diag.config.ts 收集 tests/**；主 vitest.config.ts 的
 * exclude 含 **\/tests/diag/*.diag.test.ts，故不进 npm test）。
 * 桩模式沿用 tests/renderer/stores/conversationStore.projectBudget.test.ts（Task 17）：
 * agentStore / search / projectGroupStore 三个重依赖以桩替身注入，只为隔离预算行为本身。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

/** 可变 agentStore 桩：预留 running / thinking / 待交互态注入位（本文件不注入 → 无保护集超限） */
const mockAgent = vi.hoisted(() => ({convAgentStates: {} as Record<string, any>}))
vi.mock('../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: mockAgent.convAgentStates,
            updateConvData: () => {}, removeConvData: () => {}, flushPendingStreamData: () => {},
            reconcileStreamingContent: () => {}, refreshActiveBatch: () => {},
        }),
        setState: () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))
vi.mock('../../src/renderer/lib/search', () => ({fuzzyFilter: (items: unknown[]) => items}))
vi.mock('../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: {getState: () => ({groups: [], load: async () => {}})},
    projectGroupOf: () => null,
}))

import {useConversationStore} from '../../src/renderer/stores/conversationStore'

/** 新口径常量（与实现一致；实现改动时此处会同步红灯） */
const GLOBAL_MESSAGES_MAP_HARD_CAP = 30
const MAX_RESIDENT_PER_PROJECT = 3
const CONVS_PER_PROJECT = 5

/** 直灌 workspaces（项目归属反查的前提）+ 清空 messagesMap，模拟组视图首屏摘要已就位 */
function seedProjects(projectCount: number): void {
    const workspaces: Record<string, any> = {}
    for (let p = 0; p < projectCount; p++) {
        const conversations = []
        for (let i = 0; i < CONVS_PER_PROJECT; i++) {
            conversations.push({
                id: `p${p}-${i}`, title: `p${p}-${i}`, preview: '',
                createdAt: 1000 + i, updatedAt: 2000 + i,
            })
        }
        workspaces[`/ws/p${p}`] = {lastOpenedAt: 1, conversations}
    }
    useConversationStore.setState({
        workspaces, messagesMap: {}, renderedConversationIds: [], conversationLastActiveAt: {},
        hasMoreMap: {}, loadingMoreMap: {}, activeConversationId: null,
        currentWorkspacePath: null, viewScope: null,
    })
}

/** 逐段「浏览」：切到该项目段的每个会话（组视图中点开会话的真实入口路径） */
async function browseProject(p: number): Promise<void> {
    for (let i = 0; i < CONVS_PER_PROJECT; i++) {
        await useConversationStore.getState().setActiveConversation(`p${p}-${i}`)
    }
}

/** 当前驻留键 → 「项目 → 键列表」分桶（键名形如 p3-2） */
function residentByProject(): Record<string, string[]> {
    const byProject: Record<string, string[]> = {}
    for (const id of Object.keys(useConversationStore.getState().messagesMap)) {
        const p = id.split('-')[0]
        ;(byProject[p] ??= []).push(id)
    }
    return byProject
}

/** (a)(b)(c) 三条不变量统一断言，红时输出分桶明细便于定位 */
function expectBoundedResidence(activeId: string): void {
    const keys = Object.keys(useConversationStore.getState().messagesMap)
    const byProject = residentByProject()

    // (a) 全局安全阀
    expect(keys.length, `全局驻留键数超安全阀；分桶=${JSON.stringify(byProject)}`)
        .toBeLessThanOrEqual(GLOBAL_MESSAGES_MAP_HARD_CAP)
    // (b) 每项目预算：**判别力断言**（旧的全局单阈值实现会在这里红）
    for (const [p, ids] of Object.entries(byProject)) {
        expect(ids.length, `项目 ${p} 驻留 ${ids.length} 个（>${MAX_RESIDENT_PER_PROJECT}）`)
            .toBeLessThanOrEqual(MAX_RESIDENT_PER_PROJECT)
    }
    // (c) 非空反假绿：激活会话必须在册，且确实有驻留（排除「全驱逐」
    //     与「messagesMap 压根没被写入」两种假绿）
    expect(keys).toContain(activeId)
    expect(keys.length).toBeGreaterThan(0)
}

beforeEach(() => {
    mockAgent.convAgentStates = {}
    ;(globalThis as any).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async (convId: string) => ({
                messages: [{id: `m-${convId}`, role: 'user', content: 'x', timestamp: 1}],
                totalCount: 1,
            })),
        },
    }
    useConversationStore.setState({
        messagesMap: {}, renderedConversationIds: [], conversationLastActiveAt: {},
        hasMoreMap: {}, loadingMoreMap: {}, workspaces: {},
        activeConversationId: null, currentWorkspacePath: null, viewScope: null,
    })
})

afterEach(async () => {
    // 切到 null 会 clearActiveTruncate（清掉 30s 自续期定时器，避免跨用例串扰）
    await useConversationStore.getState().setActiveConversation(null)
})

describe('组视图浏览 N 个项目的驻留预算（§10.3）', () => {
    it(`10 项目 × ${CONVS_PER_PROJECT} 会话逐段浏览 → 每项目 ≤${MAX_RESIDENT_PER_PROJECT}、全局 ≤${GLOBAL_MESSAGES_MAP_HARD_CAP}`, async () => {
        seedProjects(10)
        for (let p = 0; p < 10; p++) await browseProject(p)

        const keys = Object.keys(useConversationStore.getState().messagesMap)
        // 50 个会话都进过 messagesMap，最终驻留不得随 50 增长
        expect(keys.length).toBeGreaterThan(0)
        expectBoundedResidence('p9-4')
        // 参考点：每项目预算下 10 项目最多 30 键（= 全局安全阀），不可能留下全部 50
        expect(keys.length).toBeLessThan(CONVS_PER_PROJECT * 10)
    })

    it(`项目数继续增长（10 → 15 项目共 75 会话）→ 驻留不随之线性增长，仍 ≤${GLOBAL_MESSAGES_MAP_HARD_CAP}`, async () => {
        seedProjects(15)
        for (let p = 0; p < 15; p++) await browseProject(p)

        expectBoundedResidence('p14-4')
        const keys = Object.keys(useConversationStore.getState().messagesMap)
        // 75 个会话浏览过，驻留仍是常数上界；且不随项目数线性增长（15 × 3 = 45 被安全阀压到 30）
        expect(keys.length).toBeLessThanOrEqual(GLOBAL_MESSAGES_MAP_HARD_CAP)
        expect(keys.length).toBeLessThan(CONVS_PER_PROJECT * 15)
    })

    it('同一项目内重复浏览（回访）不额外累积：驻留键集合收敛', async () => {
        seedProjects(10)
        for (let p = 0; p < 10; p++) await browseProject(p)
        const afterFirstPass = Object.keys(useConversationStore.getState().messagesMap).length

        // 第二遍回访（用户来回切段）：LRU 驱逐过的会话重新水合，键数不应突破上界
        for (let p = 0; p < 10; p++) await browseProject(p)
        const afterSecondPass = Object.keys(useConversationStore.getState().messagesMap).length

        expectBoundedResidence('p9-4')
        expect(afterSecondPass).toBeLessThanOrEqual(GLOBAL_MESSAGES_MAP_HARD_CAP)
        expect(afterSecondPass).toBeLessThanOrEqual(afterFirstPass)
    })
})
