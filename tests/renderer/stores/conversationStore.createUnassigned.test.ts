/**
 * createConversation — 未归属虚拟键目标的落库与列表行为
 *
 * 覆盖缺陷修复：newConversation 在「未归属会话激活 + Ctrl+N」时以虚拟键
 * （UNASSIGNED_WORKSPACE_KEY）为目标项目，createConversation 此前把它当真实项目
 * 处理，产生三重副作用：
 *  ① meta.workspacePath='__unassigned__' 落库（DB 污染；workspacePath.ts 的文档化
 *     约定：虚拟键「仅内存使用，不落库、不参与归一化匹配、不得传给主进程 IPC」）；
 *  ② currentWorkspacePath 被写成虚拟键（违反 onConversationCreated :2148 的
 *     「虚拟键不得写入 currentWorkspacePath」约定）；
 *  ③ 调用方 followScopeToProject 切 viewScope → 顶部视图被切到「未归属」单项目
 *     （用户可见症状；调用方侧由 newConversation 服务修复，本文件钉住 store 层）。
 *
 * 行为约定（与 loadConversations / onConversationCreated 的「空路径 = 未归属」同一真相）：
 * - 显式传虚拟键 → 落库 workspacePath=''（空路径真相口径），不写 currentWorkspacePath、
 *   不刷 git 分支、不向主进程 setCurrent；列表条目插入未归属虚拟段（实时可见，不靠兜底）。
 * - 真实项目路径行为不变（回归保护）。
 *
 * 隔离：mock agentStore / electronAPI；动态 import 使模块级监听器注册到桩 API 上。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: vi.fn(),
            removeConvData: () => {},
            flushPendingStreamData: () => {},
        }),
        setState: vi.fn(),
        subscribe: () => () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {UNASSIGNED_WORKSPACE_KEY} from '../../../src/renderer/lib/workspacePath'

const conversationCreateMock = vi.hoisted(() =>
    vi.fn(async (_id: string, _meta: Record<string, unknown>) => {}))

const WS_A = '/workspace-a'

beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).window = {
        electronAPI: {
            conversationCreate: conversationCreateMock,
            agentGetPermissionMode: vi.fn(async () => 'auto'),
            configRead: vi.fn(async () => ({mode: 'compact'})),
            conversationList: vi.fn(async () => []),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            workspace: {
                getCurrent: vi.fn(async () => null),
                getByPath: vi.fn(async () => null),
                getGitBranch: vi.fn(async () => null),
            },
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: WS_A,
        activeConversationId: 'c-existing',
        viewScope: {type: 'group', groupId: 'g-1'},
        workspaces: {
            [WS_A]: {lastOpenedAt: 2, conversations: [
                {id: 'c-existing', title: '旧会话', preview: '', createdAt: 1, updatedAt: 1},
            ]},
            [UNASSIGNED_WORKSPACE_KEY]: {lastOpenedAt: 1, conversations: [
                {id: 'c-unassigned-old', title: '旧未归属', preview: '', createdAt: 1, updatedAt: 1},
            ]},
        },
        messagesMap: {},
        loadedMessages: [],
    })
})

describe('createConversation — 未归属虚拟键目标', () => {
    it('★ 显式传虚拟键：落库空路径（不落虚拟键串）、插未归属段头部、不写 currentWorkspacePath / 不切视图', async () => {
        const id = await useConversationStore.getState().createConversation(undefined, {
            workspacePath: UNASSIGNED_WORKSPACE_KEY,
        })

        // ① 落库空路径（「空 = 未归属」真相口径；虚拟键不进 DB、不传主进程）
        expect(conversationCreateMock).toHaveBeenCalledTimes(1)
        const [convId, meta] = conversationCreateMock.mock.calls[0] as [string, Record<string, unknown>]
        expect(convId).toBe(id)
        expect(meta.workspacePath).toBe('')

        // ② 列表条目插入未归属虚拟段头部（实时可见），原会话保留
        const unassigned = useConversationStore.getState().workspaces[UNASSIGNED_WORKSPACE_KEY]
        expect(unassigned.conversations.map((c: any) => c.id)).toEqual([id, 'c-unassigned-old'])

        // ③ 「在哪干活」/「在看谁」均不动（视图保持项目组视图）
        const state = useConversationStore.getState()
        expect(state.currentWorkspacePath).toBe(WS_A)
        expect(state.viewScope).toEqual({type: 'group', groupId: 'g-1'})
        // 新会话成为激活会话（Ctrl+N 语义）
        expect(state.activeConversationId).toBe(id)
    })

    it('真实项目目标行为不变（回归）：落库真实路径 + 切 currentWorkspacePath', async () => {
        await useConversationStore.getState().createConversation(undefined, {
            workspacePath: '/workspace-b',
        })

        const [convId, meta] = conversationCreateMock.mock.calls[0] as [string, Record<string, unknown>]
        expect(convId).toBeTruthy()
        expect(meta.workspacePath).toBe('/workspace-b')
        expect(useConversationStore.getState().currentWorkspacePath).toBe('/workspace-b')
        // 未归属段不受影响
        expect(useConversationStore.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations
            .map((c: any) => c.id)).toEqual(['c-unassigned-old'])
    })

    it('显式虚拟键 = 显式空目标同语义：workspacePath 传空串也走空路径 + 插未归属段', async () => {
        // 段头「+」等调用方可能直接以空串表达「无项目归属」
        const id = await useConversationStore.getState().createConversation(undefined, {
            workspacePath: '',
        })
        const [, meta] = conversationCreateMock.mock.calls[0] as [string, Record<string, unknown>]
        expect(meta.workspacePath).toBe('')
        const unassigned = useConversationStore.getState().workspaces[UNASSIGNED_WORKSPACE_KEY]
        expect(unassigned.conversations.map((c: any) => c.id)).toContain(id)
    })
})
