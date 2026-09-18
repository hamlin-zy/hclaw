/**
 * onConversationCreated（渠道 / 定时任务创建会话）归属行为单元测试
 *
 * 覆盖缺陷修复：模块级 IPC 监听器曾对 channel === 'schedule' 强制使用
 * currentWorkspacePath 归属会话，丢弃 payload 中的真实 workspacePath，
 * 导致定时任务会话归属漂移（在项目 A 建任务、切到项目 B 触发时显示在 B，
 * 重载后 loadConversations 按 meta.workspacePath 又跳回 A）。
 *
 * 行为约定（与 handleSessionCreated 同策略）：
 * - 一律按 payload.workspacePath 归属，schedule 不享有"归入当前工作区"特例
 * - workspacePath ≠ currentWorkspacePath 时归入真实工作区，不污染当前工作区
 * - payload 无 workspacePath 时不回退 currentWorkspacePath，直接跳过
 * - 目标工作区未加载时新建条目（与 handleSessionCreated 的
 *   `state.workspaces[workspacePath] || {lastOpenedAt, conversations: []}` 一致）
 * - 重复投递（双投递）去重
 *
 * 隔离：mock window.electronAPI，并用 vi.resetModules + 动态 import 使模块级
 * 监听器在 import 时注册到桩 API 上（node 环境下 window 需先就位再 import）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// mock agentStore（conversationStore 依赖它，仅 action 内部惰性调用 getState）
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            getState: () => ({convAgentStates: {}, activeConversationId: null}),
        }),
        setState: () => {},
        subscribe: () => () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

// mock search（纯函数）
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

const WS_A = '/workspace-a'
const WS_B = '/workspace-b'
const NOT_LOADED = '/workspace-not-loaded'
const SCHED_ID = 'conv-schedule'
const CHANNEL_ID = 'conv-channel'

type CreatedPayload = Record<string, unknown>
type CreatedHandler = (conv: CreatedPayload) => void

let createdHandler: CreatedHandler | null = null

/** 重新加载 conversationStore（模块级监听器在 import 时注册），返回全新 store 实例 */
async function loadStore() {
    vi.resetModules()
    const mod = await import('../../../src/renderer/stores/conversationStore')
    return mod.useConversationStore as any
}

/** 当前工作区为 WS_B，但 WS_A 也已加载（模拟"在 B 中触发了属于 A 的定时任务"） */
function setupWorkspaces(store: any) {
    store.setState({
        currentWorkspacePath: WS_B,
        activeConversationId: 'conv-b-root',
        workspaces: {
            [WS_A]: {
                lastOpenedAt: 2000,
                conversations: [
                    {id: 'conv-a-root', title: 'root-a', preview: '', createdAt: 0, updatedAt: 1000},
                ],
            },
            [WS_B]: {
                lastOpenedAt: 1000,
                conversations: [
                    {id: 'conv-b-root', title: 'root-b', preview: '', createdAt: 0, updatedAt: 500},
                ],
            },
        },
        messagesMap: {},
        loadedMessages: [],
    })
}

function emitCreated(payload: CreatedPayload) {
    expect(createdHandler).toBeTypeOf('function')
    createdHandler!(payload)
}

beforeEach(() => {
    createdHandler = null
    ;(globalThis as any).window = {
        electronAPI: {
            onConversationCreated: (cb: CreatedHandler) => {
                createdHandler = cb
                return () => {
                    createdHandler = null
                }
            },
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            conversationList: vi.fn(async () => []),
            workspace: {getCurrent: vi.fn(async () => null)},
        },
    }
})

afterEach(() => {
    delete (globalThis as any).window
})

