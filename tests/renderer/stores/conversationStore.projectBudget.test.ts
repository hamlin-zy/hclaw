/**
 * Task 17（spec §10.2）：渲染端内存驻留口径「全局 20」→「按项目 3 常驻 / 5 缓存 + 全局安全阀 30」，
 * 启动预热与 hover 预热按每项目预算收敛。
 *
 * 断言方式：全部走**公开行为入口**（markConversationRendered / preloadConversation /
 * loadMessagesInitial / setActiveConversation / loadConversations）——enforceMessagesMapSizeLimit
 * 与池守卫刻意保持模块私有（不在 store 上暴露），故只能以行为断言覆盖。
 *
 * 保护集（§10.2-2）= 激活会话 + running/thinking + 三种待交互态：预算不得驱逐它们，
 * 因此某项目 / 全局可临时超限（本文件用「4 个运行中会话同项目」显式断言这一点）。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

/** 可变 agentStore 桩：注入 running / thinking / 待交互态（保护集判定） */
const mockAgent = vi.hoisted(() => ({convAgentStates: {} as Record<string, any>}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
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
vi.mock('../../../src/renderer/lib/search', () => ({fuzzyFilter: (items: unknown[]) => items}))
vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: {getState: () => ({groups: []})},
    projectGroupOf: () => null,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

/** 新口径常量（与实现一致；实现改动时此处会同步红灯） */
const MAX_RESIDENT_PER_PROJECT = 3
const MAX_RENDERED_PER_PROJECT = 5
const GLOBAL_MESSAGES_MAP_HARD_CAP = 30

function summary(i: number, prefix: string) {
    return {id: `${prefix}-${i}`, title: `${prefix}${i}`, preview: '', createdAt: 1000 + i, updatedAt: 2000 + i}
}

/** 直灌 messagesMap（模拟「已常驻」），并把会话注册进 workspaces（项目归属反查的前提） */
function seedResident(entries: Array<{id: string; project: string; lastActive: number}>) {
    const messagesMap: Record<string, any[]> = {}
    const lastActive: Record<string, number> = {}
    const workspaces: Record<string, any> = {}
    for (const e of entries) {
        messagesMap[e.id] = [{id: `m-${e.id}`, role: 'user', content: 'x', timestamp: 1}]
        lastActive[e.id] = e.lastActive
        workspaces[e.project] = workspaces[e.project] ?? {lastOpenedAt: 1, conversations: []}
        workspaces[e.project].conversations.push({
            id: e.id, title: e.id, preview: '', createdAt: 1, updatedAt: 1,
        })
    }
    useConversationStore.setState({messagesMap, conversationLastActiveAt: lastActive, workspaces})
}

/** 读取当前 messagesMap 的键（升序，便于精确断言） */
function residentIds(): string[] {
    return Object.keys(useConversationStore.getState().messagesMap).sort()
}

beforeEach(() => {
    mockAgent.convAgentStates = {}
    ;(globalThis as any).window = {electronAPI: {}}
    useConversationStore.setState({
        messagesMap: {}, renderedConversationIds: [], conversationLastActiveAt: {},
        hasMoreMap: {}, loadingMoreMap: {}, workspaces: {},
        activeConversationId: null, currentWorkspacePath: null, viewScope: null,
    })
})

describe('每项目常驻 ≤3（messagesMap 按项目 LRU）', () => {
    it('同项目 5 个常驻 → 裁剪到 3，淘汰最久未激活的 2 个', async () => {
        seedResident(Array.from({length: 5}, (_, i) => ({id: `a-${i}`, project: '/ws/a', lastActive: 1 + i})))
        // 切到最热的 a-4（本身受保护）→ 触发项目内裁剪，淘汰最冷的 a-0 / a-1
        await useConversationStore.getState().setActiveConversation('a-4')
        expect(residentIds()).toEqual(['a-2', 'a-3', 'a-4'])
    })

    it('多项目各自独立计数（3 + 3 合法，不互相挤）', async () => {
        seedResident([
            ...Array.from({length: 3}, (_, i) => ({id: `a-${i}`, project: '/ws/a', lastActive: 1 + i})),
            ...Array.from({length: 3}, (_, i) => ({id: `b-${i}`, project: '/ws/b', lastActive: 1 + i})),
        ])
        await useConversationStore.getState().loadMessagesInitial('a-0')
        expect(residentIds()).toEqual(['a-0', 'a-1', 'a-2', 'b-0', 'b-1', 'b-2'])
    })

    it('保护集优先于预算：某项目 4 个运行中 / 待交互会话时全部保留（允许临时超限）', async () => {
        seedResident(Array.from({length: 4}, (_, i) => ({id: `a-${i}`, project: '/ws/a', lastActive: 1 + i})))
        mockAgent.convAgentStates = {
            'a-0': {agentState: {status: 'running'}},
            'a-1': {agentState: {status: 'thinking'}},
            'a-2': {pendingQuestion: {}},
            'a-3': {pendingPermissionConfirm: {}},
        }
        await useConversationStore.getState().loadMessagesInitial('a-0')
        // 4 > MAX_RESIDENT_PER_PROJECT，但无一会话可驱逐 → 不裁（也不为凑数驱逐流式会话）
        expect(residentIds()).toEqual(['a-0', 'a-1', 'a-2', 'a-3'])
    })

    it('激活会话不被驱逐（即使它是最冷的那个）', async () => {
        seedResident(Array.from({length: 4}, (_, i) => ({id: `a-${i}`, project: '/ws/a', lastActive: 1 + i})))
        useConversationStore.setState({activeConversationId: 'a-0'}) // a-0 最冷但激活
        await useConversationStore.getState().loadMessagesInitial('a-1')
        expect(residentIds()).toContain('a-0')
        expect(residentIds()).toHaveLength(MAX_RESIDENT_PER_PROJECT)
        expect(residentIds()).toEqual(['a-0', 'a-1', 'a-3'])
    })
})

describe('全局安全阀 30（§10.2-4）', () => {
    /** 12 个项目 × 3 常驻 = 36：项目内裁剪无操作，只有全局安全阀能把它压回 30 */
    function seedTwelveProjects() {
        const entries: Array<{id: string; project: string; lastActive: number}> = []
        for (let p = 0; p < 12; p++) {
            for (let i = 0; i < MAX_RESIDENT_PER_PROJECT; i++) {
                entries.push({id: `p${p}-${i}`, project: `/ws/${p}`, lastActive: p * 100 + i})
            }
        }
        seedResident(entries)
    }

    it('12 项目 × 3 常驻 → 压到 30，淘汰最冷项目的最冷会话（p0 / p1 整体出局）', async () => {
        seedTwelveProjects()
        // 从最热项目加载（不改变冷热序）→ 触发全局安全阀
        await useConversationStore.getState().loadMessagesInitial('p11-0')
        const ids = residentIds()
        expect(ids).toHaveLength(GLOBAL_MESSAGES_MAP_HARD_CAP)
        expect(ids.some(id => id.startsWith('p0-'))).toBe(false)
        expect(ids.some(id => id.startsWith('p1-'))).toBe(false)
        expect(ids.filter(id => id.startsWith('p11-'))).toHaveLength(MAX_RESIDENT_PER_PROJECT)
        expect(ids.filter(id => id.startsWith('p2-'))).toHaveLength(MAX_RESIDENT_PER_PROJECT)
    })

    it('安全阀低于「项目数 × 3」时也不驱逐保护集（36 全保护 → 不裁）', async () => {
        seedTwelveProjects()
        mockAgent.convAgentStates = Object.fromEntries(
            Array.from({length: 12}, (_, p) =>
                Array.from({length: MAX_RESIDENT_PER_PROJECT}, (_, i) => [`p${p}-${i}`, {agentState: {status: 'running'}}]),
            ).flat(),
        )
        await useConversationStore.getState().loadMessagesInitial('p5-0')
        expect(residentIds()).toHaveLength(36)
    })
})

describe(`每项目缓存池 ≤${MAX_RENDERED_PER_PROJECT}（renderedConversationIds 守卫）`, () => {
    it('同项目 markConversationRendered 到第 6 个 → 最久未激活的 1 个出池', () => {
        // 先 seed 项目（组视图/项目归属反查需要），再逐个登记
        seedResident(Array.from({length: 6}, (_, i) => ({id: `a-${i}`, project: '/ws/a', lastActive: 1 + i})))
        useConversationStore.setState({renderedConversationIds: [], messagesMap: {}})

        for (let i = 0; i < 6; i++) useConversationStore.getState().markConversationRendered(`a-${i}`)

        const ids = useConversationStore.getState().renderedConversationIds
        expect(ids).toHaveLength(MAX_RENDERED_PER_PROJECT)
        expect(ids).not.toContain('a-0') // 最早登记 = 最冷 → 出池
        expect(ids).toContain('a-5')
    })

    it('预加载入口（preloadConversation）载入成功后登记进池并触发池守卫', async () => {
        seedResident(Array.from({length: 6}, (_, i) => ({id: `a-${i}`, project: '/ws/a', lastActive: 1 + i})))
        // 池里已有 5 个（a-0 最冷），messagesMap 清空以隔离 messagesMap 预算的影响
        useConversationStore.setState({
            messagesMap: {},
            renderedConversationIds: ['a-0', 'a-1', 'a-2', 'a-3', 'a-4'],
        })
        ;(globalThis as any).window = {
            electronAPI: {
                conversationReadTail: vi.fn(async (convId: string) => ({
                    messages: [{id: `m-${convId}`, role: 'user', content: 'x', timestamp: 1}],
                    totalCount: 1,
                })),
            },
        }

        await useConversationStore.getState().preloadConversation('a-5')

        const state = useConversationStore.getState()
        // ★ R-BN(a)：preload 也必须登记进缓存池（否则 hover 路径不受任何上限约束）
        expect(state.renderedConversationIds).toContain('a-5')
        expect(state.renderedConversationIds).toHaveLength(MAX_RENDERED_PER_PROJECT)
        expect(state.renderedConversationIds).not.toContain('a-0')
        // 池守卫的驱逐会同步清掉 messagesMap（evictConversations 语义），新会话本身保留
        expect(state.messagesMap['a-5']).toBeDefined()
    })
})

describe('启动预热只跟激活项目（§10.2）', () => {
    it('loadConversations 只预热 currentWorkspacePath 的会话，且不超过每项目常驻预算', async () => {
        const readTail = vi.fn(async (convId: string) => ({
            messages: [{id: `m-${convId}`, role: 'user', content: 'x', timestamp: 1}],
            totalCount: 1,
        }))
        ;(globalThis as any).window = {
            electronAPI: {
                workspace: {getCurrent: vi.fn(async () => ({path: '/ws/a'})), getGitBranch: vi.fn(async () => null)},
                conversationList: vi.fn(async () => [
                    ...Array.from({length: 12}, (_, i) => ({...summary(i, 'a'), workspacePath: '/ws/a'})),
                    ...Array.from({length: 12}, (_, i) => ({...summary(i, 'b'), workspacePath: '/ws/b'})),
                ]),
                conversationReadTail: readTail,
            },
        }

        await useConversationStore.getState().loadConversations()
        // 激活根会话 + 预热为后台 IIFE（每批 5）→ 等它收敛
        await vi.waitFor(() => {
            expect(readTail.mock.calls.length).toBe(1 + MAX_RESIDENT_PER_PROJECT)
        }, {timeout: 3000})

        const loaded = readTail.mock.calls.map(c => c[0] as string)
        // 其它项目 0 次读取（预热范围只跟 currentWorkspacePath）
        expect(loaded.every(id => id.startsWith('a-'))).toBe(true)
        // 激活根会话（a-11，createdAt 最大）+ 预热量收敛到 min(PRELOAD_MAX, 每项目常驻预算)
        expect(loaded).toEqual(['a-11', 'a-10', 'a-9', 'a-8'])

        const state = useConversationStore.getState()
        expect(Object.keys(state.messagesMap).sort()).toEqual(['a-11', 'a-8', 'a-9'])
        // 缓存池只含本项目会话，且不超每项目池上限
        expect(state.renderedConversationIds.every(id => id.startsWith('a-'))).toBe(true)
        expect(state.renderedConversationIds.length).toBeLessThanOrEqual(MAX_RENDERED_PER_PROJECT)
    })
})
