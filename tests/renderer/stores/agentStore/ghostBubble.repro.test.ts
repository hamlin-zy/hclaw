// @vitest-environment jsdom
/**
 * 幽灵气泡复现 — 崩溃恢复后流式 id 与新消息 id 不同步
 *
 * 用户观察：崩溃恢复重建窗口后出现幽灵气泡/空白气泡；重启后恢复正常。
 * 关键线索：重启后幽灵消失 → 幽灵只存在于渲染端内存，DB 无重复行 → 是
 * 渲染端在 messagesMap 里创建了第二条 assistant 消息（messageId 不同）。
 *
 * 统一恢复路径（spec §4.2）：
 * 1. recoverSessions 以主进程快照 v2 为唯一事实源
 * 2. buildSeedInstruction + applySeedInstruction 统一播种：
 *    - upsert seed 消息（DB 无行 → 新增；有行 → 覆盖 content 并清除内存 endedAt）
 *    - stale 工具标记取消
 *    - convAgentStates 置运行态 + streamingMessageId 指向 seedId
 * 3. 后续流式事件走统一 ensureStreamingMessage 入口：
 *    - ① 活跃载体（无 endedAt）直接复用
 *    - ② preferredId（子会话）优先创建占位
 *    - ③ 孤儿收养：内存中存在未终结 assistant → 复用并注册主进程
 *    - ④ 全新占位
 * 无 recoveredStreaming 特判标记，无 D5 竞态守卫分支。
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

describe('崩溃恢复后 — 统一恢复路径（无 recoveredStreaming 标记）', () => {
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

    it('applySeedInstruction 已清除 seed 消息内存 endedAt → ensureStreamingMessage 孤儿收养复用 seedId', () => {
        // 模拟 applySeedInstruction 执行后的状态：
        // - DB/内存已有 seedId 消息（applySeedInstruction upsert 时已清除内存 endedAt）
        // - convAgentStates.streamingMessageId 指向 seedId
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'seedId', role: 'assistant', content: '崩溃前的部分内容', timestamp: Date.now()}, // 无 endedAt（已被 applySeedInstruction 清除）
        ]
        seedConv({streamingMessageId: 'seedId'})

        const result = ensureStreamingMessage(
            () => mockAgentState as any,
            'conv-1',
            undefined,
        )

        // ★ 幽灵断言：旧消息无 endedAt（孤儿），新一轮流式开始时应复用该 id，
        //   绝不因"复用防御"而额外 addMessageToConv 一条新占位（内存出现第二条 assistant）
        const msgs = mockConversationState.messagesMap['conv-1']
        expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
        // streamingMessageId 保持复用 seedId，而非生成新 id
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('seedId')
        // 不重复注册（复用 id 无需再注册主进程）
        expect(registerSpy).not.toHaveBeenCalled()
    })

    it('无孤儿（endedAt 已写）且无 streamingMessageId → 不建占位（id 单源：不自建 UUID，事件未到不建占位）', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'old-ended', role: 'assistant', content: '被 abort 的旧消息', endedAt: Date.now(), timestamp: Date.now()},
        ]
        seedConv({streamingMessageId: null})

        const result = ensureStreamingMessage(() => mockAgentState as any, 'conv-1', undefined)

        // abort 残留防御保留：不挂到历史消息（返回 null 等待主进程 messageId 下发）
        expect(result).toBeNull()
        const msgs = mockConversationState.messagesMap['conv-1']
        expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
    })

    it('首 token 前崩溃 + DB 残留进行中消息（无 endedAt）→ 孤儿收养复用', () => {
        // 快照无累积（seed=null）但 DB 已有残留"进行中"assistant（endedAt 为空）。
        // recoverSessions 仅置运行态，不指向历史消息；后续首个流事件到达时，
        // ensureStreamingMessage 孤儿收养复用该 id。
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'residual-inflight', role: 'assistant', content: '已落库残留', timestamp: Date.now()}, // 无 endedAt
        ]
        seedConv({streamingMessageId: null})

        ensureStreamingMessage(() => mockAgentState as any, 'conv-1', undefined)

        const msgs = mockConversationState.messagesMap['conv-1']
        expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
        expect(mockAgentState.convAgentStates['conv-1'].streamingMessageId).toBe('residual-inflight')
        // 孤儿收养不注册主进程（id 单源：收养 id 本就来自主进程快照，注册链路已删除）
        expect(registerSpy).not.toHaveBeenCalled()
    })
})