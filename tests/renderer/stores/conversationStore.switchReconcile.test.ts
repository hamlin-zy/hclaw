/**
 * switchActiveConversation 渲染端补全调用回归测试
 *
 * 保护：切回运行中会话时，conversationStore 必须调用 agentStore 的
 * reconcileStreamingContent 对目标会话做渲染端补全（用 agentStore 流式数据
 * 重建完整 contentBlocks，覆盖 DB 半成品快照）。完成态（idle）不调用。
 *
 * 根因修复语义见 tests/renderer/stores/agentStore/reconcileStreaming.test.ts。
 *
 * 隔离：mock window.electronAPI / agentStore，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const reconcileSpy = vi.hoisted(() => vi.fn())

// mock agentStore：运行中的会话（status=running），streamingMessageId 与内存消息一致
const runningConvStates: Record<string, {
    agentState: {status: 'running' | 'thinking' | 'idle'; mode: 'auto'; phase: string}
    streamingMessageId: string | null
}> = {
    'conv-child': {
        agentState: {status: 'running' as const, mode: 'auto' as const, phase: 'responding' as const},
        streamingMessageId: 'msg-111',
    },
    'conv-child-idle': {
        agentState: {status: 'idle' as const, mode: 'auto' as const, phase: 'idle' as const},
        streamingMessageId: null,
    },
}

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: runningConvStates,
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            // 模拟真实 reconcileStreamingContent 的状态守卫（仅运行中会话补全）
            reconcileStreamingContent: (convId: string) => {
                const st = runningConvStates[convId]?.agentState?.status
                if (st === 'running' || st === 'thinking') reconcileSpy(convId)
            },
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

// mock search（纯函数）
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

function makeMsg(id: string, content: string, role: 'user' | 'assistant' = 'assistant', ts = 1000): Message {
    return {id, role, content, timestamp: ts}
}

const ROOT_ID = 'conv-root'
const CHILD_ID = 'conv-child' // 运行中
const IDLE_CHILD_ID = 'conv-child-idle' // 完成态

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
                    {id: IDLE_CHILD_ID, title: 'child-idle', preview: '', createdAt: 0, updatedAt: 0, parentConvId: ROOT_ID},
                ],
            },
        },
        messagesMap: {
            [ROOT_ID]: [],
            [CHILD_ID]: [],
            [IDLE_CHILD_ID]: [],
        },
        loadedMessages: [],
    })
}

beforeEach(() => {
    reconcileSpy.mockClear()
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async (convId: string) => {
                if (convId === CHILD_ID) {
                    // ★ DB 半成品：仅 think 块已落库（text/tool 块滞留内存 dirty）
                    return {
                        messages: [{
                            id: 'msg-111',
                            role: 'assistant',
                            content: '',
                            timestamp: 600,
                            contentBlocks: [
                                {id: 'think-msg-0', type: 'think', thinkBlock: {id: 'think-msg-0', content: '思考内容', status: 'thinking', timestamp: 600}},
                            ],
                        }],
                        totalCount: 1,
                    }
                }
                if (convId === IDLE_CHILD_ID) {
                    return {
                        messages: [makeMsg('msg-222', '完整最终内容', 'assistant', 600)],
                        totalCount: 1,
                    }
                }
                return {messages: [], totalCount: 0}
            }),
            conversationWriteMessagesDelta: vi.fn(async () => true),
            conversationWriteMessages: vi.fn(async () => true),
        },
    }
    setupWorkspace()
})

describe('switchActiveConversation 渲染端补全调用', () => {
    it('切回运行中的会话 → 调用 reconcileStreamingContent 补全 contentBlocks', async () => {
        const store = useConversationStore.getState()

        await store.setActiveConversation(ROOT_ID)
        await store.setActiveConversation(CHILD_ID)

        expect(reconcileSpy).toHaveBeenCalledWith(CHILD_ID)
    })

    it('切回完成态（idle）会话 → 不调用 reconcileStreamingContent（DB 已完整）', async () => {
        const store = useConversationStore.getState()

        await store.setActiveConversation(ROOT_ID)
        await store.setActiveConversation(IDLE_CHILD_ID)

        expect(reconcileSpy).not.toHaveBeenCalledWith(IDLE_CHILD_ID)
    })
})
