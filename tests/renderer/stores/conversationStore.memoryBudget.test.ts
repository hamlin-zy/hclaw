/**
 * conversationStore 内存驻留修复回归测试
 *
 * 覆盖两条缺陷：
 * - D2：`truncateLargeResults` 只重建 `message.toolCalls`，从不改写 `message.contentBlocks`。
 *   而 `blocksToMessage`（src/main/repositories/sqlite/messageBlockHelper.ts:288-294）把同一个
 *   ToolCall 对象同时 push 进 `toolCalls` 与 `contentBlocks` → 截断产出新 tc 后，
 *   `contentBlocks[].toolCall.result` 仍指向含全文的旧对象 → 内存一点没省。
 * - D1：`messagesMap` 用数量约束取代字节预算。★ Task 17（spec §10.2）口径变更：
 *   旧「预热 ≤10 + 全局驻留上限 20」→ 新「**每项目**常驻 ≤3 + 每项目缓存池 ≤5 +
 *   全局安全阀 30」。单项目夹具下的边界因此是 3；多项目安全阀用例见下方 f)。
 *
 * ★ 关键设计：D2 断言"通过 contentBlocks 路径也拿不到完整 output"，即全文不可达；
 *   D1 断言预热数量的精确边界、LRU 驱逐顺序，以及 active / running / thinking 的不可驱逐性。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message, ToolCall} from '../../../src/shared/types/message'

/** 可变的 agentStore 桩：D1 的 LRU 保护判定需按会话注入 running/thinking 状态 */
const mockAgent = vi.hoisted(() => ({
    convAgentStates: {} as Record<string, any>,
    removeConvDataCalls: [] as string[],
}))

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: mockAgent.convAgentStates,
            updateConvData: () => {},
            removeConvData: (id: string) => { mockAgent.removeConvDataCalls.push(id) },
            clearConvDoneUnread: () => {},
            flushPendingStreamData: () => {},
            reconcileStreamingContent: () => {},
            refreshActiveBatch: () => {},
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore, truncateLargeResults} from '../../../src/renderer/stores/conversationStore'

const MEMORY_CAP = 2000
const TRUNC_PROMPT = '\n\n*(输出过长，已截断。展开加载完整内容)*'
const BIG_LEN = 10 * 1024
const BIG_OUTPUT = 'X'.repeat(BIG_LEN)

/** 数量约束边界（与实现常量一致；实现改动时此处会同步红灯）
 *  ★ Task 17：PRELOAD_MAX / MAP_MAX 均为**每项目**口径（MIN(PRELOAD_MAX_CONVERSATIONS,
 *    MAX_RESIDENT_PER_PROJECT) 与 MAX_RESIDENT_PER_PROJECT），GLOBAL_MAP_MAX 为全局安全阀。 */
const PRELOAD_MAX = 3
const MAP_MAX = 3
const GLOBAL_MAP_MAX = 30

function userMsg(convId: string, content = `正文-${convId}`): Message {
    return {id: `m-${convId}`, role: 'user', content, timestamp: 1}
}

beforeEach(() => {
    mockAgent.convAgentStates = {}
    mockAgent.removeConvDataCalls.length = 0
    ;(globalThis as any).window = {electronAPI: {}}
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: null,
        workspaces: {'/ws': {lastOpenedAt: 0, conversations: []}},
        messagesMap: {},
        loadedMessages: [],
        hasMoreMap: {},
        loadingMoreMap: {},
        renderedConversationIds: [],
        conversationLastActiveAt: {},
    })
})

afterEach(() => {
    useConversationStore.setState({activeConversationId: null})
})

// ─────────────────────────────────────────────────────────
// D2：截断必须同时落到 contentBlocks（同一 ToolCall 对象引用）
// ─────────────────────────────────────────────────────────

