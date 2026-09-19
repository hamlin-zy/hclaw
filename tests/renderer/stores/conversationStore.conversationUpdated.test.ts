/**
 * onConversationUpdated（会话元数据更新推送）跨工作区/未归属段匹配行为单元测试
 *
 * 覆盖缺陷修复：模块级 IPC 监听器只在 workspaces[currentWorkspacePath] 单段里
 * findIndex，未命中直接 return。定时任务会话（channel='schedule'，status 初始为
 * 'running'）完成后，主进程 updateConversationStatus 推送 {status:'active'}，但：
 *  - 未归属会话存在 workspaces[UNASSIGNED_WORKSPACE_KEY] 虚拟段（currentWorkspacePath
 *    永远指向真实项目，虚拟键不写入）→ 永远匹配不到 → 侧栏
 *    isSchedulerRunning（channel==='schedule' && status==='running'）恒真 → 图标闪烁不停；
 *  - 同理，任何「非当前工作区」的已加载定时任务会话也匹配不到。
 *
 * 行为约定（与 onConversationDeleted 的全工作区遍历范式一致）：
 * - 先查 currentWorkspacePath（高频路径保持原序），未命中再遍历全部工作区（含未归属虚拟段）
 * - 所有段都未命中 → 无操作（不误更新、不抛错）
 * - currentWorkspacePath 为空（零项目场景）时不再整体早退
 *
 * 隔离：mock window.electronAPI，用 vi.resetModules + 动态 import 使模块级监听器
 * 在 import 时注册到桩 API 上（与 conversationCreated.test.ts 同范式）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
        }),
        setState: () => {},
        subscribe: () => () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {UNASSIGNED_WORKSPACE_KEY} from '../../../src/renderer/lib/workspacePath'

const WS_A = '/workspace-a'
const WS_B = '/workspace-b'

type UpdatedPayload = {id: string; status?: 'active' | 'running' | 'archived'; updatedAt?: number}
type UpdatedHandler = (data: UpdatedPayload) => void

let updatedHandler: UpdatedHandler | null = null

async function loadStore() {
    vi.resetModules()
    const mod = await import('../../../src/renderer/stores/conversationStore')
    return mod.useConversationStore as any
}

function setupWorkspaces(store: any, opts: {currentWorkspacePath: string | null}) {
    store.setState({
        currentWorkspacePath: opts.currentWorkspacePath,
        activeConversationId: null,
        workspaces: {
            [WS_A]: {
                lastOpenedAt: 2000,
                conversations: [
                    {id: 'sched-a', title: '任务A', channel: 'schedule', status: 'running', createdAt: 0, updatedAt: 1000},
                ],
            },
            [WS_B]: {
                lastOpenedAt: 1000,
                conversations: [
                    {id: 'conv-b', title: 'root-b', createdAt: 0, updatedAt: 500},
                ],
            },
            [UNASSIGNED_WORKSPACE_KEY]: {
                lastOpenedAt: 0,
                conversations: [
                    {id: 'sched-unassigned', title: '系统任务', channel: 'schedule', status: 'running', createdAt: 0, updatedAt: 100},
                ],
            },
        },
        messagesMap: {},
        loadedMessages: [],
    })
}

function emitUpdated(payload: UpdatedPayload) {
    expect(updatedHandler).toBeTypeOf('function')
    updatedHandler!(payload)
}

beforeEach(() => {
    updatedHandler = null
    ;(globalThis as any).window = {
        electronAPI: {
            onConversationUpdated: (cb: UpdatedHandler) => {
                updatedHandler = cb
                return () => {
                    updatedHandler = null
                }
            },
            conversationList: vi.fn(async () => []),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            workspace: {getCurrent: vi.fn(async () => null)},
        },
    }
})

afterEach(() => {
    delete (globalThis as any).window
})

describe('onConversationUpdated 跨工作区匹配', () => {
    it('★ 未归属虚拟段的定时任务会话收到 status:active → 更新（缺陷回归：图标闪烁不停）', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        emitUpdated({id: 'sched-unassigned', status: 'active', updatedAt: 9999})

        const conv = store.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations
            .find((c: any) => c.id === 'sched-unassigned')
        expect(conv.status).toBe('active')
    })

    it('非当前工作区（已加载）的定时任务会话收到 status:active → 更新', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        emitUpdated({id: 'sched-a', status: 'active', updatedAt: 9999})

        const conv = store.getState().workspaces[WS_A].conversations.find((c: any) => c.id === 'sched-a')
        expect(conv.status).toBe('active')
    })

    it('当前工作区的会话照常更新（高频路径回归保护）', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        emitUpdated({id: 'conv-b', status: 'archived', updatedAt: 9999})

        const conv = store.getState().workspaces[WS_B].conversations.find((c: any) => c.id === 'conv-b')
        expect(conv.status).toBe('archived')
    })

    it('所有工作区均未命中 → 无操作不抛错', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        expect(() => emitUpdated({id: 'ghost-conv', status: 'active', updatedAt: 9999})).not.toThrow()
        // 各段内容不变
        expect(store.getState().workspaces[WS_A].conversations[0].status).toBe('running')
        expect(store.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations[0].status).toBe('running')
    })

    it('currentWorkspacePath 为空（零项目场景）→ 未归属会话仍能更新', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: null})

        emitUpdated({id: 'sched-unassigned', status: 'active', updatedAt: 9999})

        const conv = store.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations
            .find((c: any) => c.id === 'sched-unassigned')
        expect(conv.status).toBe('active')
    })
})
