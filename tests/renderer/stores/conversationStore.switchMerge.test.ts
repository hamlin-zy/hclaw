/**
 * switchActiveConversation 切回合并回归测试
 *
 * 覆盖缺陷修复：Agent 运行中切换会话再切回时，运行中的助手气泡内容被截断。
 *
 * 根因：切回时（目标会话内存 messagesMap 无 user 消息 → 走 loadMessagesInitial 分支），
 * 若以 SQLite 快照为权威 + 按 id 去重追加流式消息，则：
 *   - SQLite 快照陈旧（纯文本流期间主进程累积器仅在 tool_result / llm_call_done 时机落库，
 *     正文落后于内存）→ 渲染陈旧快照，气泡丢失最新正文
 *   - 流式消息 id（msg-<ts>-<rand>）与 SQLite 同 id → 被去重排除 → 不合并
 *
 * 修复语义：运行中的会话以内存流式消息为权威，SQLite 仅用于补缺（历史消息），
 * 同 id 不重复；完成态（isRunning=false）仍以 SQLite 为权威（不合并，防重复气泡）。
 *
 * 隔离：mock window.electronAPI / agentStore，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

// mock agentStore：运行中的会话（status=running），streamingMessageId 与内存消息一致
const runningConvStates = {
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
const CHILD_ID = 'conv-child' // 运行中（无 user 消息内存态，仅流式 assistant）
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
            [CHILD_ID]: [], // 后续填充
            [IDLE_CHILD_ID]: [],
        },
        loadedMessages: [],
    })
}

beforeEach(() => {
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async (convId: string) => {
                if (convId === CHILD_ID) {
                    // ★ SQLite 陈旧快照：只有早期落库内容（累积器上次 flush 点），
                    //   且包含 user 任务消息 + 同 id 的早期 assistant 消息
                    return {
                        messages: [
                            makeMsg('msg-user', '任务描述', 'user', 500),
                            makeMsg('msg-111', '早期内容（已落库）', 'assistant', 600),
                        ],
                        totalCount: 2,
                    }
                }
                if (convId === IDLE_CHILD_ID) {
                    // 完成态：SQLite 为权威（完整最终内容）
                    return {
                        messages: [
                            makeMsg('msg-user2', '任务2', 'user', 500),
                            makeMsg('msg-222', '完整最终内容', 'assistant', 600),
                        ],
                        totalCount: 2,
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

describe('switchActiveConversation 切回合并（运行中气泡内容保护）', () => {
    it('运行中的子会话切回：内存完整流式消息优先，SQLite 仅补缺', async () => {
        const store = useConversationStore.getState()

        // 内存态：子会话只有流式 assistant 消息（无 user 消息），内容完整
        store.addMessageToConv(CHILD_ID, makeMsg('msg-111', '早期内容 + 后续长正文', 'assistant', 600))

        // 切到根会话，再切回子会话
        await store.setActiveConversation(ROOT_ID)
        await store.setActiveConversation(CHILD_ID)

        const msgs = useConversationStore.getState().messagesMap[CHILD_ID] || []
        // user 消息从 SQLite 补回
        expect(msgs.some(m => m.role === 'user' && m.content === '任务描述')).toBe(true)
        // 流式消息保留内存完整内容（不被 SQLite 陈旧快照覆盖）
        const streamMsg = msgs.find(m => m.id === 'msg-111')
        expect(streamMsg?.content).toBe('早期内容 + 后续长正文')
    })

    it('完成态的子会话切回：以 SQLite 为权威（不合并内存残留）', async () => {
        const store = useConversationStore.getState()

        // 内存态残留：完成态子会话的旧流式消息（同 id，内容为流式中间态）
        store.addMessageToConv(IDLE_CHILD_ID, makeMsg('msg-222', '流式中间态残留', 'assistant', 600))

        await store.setActiveConversation(ROOT_ID)
        await store.setActiveConversation(IDLE_CHILD_ID)

        const msgs = useConversationStore.getState().messagesMap[IDLE_CHILD_ID] || []
        // 以 SQLite 为准（完整最终内容），不显示流式中间态
        expect(msgs.find(m => m.id === 'msg-222')?.content).toBe('完整最终内容')
    })

    it('运行中的子会话切回：内存与 SQLite 消息合并后按 timestamp 有序', async () => {
        const store = useConversationStore.getState()

        // 内存：流式消息（最新）+ 一条更早的内存历史（SQLite 没有）
        // 注：addMessageToConv 强制 timestamp = Date.now()，内存两条按添加顺序递增
        store.addMessageToConv(CHILD_ID, makeMsg('msg-111', '完整正文', 'assistant'))
        store.addMessageToConv(CHILD_ID, makeMsg('msg-999', '早期历史', 'assistant'))

        await store.setActiveConversation(ROOT_ID)
        await store.setActiveConversation(CHILD_ID)

        const msgs = useConversationStore.getState().messagesMap[CHILD_ID] || []
        // 全部消息（SQLite user + 内存流式 + 内存历史）按 timestamp 升序
        const ts = msgs.map(m => m.timestamp)
        expect([...ts].sort((a, b) => a - b)).toEqual(ts)
        // SQLite user 消息（ts=500）早于内存消息（Date.now() >> 500）→ 排在最前
        expect(msgs.map(m => m.id)).toEqual(['msg-user', 'msg-111', 'msg-999'])
    })
})