describe('D2 — truncateLargeResults 必须一并改写 contentBlocks', () => {
    /** 照 blocksToMessage 的行为：同一 ToolCall 对象同时进 toolCalls 与 contentBlocks */
    function makeSharedRefMessage(): {msg: Message; shared: ToolCall} {
        const shared: ToolCall = {
            id: 'tc-shared',
            name: 'bash',
            arguments: {cmd: 'echo'},
            status: 'success',
            result: {output: BIG_OUTPUT},
        }
        const msg: Message = {
            id: 'm-shared',
            role: 'assistant',
            content: '正文',
            timestamp: 1,
            toolCalls: [shared],
            contentBlocks: [
                {id: 'b-text', type: 'text', text: '正文'},
                {id: 'b-tool', type: 'tool_use', toolCall: shared},
            ],
        }
        return {msg, shared}
    }

    it('截断后通过 contentBlocks 路径也拿不到完整 output（全文不可达）', () => {
        const {msg} = makeSharedRefMessage()
        const out = truncateLargeResults(msg)

        // toolCalls 路径已截断
        const viaToolCalls = out.toolCalls![0].result!.output as string
        expect(viaToolCalls).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)

        // ★ contentBlocks 路径必须同样不可达全文
        const block = out.contentBlocks!.find(b => b.type === 'tool_use')!
        const viaBlocks = block.toolCall!.result!.output as string
        expect(viaBlocks.length).toBeLessThan(BIG_LEN)
        expect(viaBlocks).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect(out.contentBlocks!.some(b => (b.toolCall?.result as any)?.output === BIG_OUTPUT)).toBe(false)
    })

    it('两条路径共享同一被截断的 ToolCall 引用，幂等标记语义一致', () => {
        const {msg} = makeSharedRefMessage()
        const out = truncateLargeResults(msg)

        const viaToolCalls = out.toolCalls![0]
        const viaBlocks = out.contentBlocks!.find(b => b.type === 'tool_use')!.toolCall!
        // 引用关系正确：两条路径指向同一个对象，避免再次分叉
        expect(viaBlocks).toBe(viaToolCalls)
        expect((viaToolCalls.result as any)._fullOutputStored).toBe(true)
        expect((viaToolCalls.result as any)._outputTruncatedLength).toBe(BIG_LEN)
        expect((viaBlocks.result as any)._fullOutputStored).toBe(true)
        expect((viaBlocks.result as any)._outputTruncatedLength).toBe(BIG_LEN)
    })

    it('重复调用幂等：已截断的消息返回原引用，不再二次追加截断提示', () => {
        const {msg} = makeSharedRefMessage()
        const once = truncateLargeResults(msg)
        const twice = truncateLargeResults(once)

        expect(twice).toBe(once)
        const out = twice.contentBlocks!.find(b => b.type === 'tool_use')!.toolCall!.result!.output as string
        expect(out).toBe(BIG_OUTPUT.slice(0, MEMORY_CAP) + TRUNC_PROMPT)
        expect(out.match(/已截断/g)!.length).toBe(1)
    })

    it('小结果不受影响：不重建数组、保持原引用', () => {
        const shared: ToolCall = {id: 'tc-s', name: 'bash', arguments: {}, status: 'success', result: {output: 'ok'}}
        const msg: Message = {
            id: 'm-s', role: 'assistant', content: 'x', timestamp: 1,
            toolCalls: [shared],
            contentBlocks: [{id: 'b', type: 'tool_use', toolCall: shared}],
        }
        expect(truncateLargeResults(msg)).toBe(msg)
    })
})

// ─────────────────────────────────────────────────────────
// D1：数量约束（预热 ≤10 / 驻留上限 20 / LRU 淘汰）
// ─────────────────────────────────────────────────────────

