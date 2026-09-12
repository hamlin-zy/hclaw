/**
 * recoverSessions 端到端测试（刷新恢复全链路）
 *
 * 背景（P0 事故）：recoverSessions 播种出的运行/阻塞态，被紧随其后的
 * recoverSessionsCleanup() 当场抹掉——cleanup 见 status==='running' 即命中 isBusy，
 * 对同一会话写入 createDefaultConvData()，把刚播种的 pendingToolsChangeConfirm /
 * pendingQuestion / pendingPermissionConfirm 全部清成 null。
 *
 * 修复：recoverSessions 把主进程真实探活结果（agentStatus().allRunning）作为
 * keepRunning 传入 cleanup；已被主进程确认存活的会话跳过清理，状态陈旧（worker
 * 已死）的会话仍被清成 idle。
 *
 * 本用例真正调用 useAgentStore.recoverSessions()（此前 0 覆盖，正是事故盲区）。
 * 隔离：mock conversationStore（消息层）与 window.electronAPI（IPC），
 * agentStore 使用真实实例，断言真实 store 状态。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {StreamSnapshot} from '../../../../src/renderer/stores/agentStore/helpers/recoverySeeding'

// 可检查的迷你 conversationStore（applySeedInstruction / syncConvToTopLevel 会读它）
const h = vi.hoisted(() => {
    const state: Record<string, any> = {
        activeConversationId: 'conv-alive',
        messagesMap: {},
        loadedMessages: [],
        loadMessagesInitial: vi.fn(async () => {}),
        addMessageToConv: vi.fn(),
        updateMessageForConv: vi.fn(),
    }
    return {
        state,
        agentStatus: vi.fn(),
        agentStreamSnapshot: vi.fn(),
    }
})

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {getState: () => h.state},
    flatString: (s: string) => s,
}))

// window.electronAPI stub：必须在 import agentStore 之前注入（persist 中间件读 localStorage）
vi.stubGlobal('window', {
    electronAPI: {
        agentStatus: h.agentStatus,
        agentStreamSnapshot: h.agentStreamSnapshot,
    },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    },
})

import {useAgentStore} from '@/renderer/stores/agentStore'

const RUNNING_STATE = {status: 'running', mode: 'auto', phase: 'streaming'} as const

/** 构造完整快照 v2（阻塞三态可定制） */
function makeSnapshot(overrides: Partial<StreamSnapshot> = {}): StreamSnapshot {
    return {
        streamingMessageId: 'msg-live',
        content: '已产出的正文',
        thinkContent: null,
        toolCalls: [],
        dbTextBlockCount: 0,
        toolStates: {},
        progressLog: {},
        subAgentStream: {},
        pendingQuestion: null,
        pendingPermissionConfirm: null,
        pendingToolsChangeConfirm: null,
        runningToolCount: 0,
        executingToolsMessage: null,
        ...overrides,
    }
}

describe('recoverSessions — 刷新恢复（keepRunning 保留存活会话的阻塞态）', () => {
    beforeEach(() => {
        h.agentStatus.mockReset()
        h.agentStreamSnapshot.mockReset()
        h.state.messagesMap = {}
        h.state.activeConversationId = 'conv-alive'
        h.state.loadMessagesInitial.mockClear()
        h.state.addMessageToConv.mockClear()
        h.state.updateMessageForConv.mockClear()
        useAgentStore.setState({
            convAgentStates: {},
            pendingToolsChangeConfirm: null,
            pendingQuestion: null,
            pendingPermissionConfirm: null,
            agentState: {status: 'idle', mode: 'auto', phase: 'idle'},
        } as any)
    })

    it('主进程确认存活的会话：快照播种的 pendingToolsChangeConfirm / pendingQuestion 恢复后仍存在，且未被 cleanup 清成 idle', async () => {
        // 主进程探活：conv-alive 仍存活；conv-dead 不在列（worker 已死，状态陈旧）
        h.agentStatus.mockResolvedValue({allRunning: ['conv-alive']})
        h.agentStreamSnapshot.mockImplementation(async (convId: string) => {
            if (convId !== 'conv-alive') return null
            return makeSnapshot({
                pendingQuestion: {question: '要继续吗？', options: ['是', '否'], requestId: 'rq-1'},
                pendingPermissionConfirm: {question: '允许写文件？', requestId: 'rp-1'},
                pendingToolsChangeConfirm: {requestId: 'rt-1', added: ['tool_a'], removed: ['tool_b']},
            })
        })
        // 预置残留状态：存活会话（本轮会被播种覆盖）+ 陈旧会话（cleanup 应清理）
        useAgentStore.setState({
            convAgentStates: {
                'conv-alive': {
                    agentState: RUNNING_STATE,
                    pendingToolsChangeConfirm: null,
                    pendingQuestion: null,
                },
                'conv-dead': {
                    agentState: RUNNING_STATE,
                    pendingToolsChangeConfirm: {requestId: 'rt-old', added: [], removed: []},
                },
            },
        } as any)

        await useAgentStore.getState().recoverSessions()

        const alive = useAgentStore.getState().convAgentStates['conv-alive']
        // ★ 核心断言：阻塞三态恢复后仍在（此前被 cleanup 抹成 null）
        expect(alive.pendingToolsChangeConfirm).toEqual({requestId: 'rt-1', added: ['tool_a'], removed: ['tool_b']})
        expect(alive.pendingQuestion).toEqual({question: '要继续吗？', options: ['是', '否'], requestId: 'rq-1'})
        expect(alive.pendingPermissionConfirm).toEqual({question: '允许写文件？', requestId: 'rp-1'})
        // 运行态保留，未被清成 idle
        expect(alive.agentState.status).toBe('running')

        // cleanup 原有能力未破坏：worker 已死的陈旧会话仍被清成 idle
        const dead = useAgentStore.getState().convAgentStates['conv-dead']
        expect(dead.agentState.status).toBe('idle')
        expect(dead.pendingToolsChangeConfirm).toBeNull()
    })

    it('对照组：探活为空（无存活 agent）时，残留 running 会话仍被 cleanup 清成 idle', async () => {
        h.agentStatus.mockResolvedValue({allRunning: []})
        useAgentStore.setState({
            convAgentStates: {
                'conv-dead': {
                    agentState: RUNNING_STATE,
                    pendingQuestion: {question: '旧问题', requestId: 'rq-old'},
                },
            },
        } as any)

        await useAgentStore.getState().recoverSessions()

        const dead = useAgentStore.getState().convAgentStates['conv-dead']
        expect(dead.agentState.status).toBe('idle')
        expect(dead.pendingQuestion).toBeNull()
    })
})