describe('onConversationCreated 归属策略', () => {
    it('schedule：按 payload.workspacePath 归入真实工作区，不归入 currentWorkspacePath（缺陷回归）', async () => {
        const store = await loadStore()
        setupWorkspaces(store)
        expect(store.getState().currentWorkspacePath).toBe(WS_B)

        emitCreated({
            id: SCHED_ID,
            title: '每日汇报 - 2026-09-15 09:00:00',
            workspacePath: WS_A,
            createdAt: 3000,
            updatedAt: 3000,
            preview: '',
            pinned: false,
            channel: 'schedule',
            status: 'running',
        })

        const state = store.getState()
        expect(state.workspaces[WS_A].conversations.map((c: any) => c.id)).toEqual([SCHED_ID, 'conv-a-root'])
        // 当前工作区 WS_B 不得被污染
        expect(state.workspaces[WS_B].conversations.map((c: any) => c.id)).toEqual(['conv-b-root'])
    })

    it('schedule：会话列表条目保留 channel/status，供定时任务图标渲染', async () => {
        const store = await loadStore()
        setupWorkspaces(store)

        emitCreated({
            id: SCHED_ID,
            title: '定时任务',
            workspacePath: WS_A,
            createdAt: 3000,
            updatedAt: 3000,
            channel: 'schedule',
            status: 'running',
        })

        expect(store.getState().workspaces[WS_A].conversations[0]).toMatchObject({
            id: SCHED_ID,
            channel: 'schedule',
            status: 'running',
        })
    })

    it('非 schedule 渠道同样按 payload.workspacePath 归属，不污染当前工作区', async () => {
        const store = await loadStore()
        setupWorkspaces(store)

        emitCreated({
            id: CHANNEL_ID,
            title: '[wechat] user-1',
            workspacePath: WS_A,
            createdAt: 3000,
            updatedAt: 3000,
            preview: '',
            pinned: false,
            channel: 'wechat',
        })

        const state = store.getState()
        expect(state.workspaces[WS_A].conversations.map((c: any) => c.id)).toEqual([CHANNEL_ID, 'conv-a-root'])
        expect(state.workspaces[WS_B].conversations.map((c: any) => c.id)).toEqual(['conv-b-root'])
    })

    it('payload 无 workspacePath：跳过插入，不回退 currentWorkspacePath', async () => {
        const store = await loadStore()
        setupWorkspaces(store)

        emitCreated({
            id: SCHED_ID,
            title: '定时任务',
            workspacePath: '',
            createdAt: 3000,
            updatedAt: 3000,
            channel: 'schedule',
        })

        const state = store.getState()
        // 不得插入当前工作区（WS_B）
        expect(state.workspaces[WS_B].conversations.map((c: any) => c.id)).toEqual(['conv-b-root'])
        // 也不得凭空创建条目
        expect(state.workspaces[NOT_LOADED]).toBeUndefined()
        // 归属失败 → 交由 500ms 兜底全量刷新，此处不打断兜底前的状态
        expect(state.activeConversationId).toBe('conv-b-root')
    })

    it('目标工作区未加载：新建条目（与 handleSessionCreated 策略一致，而非跳过）', async () => {
        const store = await loadStore()
        setupWorkspaces(store)

        emitCreated({
            id: SCHED_ID,
            title: '定时任务',
            workspacePath: NOT_LOADED,
            createdAt: 3000,
            updatedAt: 3000,
            channel: 'schedule',
        })

        const state = store.getState()
        expect(state.workspaces[NOT_LOADED].conversations.map((c: any) => c.id)).toEqual([SCHED_ID])

        // 参照实现：handleSessionCreated 对未加载工作区同样新建条目
        const refStore = await loadStore()
        setupWorkspaces(refStore)
        refStore.getState().handleSessionCreated('conv-ref', '交接会话', NOT_LOADED, undefined, 1, 1)
        expect(refStore.getState().workspaces[NOT_LOADED].conversations.map((c: any) => c.id)).toEqual(['conv-ref'])

        // 让 handleSessionCreated 内部 fire-and-forget 的异步链路 settle，避免悬挂
        await new Promise((r) => setTimeout(r, 0))
    })

    it('重复投递（双投递）去重，不重复插入', async () => {
        const store = await loadStore()
        setupWorkspaces(store)

        const payload = {
            id: SCHED_ID,
            title: '定时任务',
            workspacePath: WS_A,
            createdAt: 3000,
            updatedAt: 3000,
            channel: 'schedule',
        }
        emitCreated(payload)
        emitCreated(payload)

        const convs = store.getState().workspaces[WS_A].conversations
        expect(convs.filter((c: any) => c.id === SCHED_ID)).toHaveLength(1)
    })

    it('其他工作区条目保留，不被整体覆盖', async () => {
        const store = await loadStore()
        setupWorkspaces(store)

        emitCreated({
            id: SCHED_ID,
            title: '定时任务',
            workspacePath: WS_A,
            createdAt: 3000,
            updatedAt: 3000,
            channel: 'schedule',
        })

        expect(Object.keys(store.getState().workspaces).sort()).toEqual([WS_A, WS_B])
    })
})