describe('D1 — messagesMap 数量约束', () => {
    /** 把 n 个会话直接塞进 messagesMap（同属 /ws），lastActiveAt 随索引递增（编号越大越新）。
     *  ★ Task 17：项目路径反查读 workspaces.conversations → 夹具必须把会话注册进去，
     *  否则会话无项目归属，只受全局安全阀约束（每项目预算会静默失效）。 */
    function seed(n: number, extra?: {active?: string}) {
        const map: Record<string, Message[]> = {}
        const lastActive: Record<string, number> = {}
        const conversations: any[] = []
        for (let i = 0; i < n; i++) {
            map[`conv-${i}`] = [userMsg(`conv-${i}`)]
            lastActive[`conv-${i}`] = 1000 + i
            conversations.push({id: `conv-${i}`, title: `t${i}`, preview: '', createdAt: 1, updatedAt: 1})
        }
        if (extra?.active) {
            map[extra.active] = [userMsg(extra.active)]
            lastActive[extra.active] = 500 // 最旧，但它是 active → 不可驱逐
            conversations.push({id: extra.active, title: extra.active, preview: '', createdAt: 1, updatedAt: 1})
        }
        useConversationStore.setState({
            messagesMap: map,
            conversationLastActiveAt: lastActive,
            renderedConversationIds: Object.keys(map),
            hasMoreMap: {},
            loadingMoreMap: {},
            activeConversationId: null,
            workspaces: {'/ws': {lastOpenedAt: 0, conversations}},
        })
        return {map, lastActive}
    }

    // ── a) 预热只加载当前项目最近更新的 min(10, 每项目预算) 个会话 ──
    describe(`a) 启动预热只加载当前项目最近更新的 ${PRELOAD_MAX} 个会话`, () => {
        beforeEach(() => {
            // 15 个会话，createdAt 与 updatedAt 均为 i+1；
            // 侧栏按 createdAt 倒序 → conv-14 为激活根会话（不参与预热）
            const list = Array.from({length: 15}, (_, i) => ({
                id: `conv-${i}`, title: `t${i}`, workspacePath: '/ws',
                createdAt: i + 1, updatedAt: i + 1,
            }))
            ;(globalThis as any).window = {
                electronAPI: {
                    workspace: {
                        getCurrent: vi.fn(async () => ({path: '/ws'})),
                        getGitBranch: vi.fn(async () => null),
                    },
                    conversationList: vi.fn(async () => list),
                    conversationReadTail: vi.fn(async (convId: string) => ({
                        messages: [userMsg(convId)],
                        totalCount: 1,
                    })),
                },
            }
        })

        it(`预热只有 ${PRELOAD_MAX} 个会话进入 messagesMap，且是最近更新的那些`, async () => {
            await useConversationStore.getState().loadConversations()
            // 预热为后台 IIFE（每批 5），等待其收敛：激活会话 1 次 + 预热 PRELOAD_MAX 次读取
            const readTail = (globalThis as any).window.electronAPI.conversationReadTail
            await vi.waitFor(() => {
                expect(readTail.mock.calls.length).toBe(PRELOAD_MAX + 1)
            }, {timeout: 3000})

            // 激活根会话（createdAt 最大）1 个 + 预热最近更新的 PRELOAD_MAX 个：conv-13 … conv-11
            expect(readTail.mock.calls.map((c: [string]) => c[0]).sort())
                .toEqual(['conv-11', 'conv-12', 'conv-13', 'conv-14'])

            const state = useConversationStore.getState()
            const ids = Object.keys(state.messagesMap)
            // ★ 每项目常驻预算 = 3（激活会话 + 预热的 3 个 = 4 已超限 → 最冷者被裁回）
            expect(ids).toHaveLength(MAP_MAX)
            expect(state.messagesMap['conv-14']).toBeDefined()
            // 预热与常驻都只限最近更新的 4 个：最旧的 conv-0 … conv-10 绝不进内存
            expect(ids.every(id => ['conv-11', 'conv-12', 'conv-13', 'conv-14'].includes(id))).toBe(true)
            for (let i = 0; i <= 10; i++) expect(state.messagesMap[`conv-${i}`]).toBeUndefined()
            // 预热进内存的会话必须登记进 LRU（可被 cleanupInactiveConversations 回收），
            // 且缓存池不超每项目上限（这是 D1 与 §10.2 的互补点）
            expect(state.renderedConversationIds).toContain('conv-14')
            for (let i = 11; i <= 13; i++) expect(state.renderedConversationIds).toContain(`conv-${i}`)
            expect(state.renderedConversationIds.length).toBeLessThanOrEqual(5)
        })
    })

    // ── b) 连续切换后每项目始终 ≤ 3 ──────────────────────
    describe(`b) 切换会话后 messagesMap 每项目键数始终 ≤ ${MAP_MAX}`, () => {
        it(`${MAP_MAX} → 连续切换后键数不超上限，且当前会话始终在册`, async () => {
            seed(25)
            for (const id of ['conv-3', 'conv-10', 'conv-20']) {
                await useConversationStore.getState().setActiveConversation(id)
                const state = useConversationStore.getState()
                expect(Object.keys(state.messagesMap).length).toBeLessThanOrEqual(MAP_MAX)
                expect(state.messagesMap[id]).toBeDefined()
            }
        })
    })

    // ── c) 驱逐顺序与保护集 ─────────────────────────────
    // ★ Task 17 拆为两条（原为「23 会话 / 上限 20」的单条同项目用例）：每项目预算 3 时
    //   「3 个保护集 + 仍留最热者」无法在同一项目内共存，故 LRU 顺序与保护集分开断言，
    //   两条的断言都比原用例更紧（精确到键）。
    describe('c) 超限驱逐最后激活时间最旧的会话，active/running/thinking 受保护', () => {
        it('LRU：同项目超限时驱逐最久未激活者，最近激活者保留', async () => {
            seed(13)
            await useConversationStore.getState().loadMessagesInitial('conv-12')

            const s = useConversationStore.getState()
            expect(Object.keys(s.messagesMap).length).toBe(MAP_MAX)
            // 最冷的可驱逐者优先出局
            expect(s.messagesMap['conv-0']).toBeUndefined()
            expect(s.messagesMap['conv-1']).toBeUndefined()
            expect(s.messagesMap['conv-2']).toBeUndefined()
            // 最近激活的保留
            expect(s.messagesMap['conv-12']).toBeDefined()
            expect(s.messagesMap['conv-11']).toBeDefined()
        })

        it('保护集：active 与 running/thinking 会话不被驱逐（允许临时超限）', async () => {
            // 6 个同项目会话：conv-0 running / conv-1 thinking / conv-2 active 恰是最冷三者，
            // conv-3 … conv-5 为可驱逐者 → 预算 3 只容得下三个保护会话
            seed(6)
            mockAgent.convAgentStates = {
                'conv-0': {agentState: {status: 'running'}},
                'conv-1': {agentState: {status: 'thinking'}},
            }
            useConversationStore.setState({activeConversationId: 'conv-2'})

            await useConversationStore.getState().loadMessagesInitial('conv-5')

            const s = useConversationStore.getState()
            expect(Object.keys(s.messagesMap).length).toBe(MAP_MAX)
            // 三个最冷者因保护集身份保留
            expect(s.messagesMap['conv-0']).toBeDefined()
            expect(s.messagesMap['conv-1']).toBeDefined()
            expect(s.messagesMap['conv-2']).toBeDefined()
            // 可驱逐者全部出局
            expect(s.messagesMap['conv-3']).toBeUndefined()
            expect(s.messagesMap['conv-4']).toBeUndefined()
            expect(s.messagesMap['conv-5']).toBeUndefined()
        })
    })

    // ── d) 驱逐一致性收尾 ───────────────────────────────
    describe('d) 驱逐会同步清理各会话级表，无悬空 id', () => {
        it('hasMoreMap / loadingMoreMap / conversationLastActiveAt / renderedConversationIds 同步清理', async () => {
            seed(5) // 5 个同项目会话 → 远超每项目预算，最冷的 conv-0 必被驱逐
            useConversationStore.setState({
                hasMoreMap: {'conv-0': true},
                loadingMoreMap: {'conv-0': true},
            })

            await useConversationStore.getState().setActiveConversation('conv-4')

            const s = useConversationStore.getState()
            expect(s.messagesMap['conv-0']).toBeUndefined()
            expect(s.hasMoreMap['conv-0']).toBeUndefined()
            expect(s.loadingMoreMap['conv-0']).toBeUndefined()
            expect(s.conversationLastActiveAt['conv-0']).toBeUndefined()
            expect(s.renderedConversationIds).not.toContain('conv-0')
            // agent 运行时状态同步释放
            expect(mockAgent.removeConvDataCalls).toContain('conv-0')
        })
    })

    // ── e) 驱逐后可重新水合 ─────────────────────────────
    describe('e) 被驱逐会话可通过 loadMessagesInitial 从 DB 重新水合', () => {
        it('驱逐后重新加载该会话，消息从 DB 恢复', async () => {
            seed(5)
            ;(globalThis as any).window = {
                electronAPI: {
                    conversationReadTail: vi.fn(async (convId: string) => ({
                        messages: [userMsg(convId, `rehydrated-${convId}`)],
                        totalCount: 1,
                    })),
                },
            }

            await useConversationStore.getState().setActiveConversation('conv-4')
            expect(useConversationStore.getState().messagesMap['conv-0']).toBeUndefined()

            await useConversationStore.getState().loadMessagesInitial('conv-0')

            expect(useConversationStore.getState().messagesMap['conv-0']?.[0].content)
                .toBe('rehydrated-conv-0')
        })
    })

    // ── f) 全局安全阀（Task 17 新口径；等价完整用例见 conversationStore.projectBudget.test.ts）──
    describe(`f) 多项目全局安全阀 ${GLOBAL_MAP_MAX}`, () => {
        it(`12 项目 × ${MAP_MAX} 常驻（每项目均在预算内）→ 仍被压回安全阀上限`, async () => {
            const map: Record<string, Message[]> = {}
            const lastActive: Record<string, number> = {}
            const workspaces: Record<string, any> = {}
            for (let p = 0; p < 12; p++) {
                workspaces[`/ws/${p}`] = {lastOpenedAt: 1, conversations: []}
                for (let i = 0; i < MAP_MAX; i++) {
                    const id = `p${p}-${i}`
                    map[id] = [userMsg(id)]
                    lastActive[id] = p * 100 + i
                    workspaces[`/ws/${p}`].conversations.push({
                        id, title: id, preview: '', createdAt: 1, updatedAt: 1,
                    })
                }
            }
            useConversationStore.setState({
                messagesMap: map,
                conversationLastActiveAt: lastActive,
                workspaces,
                renderedConversationIds: [],
                activeConversationId: null,
            })

            await useConversationStore.getState().loadMessagesInitial('p11-0')

            expect(Object.keys(useConversationStore.getState().messagesMap).length).toBe(GLOBAL_MAP_MAX)
        })
    })
})
