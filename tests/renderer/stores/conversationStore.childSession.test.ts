/**
 * conversationStore 子会话不落库行为单元测试
 *
 * 覆盖 b9d406f（渲染端跳过子会话落库）引入的行为约定：
 * - 子会话（parentConvId 存在）的 addMessageToConv/updateMessageForConv 不触发任何落库
 *   （conversationWriteMessagesDelta / conversationWriteMessages 均不调用），仅维护内存态
 * - 根会话正常走 delta 落库
 * - 子会话删除后（不再存在于 workspaces）按未知会话处理（不属于子会话）
 *
 * 隔离：mock window.electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

// mock agentStore（conversationStore 依赖它，但仅 action 内部惰性调用 getState）
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            getState: () => ({convAgentStates: {}, activeConversationId: null}),
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

// mock search（纯函数）
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

function makeMsg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): Message {
    return {id, role, content, timestamp: Date.now()}
}

let deltaCalls: Array<{convId: string; message: Message}>
let fullCalls: Array<{convId: string; messages: Message[]}>

const ROOT_ID = 'conv-root'
const CHILD_ID = 'conv-child'

function setupWorkspace() {
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ROOT_ID,
        workspaces: {
            '/ws': {
                lastOpenedAt: 0,
                conversations: [
                    {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    {id: CHILD_ID, title: 'child', preview: '', createdAt: 0, updatedAt: 0, parentConvId: ROOT_ID},
                ],
            },
        },
        messagesMap: {[ROOT_ID]: [], [CHILD_ID]: []},
        loadedMessages: [],
    })
}

beforeEach(() => {
    deltaCalls = []
    fullCalls = []
    ;(globalThis as any).window = {
        electronAPI: {
            conversationWriteMessagesDelta: vi.fn(async (convId: string, message: Message) => {
                deltaCalls.push({convId, message})
                return true
            }),
            conversationWriteMessages: vi.fn(async (convId: string, messages: Message[]) => {
                fullCalls.push({convId, messages})
                return true
            }),
        },
    }
    setupWorkspace()
})

afterEach(() => {
    vi.useRealTimers()
    useConversationStore.getState().cancelPendingSave()
})

describe('子会话不落库（渲染端仅维护内存态）', () => {
    it('子会话 addMessageToConv 不触发任何落库，根会话正常落库', async () => {
        vi.useFakeTimers()

        // 根会话：正常 delta 写
        useConversationStore.getState().addMessageToConv(ROOT_ID, makeMsg('m-root', 'hello'))
        await vi.advanceTimersByTimeAsync(1200)
        expect(deltaCalls.map(c => c.convId)).toEqual([ROOT_ID])

        // 子会话：不触发落库
        deltaCalls.length = 0
        useConversationStore.getState().addMessageToConv(CHILD_ID, makeMsg('m-child', 'child-msg'))
        await vi.advanceTimersByTimeAsync(5000)
        expect(deltaCalls.length).toBe(0)
        expect(fullCalls.length).toBe(0)
    })

    it('子会话 updateMessageForConv 不触发任何落库，但内存态已更新', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv(CHILD_ID, makeMsg('m-child', 'v1'))
        store.updateMessageForConv(CHILD_ID, 'm-child', {content: 'v2'})
        await vi.advanceTimersByTimeAsync(5000)

        expect(deltaCalls.length).toBe(0)
        expect(fullCalls.length).toBe(0)
        // 内存态已更新
        const msgs = useConversationStore.getState().messagesMap[CHILD_ID] || []
        expect(msgs.find(m => m.id === 'm-child')?.content).toBe('v2')
    })

    it('子会话 flushMessages 不触发落库', async () => {
        vi.useFakeTimers()
        const store = useConversationStore.getState()

        store.addMessageToConv(CHILD_ID, makeMsg('m-child', 'a'))
        store.flushMessages()
        await Promise.resolve()

        expect(deltaCalls.length).toBe(0)
        expect(fullCalls.length).toBe(0)
    })

    it('子会话激活状态下 saveMessages 不触发全量兜底', async () => {
        vi.useFakeTimers()
        // saveMessages 只保存 active 会话；激活子会话时应整体跳过写库
        useConversationStore.setState({
            activeConversationId: CHILD_ID,
            loadedMessages: [makeMsg('m-child', 'a')],
        })

        await useConversationStore.getState().saveMessages()

        expect(deltaCalls.length).toBe(0)
        expect(fullCalls.length).toBe(0)
    })

    it('会话被删除后不再判定为子会话（恢复常规落库）', async () => {
        vi.useFakeTimers()
        // 删除子会话（从 workspaces 移除）
        useConversationStore.setState({
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    ],
                },
            },
        })

        useConversationStore.getState().addMessageToConv(CHILD_ID, makeMsg('m-child', 'a'))
        await vi.advanceTimersByTimeAsync(1200)

        // 会话不存在于 workspaces → isChildConversation 返回 false → 走正常 delta 落库
        expect(deltaCalls.length).toBe(1)
        expect(deltaCalls[0].convId).toBe(CHILD_ID)
    })

    it('新子会话加入后立即生效（缓存失效）', async () => {
        vi.useFakeTimers()
        // 先让 CHILD_ID 作为根会话存在（缓存里无 parentConvId）
        useConversationStore.setState({
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                        {id: CHILD_ID, title: 'child', preview: '', createdAt: 0, updatedAt: 0},
                    ],
                },
            },
        })
        useConversationStore.getState().addMessageToConv(CHILD_ID, makeMsg('m-root-before', 'a'))
        await vi.advanceTimersByTimeAsync(1200)
        expect(deltaCalls.length).toBe(1)

        // 之后 CHILD_ID 变成子会话（如主进程补建 parentConvId 后通知渲染端）
        deltaCalls.length = 0
        useConversationStore.setState({
            workspaces: {
                '/ws': {
                    lastOpenedAt: 0,
                    conversations: [
                        {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                        {id: CHILD_ID, title: 'child', preview: '', createdAt: 0, updatedAt: 0, parentConvId: ROOT_ID},
                    ],
                },
            },
        })

        useConversationStore.getState().addMessageToConv(CHILD_ID, makeMsg('m-child-after', 'b'))
        await vi.advanceTimersByTimeAsync(5000)
        expect(deltaCalls.length).toBe(0)
    })

    it('工作区切换后按新工作区判断（缓存隔离）', async () => {
        vi.useFakeTimers()
        // 先进入无子会话的工作区 A
        useConversationStore.setState({
            currentWorkspacePath: '/wsA',
            workspaces: {
                '/wsA': {
                    lastOpenedAt: 0,
                    conversations: [{id: 'conv-a1', title: 'a1', preview: '', createdAt: 0, updatedAt: 0}],
                },
            },
        })

        // 切到工作区 B：B 中该 id 是子会话 → 不落库
        useConversationStore.setState({
            currentWorkspacePath: '/wsB',
            workspaces: {
                '/wsB': {
                    lastOpenedAt: 0,
                    conversations: [
                        {id: 'conv-b1', title: 'b1', preview: '', createdAt: 0, updatedAt: 0},
                        {id: 'conv-b-child', title: 'child', preview: '', createdAt: 0, updatedAt: 0, parentConvId: 'conv-b1'},
                    ],
                },
            },
        })
        useConversationStore.getState().addMessageToConv('conv-b-child', makeMsg('m1', 'x'))
        await vi.advanceTimersByTimeAsync(5000)
        expect(deltaCalls.length).toBe(0)
        expect(fullCalls.length).toBe(0)

        // 切回工作区 A：A 中 conv-a1 是根 → 正常落库
        deltaCalls.length = 0
        useConversationStore.setState({
            currentWorkspacePath: '/wsA',
            workspaces: {
                '/wsA': {
                    lastOpenedAt: 0,
                    conversations: [{id: 'conv-a1', title: 'a1', preview: '', createdAt: 0, updatedAt: 0}],
                },
            },
        })
        useConversationStore.getState().addMessageToConv('conv-a1', makeMsg('m2', 'y'))
        await vi.advanceTimersByTimeAsync(1200)
        expect(deltaCalls.length).toBe(1)
        expect(deltaCalls[0].convId).toBe('conv-a1')
    })
})
