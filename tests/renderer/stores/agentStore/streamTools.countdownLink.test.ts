// @vitest-environment jsdom
/**
 * handleToolUse + handleToolStart 端到端链路测试
 *
 * 保护：bash 工具执行时，tool_use 创建卡片 → tool_start 注册倒计时数据
 * （模拟 worker 事件序列，验证 toolCallsStore 运行时状态完整）
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleToolUse, handleToolStart, handleToolCompleted} from '../../../../src/renderer/stores/agentStore/handlers/streamTools'
import {useToolCallsStore} from '../../../../src/renderer/stores/toolCallsStore'

const mockConvData = vi.hoisted((): {
    convAgentStates: Record<string, any>
    agentState: {status: string}
    updateConvData?: (convId: string, patch: any) => void
    updateMessageContentBlocks?: (...args: any[]) => void
} => ({
    convAgentStates: {},
    agentState: {status: 'idle'},
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockConvData,
    },
}))

// agentStore 的 updateConvData 是 store 内部方法，这里用真实 agentStore 简化——
// 改为在 mock 上提供 updateConvData，由测试直接修改 mockConvData
Object.assign(mockConvData, {
    updateConvData: (convId: string, patch: any) => {
        mockConvData.convAgentStates[convId] = {
            ...mockConvData.convAgentStates[convId],
            ...patch,
            agentState: {...(mockConvData.convAgentStates[convId]?.agentState || {}), ...(patch.agentState || {})},
        }
    },
    updateMessageContentBlocks: vi.fn(),
})

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({
            messagesMap: {},
            activeConversationId: 'conv-1',
            addMessageToConv: vi.fn(),
            updateMessageForConv: vi.fn(),
        }),
    },
    recordToolCallBlock: vi.fn(),
}))

// textBatch 依赖 window/requestAnimationFrame，mock 掉
vi.mock('../../../../src/renderer/stores/agentStore/batching/textBatch', () => ({
    flushTextBatch: vi.fn(),
    clearTextBatch: vi.fn(),
}))

beforeEach(() => {
    useToolCallsStore.getState().clearAll()
    mockConvData.convAgentStates = {
        'conv-1': {
            streamingMessageId: null,
            agentState: {status: 'running'},
            streamBuffer: '',
            streamBlocks: [],
            executingToolsMessage: null,
            runningToolCount: 0,
            isThinkingAfterTools: false,
        },
    }
})

function makeCtx(convId: string, event: any) {
    return {
        set: vi.fn(),
        get: () => mockConvData as any,
        convId,
        isActiveConv: true,
        isAgentAborted: false,
        event,
    }
}

describe('bash 工具倒计时链路（tool_use → tool_start）', () => {
    it('tool_start 携带 timeoutMs → toolCallsStore 注册 startedAt+timeoutMs', () => {
        const toolCallId = 'call-bash-test-1'
        const convId = 'conv-1'

        // Step 1: tool_use（LLM 返回工具调用）
        handleToolUse(makeCtx(convId, {
            type: 'tool_use',
            toolCall: {id: toolCallId, name: 'bash', arguments: {command: 'sleep 10'}},
        }))

        // Step 2: tool_start（工具开始执行，注入超时 30s）
        handleToolStart(makeCtx(convId, {
            type: 'tool_start',
            toolCall: {id: toolCallId, name: 'bash', arguments: {command: 'sleep 10'}, timeoutMs: 30000},
        }))

        const state = useToolCallsStore.getState().states[toolCallId]
        expect(state).toBeDefined()
        expect(state?.status).toBe('running')
        expect(state?.timeoutMs).toBe(30000)
        expect(state?.startedAt).toBeGreaterThan(0)
    })

    it('tool_start 无 timeoutMs（agent/ask_user）→ 注册 running 但不带 timeoutMs', () => {
        const toolCallId = 'call-agent-test-1'
        const convId = 'conv-1'

        handleToolStart(makeCtx(convId, {
            type: 'tool_start',
            toolCall: {id: toolCallId, name: 'agent', arguments: {agentType: 'explore'}},
        }))

        const state = useToolCallsStore.getState().states[toolCallId]
        expect(state?.status).toBe('running')
        expect(state?.timeoutMs).toBeUndefined()
    })
})

describe('tool_completed 即时完成信号（停止倒计时）', () => {
    it('tool_completed 到达 → setToolResult 置 success，runningToolCount 不递减', () => {
        const toolCallId = 'call-bash-completed-1'
        const convId = 'conv-1'

        handleToolUse(makeCtx(convId, {
            type: 'tool_use',
            toolCall: {id: toolCallId, name: 'bash', arguments: {command: 'sleep 10'}},
        }))
        handleToolStart(makeCtx(convId, {
            type: 'tool_start',
            toolCall: {id: toolCallId, name: 'bash', arguments: {command: 'sleep 10'}, timeoutMs: 30000},
        }))

        expect(mockConvData.convAgentStates[convId].runningToolCount).toBe(1)

        handleToolCompleted(makeCtx(convId, {
            type: 'tool_completed',
            toolCallId,
            result: {success: true, output: 'done'},
        }))

        const state = useToolCallsStore.getState().states[toolCallId]
        expect(state?.status).toBe('success')
        expect(state?.result?.output).toBe('done')
        // ★ 关键：不递减 runningToolCount（正式 tool_result 负责），避免并行场景计数错乱
        expect(mockConvData.convAgentStates[convId].runningToolCount).toBe(1)
    })

    it('tool_completed 错误结果 → status 置 error', () => {
        const toolCallId = 'call-bash-completed-2'
        const convId = 'conv-1'

        handleToolStart(makeCtx(convId, {
            type: 'tool_start',
            toolCall: {id: toolCallId, name: 'bash', arguments: {command: 'sleep 10'}, timeoutMs: 30000},
        }))

        handleToolCompleted(makeCtx(convId, {
            type: 'tool_completed',
            toolCallId,
            result: {success: false, output: null, error: 'boom'},
        }))

        const state = useToolCallsStore.getState().states[toolCallId]
        expect(state?.status).toBe('error')
        expect(state?.result?.error).toBe('boom')
    })
})
