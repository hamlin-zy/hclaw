// @vitest-environment jsdom
/**
 * 重试状态消息清除链路测试
 *
 * 保护：LLM 重试成功后恢复输出时，状态栏的重试/倒计时残留必须被清除。
 * 这是回归测试——此前修复的死角：executingToolsMessage 变为对象分支后，
 * 纯文本/纯思考路径（无工具调用）不会触发 tool_start 清除，状态栏冻结
 * 显示"重试中，Xs 后重试..."与流式输出并存。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {handleText, handleThinking} from '../../../../src/renderer/stores/agentStore/handlers/streamCore'
import {handleToolUse} from '../../../../src/renderer/stores/agentStore/handlers/streamTools'

const mockConvData = vi.hoisted((): {
    convAgentStates: Record<string, any>
    updateConvData?: (convId: string, patch: any) => void
} => ({
    convAgentStates: {},
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => mockConvData,
    },
}))

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
            addMessageToConv: vi.fn(),
            updateMessageForConv: vi.fn(),
        }),
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
}))

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

function seedConv(executingToolsMessage: any) {
    mockConvData.convAgentStates = {
        'conv-1': {
            streamingMessageId: 'msg-1',
            agentState: {status: 'running', phase: 'streaming'},
            streamBuffer: '',
            streamBlocks: [],
            executingToolsMessage,
            runningToolCount: 0,
            isThinkingAfterTools: false,
        },
    }
}

describe('重试状态消息清除（LLM 恢复输出时）', () => {
    beforeEach(() => {
        mockConvData.convAgentStates = {}
    })

    it('倒计时对象在 handleText 后被清除（纯文本回复路径）', () => {
        seedConv({label: '重试中，3s 后重试...', urgent: true})
        handleText(makeCtx('conv-1', {type: 'text', content: '回答内容'}))
        expect(mockConvData.convAgentStates['conv-1'].executingToolsMessage).toBeNull()
    })

    it('重试 warning 对象在 handleThinking 后被清除（纯思考路径）', () => {
        seedConv({label: '重试 1/10：network_error', urgent: false})
        handleThinking(makeCtx('conv-1', {type: 'thinking', content: '思考内容'}))
        expect(mockConvData.convAgentStates['conv-1'].executingToolsMessage).toBeNull()
    })

    it('重试已取消对象在 handleText 后被清除', () => {
        seedConv({label: '重试已取消', urgent: true})
        handleText(makeCtx('conv-1', {type: 'text', content: '恢复输出'}))
        expect(mockConvData.convAgentStates['conv-1'].executingToolsMessage).toBeNull()
    })

    it('遗留字符串分支兼容：重试字符串在 handleText 后被清除', () => {
        seedConv('重试 1/10：network_error')
        handleText(makeCtx('conv-1', {type: 'text', content: '回答内容'}))
        expect(mockConvData.convAgentStates['conv-1'].executingToolsMessage).toBeNull()
    })

    it('非重试消息（普通工具执行提示）不被误清除', () => {
        seedConv('2 个工具 执行中...')
        handleText(makeCtx('conv-1', {type: 'text', content: '回答内容'}))
        expect(mockConvData.convAgentStates['conv-1'].executingToolsMessage).toBe('2 个工具 执行中...')
    })

    it('倒计时对象在 handleToolUse 后被清除（工具回复路径）', () => {
        seedConv({label: '重试中，1s 后重试...', urgent: true})
        handleToolUse(makeCtx('conv-1', {
            type: 'tool_use',
            toolCall: {id: 'call-1', name: 'bash', arguments: {command: 'ls'}},
        }))
        expect(mockConvData.convAgentStates['conv-1'].executingToolsMessage).toBeNull()
    })
})
