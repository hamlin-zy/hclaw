// @vitest-environment jsdom
/**
 * 幽灵气泡复现 — 崩溃恢复后流式 id 与新消息 id 不同步
 *
 * 用户观察：崩溃恢复重建窗口后出现幽灵气泡/空白气泡；重启后恢复正常。
 * 关键线索：重启后幽灵消失 → 幽灵只存在于渲染端内存，DB 无重复行 → 是
 * 渲染端在 messagesMap 里创建了第二条 assistant 消息（messageId 不同）。
 *
 * 触发链路：
 * 1. 崩溃前，主进程已用 'seedId' 落库一条 assistant（endedAt 已写）。
 * 2. 崩溃恢复后 recoverSessions 播种 streamingMessageId='seedId'（或置运行态）。
 * 3. 新流式事件到达：若 ensureStreamingMessage / handleBegin 判定旧消息
 *    endedAt 已写 → 置 null → 生成新 randomUUID 占位 → addMessageToConv 加入。
 *    → messagesMap 里现有一条旧 assistant('seedId') + 一条新占位('newId')
 *    → 渲染两条 = 幽灵。重启后从 DB 只读到 'seedId' 一条 → 正常。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {ensureStreamingMessage} from '../../../../src/renderer/stores/agentStore/handlers/streamCore'

const {mockConversationState, mockAgentState, registerSpy} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        addMessageToConv: vi.fn(),
        updateMessageForConv: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        errorMessage: null,
        agentState: {status: 'running'},
    },
    registerSpy: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => mockConversationState,
    },
    recordTextBlock: vi.fn(),
    flushConversationDirty: vi.fn(),
    finalizeMessageDelta: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockAgentState,
    },
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/textBatch', () => ({
    accumulateTextBatch: vi.fn(),
    scheduleImmediateTextFlush: vi.fn(),
    flushTextBatch: vi.fn(),
    clearTextBatch: vi.fn(),
}))

vi.mock('../../../../src/renderer/stores/agentStore/batching/thinkingBatch', () => ({
    accumulateThinkingBatch: vi.fn(),
    scheduleImmediateThinkingFlush: vi.fn(),
    flushThinkingBatch: vi.fn(),
    clearThinkingBatch: vi.fn(),
}))

Object.assign(mockAgentState, {
    updateConvData: (convId: string, patch: any) => {
        mockAgentState.convAgentStates[convId] = {
            ...mockAgentState.convAgentStates[convId],
            ...patch,
            agentState: {
                ...(mockAgentState.convAgentStates[convId]?.agentState || {}),
                ...(patch.agentState || {}),
            },
        }
    },
})

// 让 addMessageToConv 真正把消息写入 messagesMap（模拟真实 store 行为），
// 使"旧消息仍在内存"能被观察到
mockConversationState.addMessageToConv.mockImplementation((convId: string, msg: any) => {
    mockConversationState.messagesMap[convId] = [
        ...(mockConversationState.messagesMap[convId] || []),
        {...msg, id: msg.id || 'generated-' + Math.random()},
    ]
})
// updateMessageForConv 真实更新（validating endedAt 清除逻辑）
mockConversationState.updateMessageForConv.mockImplementation((convId: string, id: string, patch: any) => {
    mockConversationState.messagesMap[convId] = (mockConversationState.messagesMap[convId] || []).map(m =>
        m.id === id ? {...m, ...patch} : m,
    )
})

function seedConv(overrides: any = {}) {
    mockAgentState.convAgentStates['conv-1'] = {
        streamingMessageId: null,
        agentState: {status: 'idle', phase: 'idle'},
        streamBuffer: '',
        streamBlocks: [],
        thinkingContent: null,
        executingToolsMessage: null,
        runningToolCount: 0,
        isThinkingAfterTools: false,
        pendingMessages: [],
        ...overrides,
    }
}

describe('崩溃恢复后 — 旧 assistant 消息 endedAt 已写但流式未重开', () => {
    beforeEach(() => {
        mockAgentState.convAgentStates = {}
        mockAgentState.errorMessage = null
        mockAgentState.agentState = {status: 'running'}
        mockConversationState.messagesMap = {}
        mockConversationState.addMessageToConv.mockClear()
        registerSpy.mockClear()
        vi.stubGlobal('electronAPI', {agentRegisterStreamingMessage: registerSpy})
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('崩溃恢复播种（recoveredStreaming）遇到 endedAt 已写的 seed 消息 → 复用不新增第二条', () => {
        // 崩溃恢复后：DB/内存已加载 seedId 消息（endedAt 已写，崩溃前 worker 已 done 落库）
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'seedId', role: 'assistant', content: '崩溃前的部分内容', endedAt: Date.now(), timestamp: Date.now()},
        ]
        // recoverSessions 播种后 streamingMessageId 指向 seedId 且 recoveredStreaming=true（index.ts:402）
        seedConv({streamingMessageId: 'seedId', recoveredStreaming: true})

        const result = ensureStreamingMessage(
            () => mockAgentState as any,
            'conv-1',
            undefined,
        )

        // ★ 幽灵断言：崩溃恢复后旧消息 endedAt 已写，新一轮流式开始时应复用该 id，
        //   绝不因"复用防御"而额外 addMessageToConv 一条新占位（内存出现第二条 assistant）
        const msgs = mockConversationState.messagesMap['conv-1']
        expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
        // streamingMessageId 保持复用 seedId，而非生成新 id
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('seedId')
        // 内存 endedAt 被清掉，恢复为流式载体
        expect(msgs[0].endedAt).toBeUndefined()
        // 不重复注册（复用 id 无需再注册主进程）
        expect(registerSpy).not.toHaveBeenCalled()
    })

    it('非崩溃恢复场景（recoveredStreaming 未设置）endedAt 已写 → 依旧置 null 生成新 id（正常 abort 残留防御保留）', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'old-ended', role: 'assistant', content: '被 abort 的旧消息', endedAt: Date.now(), timestamp: Date.now()},
        ]
        seedConv({streamingMessageId: 'old-ended'}) // 无 recoveredStreaming

        ensureStreamingMessage(() => mockAgentState as any, 'conv-1', undefined)

        // 原防御保留：产生新占位（不与历史消息冲突），符合 abort 残留语义
        const msgs = mockConversationState.messagesMap['conv-1']
        expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(2)
    })

    it('首 token 前崩溃 + DB 残留进行中消息（recoveredStreaming 播种）→ 复用不新增第二条（用户场景）', () => {
        // 快照无累积（seed=null）但 DB 已有残留"进行中"assistant（endedAt 为空）。
        // recoverSessions 经 planRecovery 的 null 分支复用该 id 播种 recoveredStreaming。
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'residual-inflight', role: 'assistant', content: '已落库残留', timestamp: Date.now()}, // 无 endedAt
        ]
        seedConv({streamingMessageId: 'residual-inflight', recoveredStreaming: true})

        ensureStreamingMessage(() => mockAgentState as any, 'conv-1', undefined)

        const msgs = mockConversationState.messagesMap['conv-1']
        expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('residual-inflight')
    })
})
