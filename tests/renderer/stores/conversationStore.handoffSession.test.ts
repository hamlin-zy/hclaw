/**
 * handleSessionCreated（会话交接自动切换激活链路）单元测试
 *
 * 背景：交接后新会话无运行态、助手气泡不渲染，必须手动切换才恢复。
 * 根因：handleSessionCreated 走"裸 set + 异步 loadMessagesInitial 整体覆盖"，
 * 绕过了手动切换路径的完整激活链路（switchActiveConversation）。
 *
 * 修复：激活切换复用 switchActiveConversation —— 加载持久化消息 + 运行中会话合并 +
 * reconcileStreamingContent 重建 contentBlocks + 定时截断调度。
 *
 * 本测试验证的行为约定：
 * 1. handleSessionCreated 激活后 activeConversationId 切到新会话
 * 2. 交接总结消息通过 loadMessagesInitial 从 SQLite 加载
 * 3. 去重：重复投递不二次加载（switch 对已激活会话 early-return）
 * 4. 运行中会话（status running + streamingMessageId）激活会调用 reconcileStreamingContent
 *
 * 隔离：mock window.electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

// 可检查的 agentStore 跟踪器（vi.hoisted 使 vi.mock 工厂可引用）
const h = vi.hoisted(() => {
    const agentStateMap: Record<string, any> = {}
    const reconcileCalls: string[] = []
    const updateConvDataCalls: string[] = []
    return {agentStateMap, reconcileCalls, updateConvDataCalls}
})

// mock agentStore（conversationStore 依赖它，但仅 action 内部惰性调用 getState）
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            get convAgentStates() { return h.agentStateMap },
            updateConvData: (convId: string) => { h.updateConvDataCalls.push(convId) },
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            reconcileStreamingContent: (convId: string) => { h.reconcileCalls.push(convId) },
            getState: () => ({convAgentStates: h.agentStateMap, activeConversationId: null}),
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

let readTailCalls: Array<{convId: string}>

const ROOT_ID = 'conv-root'
const NEW_ID = 'conv-handoff-new'
const PARENT_ID = 'conv-parent'

function setupWorkspace() {
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ROOT_ID,
        workspaces: {
            '/ws': {
                lastOpenedAt: 0,
                conversations: [
                    {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    {id: PARENT_ID, title: 'parent', preview: '', createdAt: 0, updatedAt: 0},
                ],
            },
        },
        messagesMap: {[ROOT_ID]: [], [PARENT_ID]: []},
        loadedMessages: [],
    })
}

beforeEach(() => {
    readTailCalls = []
    h.reconcileCalls.length = 0
    h.updateConvDataCalls.length = 0
    delete h.agentStateMap[NEW_ID]
    ;(globalThis as any).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async (convId: string) => {
                readTailCalls.push({convId})
                return {messages: [makeMsg(`msg-summary-${convId}`, 'handoff summary', 'user')], totalCount: 1}
            }),
            conversationReadMessages: vi.fn(async () => []),
            conversationUpdateMeta: vi.fn(async () => true),
        },
    }
    setupWorkspace()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('handleSessionCreated（会话交接自动切换激活链路）', () => {
    it('交接新会话激活：activeConversationId 切换 + 交接总结消息从 SQLite 加载', async () => {
        useConversationStore.getState().handleSessionCreated(NEW_ID, '交接会话', '/ws', PARENT_ID)

        await vi.waitFor(() => {
            expect(readTailCalls.some(c => c.convId === NEW_ID)).toBe(true)
        })

        const store = useConversationStore.getState()
        expect(store.activeConversationId).toBe(NEW_ID)
        const msgs = store.messagesMap[NEW_ID] || []
        expect(msgs.some(m => m.role === 'user' && m.content === 'handoff summary')).toBe(true)
    })

    it('去重守卫：重复投递不二次加载（switch 对已激活会话 early-return）', async () => {
        const store = useConversationStore.getState()
        store.handleSessionCreated(NEW_ID, '交接会话', '/ws', PARENT_ID)
        await vi.waitFor(() => {
            expect(readTailCalls.some(c => c.convId === NEW_ID)).toBe(true)
        })

        // 重复投递（双投递模拟）：侧栏不重复插入，且不再触发二次 loadMessagesInitial
        store.handleSessionCreated(NEW_ID, '交接会话', '/ws', PARENT_ID)
        await Promise.resolve()

        const convs = useConversationStore.getState().workspaces['/ws']?.conversations || []
        expect(convs.filter(c => c.id === NEW_ID).length).toBe(1)
        expect(readTailCalls.filter(c => c.convId === NEW_ID).length).toBe(1)
    })

    it('运行中会话激活切换调用 reconcileStreamingContent 重建流式气泡', async () => {
        // 模拟交接 Worker 已开始流式：status running + 存在 streamingMessageId
        h.agentStateMap[NEW_ID] = {
            agentState: {status: 'running', mode: 'auto', phase: 'text'},
            streamingMessageId: 'msg-stream-1',
            streamBuffer: '流式正文',
            streamBlocks: [{type: 'text', id: 'b1', textOffset: 0}],
        }

        useConversationStore.getState().handleSessionCreated(NEW_ID, '交接会话', '/ws', PARENT_ID)

        await vi.waitFor(() => {
            expect(h.reconcileCalls.includes(NEW_ID)).toBe(true)
        })

        // 激活后 activeConversationId 已切到新会话
        expect(useConversationStore.getState().activeConversationId).toBe(NEW_ID)
    })

    it('无 workspacePath 时仍能激活（不依赖工作区）', async () => {
        useConversationStore.setState({currentWorkspacePath: ''})

        useConversationStore.getState().handleSessionCreated(NEW_ID, '交接会话', '', PARENT_ID)

        await vi.waitFor(() => {
            expect(readTailCalls.some(c => c.convId === NEW_ID)).toBe(true)
        })
        expect(useConversationStore.getState().activeConversationId).toBe(NEW_ID)
    })
})
