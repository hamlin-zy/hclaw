import {describe, expect, it, vi, beforeEach} from 'vitest'

// ── 后台主会话子 agent 事件流回归：convAgentStates 缺失 / streamingMessageId 缺失时，
//    subagent_start 不应被整批丢弃，而应按 running agent 工具定位父工具并补写 taskId ──

const {mockState, mockUpdate, mockRegister, mockAppendLog, mockUpdateToolCall, mockClearToolCall, mockContentBlocks} = vi.hoisted(() => ({
    mockState: {
        messagesMap: {
            'conv-bg': [
                {
                    id: 'msg-1',
                    role: 'assistant',
                    toolCalls: [] as Array<Record<string, any>>,
                },
            ],
        },
    },
    mockUpdate: vi.fn(),
    mockRegister: vi.fn(),
    mockAppendLog: vi.fn(),
    mockUpdateToolCall: vi.fn(),
    mockClearToolCall: vi.fn(),
    mockContentBlocks: vi.fn(),
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({messagesMap: mockState.messagesMap, updateMessageForConv: mockUpdate}),
    },
}))

vi.mock('@/renderer/stores/toolCallsStore', () => ({
    useToolCallsStore: {
        getState: () => ({
            registerToolCall: mockRegister,
            appendProgressLog: mockAppendLog,
            updateToolCall: mockUpdateToolCall,
            clearToolCall: mockClearToolCall,
            states: {},
        }),
    },
}))

vi.mock('@/renderer/stores/agentStore/contentBlocks', () => ({
    updateMessageContentBlocks: mockContentBlocks,
}))

import {handleAgentProgress, handleSubagentDone, handleSubagentProgress, handleSubagentStart} from '@/renderer/stores/agentStore/handlers/streamSubAgents'
import type {StreamCtx} from '@/renderer/stores/agentStore/handlers/streamContext'

const makeCtx = (convAgentStates: Record<string, unknown>): StreamCtx => ({
    set: vi.fn(),
    // 仅 mock handlers 实际读取的 convAgentStates（其余 AgentStore 字段本用例不触及）
    get: (() => ({convAgentStates})) as unknown as StreamCtx['get'],
    convId: 'conv-bg',
    isActiveConv: false,
    isAgentAborted: false,
    event: {
        taskId: 'conv-child-1',
        description: '子任务描述',
        toolCallId: 'tc-agent',
    },
})

describe('handleSubagentDone — 父/子工具 taskId 共存时只置终态子工具', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockClearToolCall.mockClear()
        mockAppendLog.mockClear()
        // 父工具经 ensureAgentToolTaskId 补写后 taskId === event.taskId，
        // 且在 toolCalls 数组中排在子 toolCall（sub-<taskId>）之前
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'running', taskId: 'conv-child-1'},
            {id: 'sub-conv-child-1', name: 'agent', arguments: {task: '子任务'}, status: 'running', taskId: 'conv-child-1'},
        ]
    })

    it('优先精确匹配 sub-<taskId>：只将子工具置终态，父工具不被误置/误清', () => {
        const ctx = {
            ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
            event: {taskId: 'conv-child-1', success: true},
        } as unknown as StreamCtx
        handleSubagentDone(ctx)
        const doneCall = mockUpdate.mock.calls.find(([, , u]: any[]) =>
            u.toolCalls?.some((tc: any) => tc.id === 'sub-conv-child-1'))
        expect(doneCall).toBeTruthy()
        const parentTc = doneCall![2].toolCalls.find((tc: any) => tc.id === 'tc-agent')
        const subTc = doneCall![2].toolCalls.find((tc: any) => tc.id === 'sub-conv-child-1')
        expect(parentTc.status).toBe('running')
        expect(subTc.status).toBe('success')
        // 只清理子工具的运行时状态，父工具不被误清
        expect(mockClearToolCall).toHaveBeenCalledTimes(1)
        expect(mockClearToolCall).toHaveBeenCalledWith('sub-conv-child-1')
    })
})

describe('handleSubagentStart — 后台会话事件不再整批丢弃', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockRegister.mockClear()
        mockAppendLog.mockClear()
        mockContentBlocks.mockClear()
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'running'},
        ]
    })

    it('convAgentStates 缺失（调度器/cron 发起）：仍定位父工具并补写 taskId、注册子 toolCall', () => {
        handleSubagentStart(makeCtx({}))
        expect(mockUpdate).toHaveBeenCalled()
        // 父工具 taskId 补写（经 ensureAgentToolTaskId）
        const parentCall = mockUpdate.mock.calls.find(([, , u]: any[]) => u.toolCalls?.length === 1)
        expect(parentCall).toBeTruthy()
        // 子 toolCall 注册进消息
        const subCall = mockUpdate.mock.calls.find(([, , u]: any[]) =>
            u.toolCalls?.some((tc: any) => tc.id === 'sub-conv-child-1'))
        expect(subCall).toBeTruthy()
        expect(mockContentBlocks).toHaveBeenCalledWith('conv-bg')
    })

    it('convAgentStates 存在但归 idle 且无 streamingMessageId：running agent 工具仍是运行迹象', () => {
        handleSubagentStart(makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}))
        expect(mockUpdate).toHaveBeenCalled()
    })

    it('父工具已 success（迟到/重复事件）：仅补写 taskId，不注册新 running 子 toolCall', () => {
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'success'},
        ]
        handleSubagentStart(makeCtx({}))
        // taskId 补写仍发生（ensureAgentToolTaskId 对已完成工具保留）
        const parentCall = mockUpdate.mock.calls.find(([, , u]: any[]) => u.toolCalls?.length === 1)
        expect(parentCall).toBeTruthy()
        expect(parentCall![2].toolCalls[0].taskId).toBe('conv-child-1')
        // 不注册新的 running 子 toolCall
        const subCall = mockUpdate.mock.calls.find(([, , u]: any[]) =>
            u.toolCalls?.some((tc: any) => tc.id === 'sub-conv-child-1'))
        expect(subCall).toBeFalsy()
        expect(mockRegister).not.toHaveBeenCalled()
    })

    it('无 toolCallId 且确无 running agent 工具时才丢弃事件', () => {
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'success'},
        ]
        handleSubagentStart({...makeCtx({}), event: {taskId: 'conv-child-1', description: '子任务'}})
        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockRegister).not.toHaveBeenCalled()
    })
})

describe('handleSubagentDone — 后台会话回退定位（与 start 对称）', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockClearToolCall.mockClear()
        mockAppendLog.mockClear()
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'running', taskId: 'conv-child-1'},
        ]
    })

    it('无 streamingMessageId 且归 idle：仅有父工具带 taskId（无子 toolCall）时不得误置父工具终态', () => {
        const ctx = {
            ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
            event: {taskId: 'conv-child-1', success: true},
        } as unknown as StreamCtx
        handleSubagentDone(ctx)
        // 缺陷 1 修复：模糊兜底不得命中父工具（父工具经补写后 taskId 相同且排前）
        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockClearToolCall).not.toHaveBeenCalled()
        expect(mockState.messagesMap['conv-bg'][0].toolCalls[0].status).toBe('running')
    })

    it('taskId 无匹配工具时不做任何写入', () => {
        const ctx = {
            ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
            event: {taskId: 'conv-other', success: true},
        } as unknown as StreamCtx
        handleSubagentDone(ctx)
        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockClearToolCall).not.toHaveBeenCalled()
    })
})

describe('handleSubagentProgress — 迟到 progress 不复燃已完成子工具', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockClearToolCall.mockClear()
        mockAppendLog.mockClear()
        mockUpdateToolCall.mockClear()
    })

    it('done 清理后（消息内子工具已 success）迟到 progress：不调用 appendProgressLog，消息终态不变', () => {
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'running', taskId: 'conv-child-1'},
            {id: 'sub-conv-child-1', name: 'agent', arguments: {task: '子任务'}, status: 'success', taskId: 'conv-child-1'},
        ]
        const ctx = {
            ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
            event: {taskId: 'conv-child-1', progress: '子 Agent 进度: 50%', toolCallId: 'tc-agent'},
        } as unknown as StreamCtx
        handleSubagentProgress(ctx)
        // 不对子工具 key 追加（真实 store 中 appendProgressLog 对不存在 key 会自动创建 running）
        expect(mockAppendLog).not.toHaveBeenCalledWith('sub-conv-child-1', expect.anything())
        // 消息不被改写（子工具终态保持 success，不会被复燃为 running）
        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockState.messagesMap['conv-bg'][0].toolCalls[1].status).toBe('success')
    })

    it('正常流（子工具 running）：守卫放行，progress 照常追加到子与父工具', () => {
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-agent', name: 'agent', arguments: {}, status: 'running', taskId: 'conv-child-1'},
            {id: 'sub-conv-child-1', name: 'agent', arguments: {task: '子任务'}, status: 'running', taskId: 'conv-child-1', taskDescription: '子任务'},
        ]
        const ctx = {
            ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
            event: {taskId: 'conv-child-1', progress: '子 Agent 进度: 30%', toolCallId: 'tc-agent'},
        } as unknown as StreamCtx
        handleSubagentProgress(ctx)
        expect(mockAppendLog).toHaveBeenCalledWith('sub-conv-child-1', '子 Agent 进度: 30%')
        expect(mockAppendLog).toHaveBeenCalledWith('tc-agent', expect.stringContaining('进度: 30%'))
    })
})

describe('handleSubagentStart — 无 toolCallId 且多个 running 无 taskId 工具时跳过补写', () => {
    it('并发多 agent：taskId 无法区分，不冒错配风险', () => {
        mockUpdate.mockClear()
        mockRegister.mockClear()
        mockAppendLog.mockClear()
        mockState.messagesMap['conv-bg'][0].toolCalls = [
            {id: 'tc-a', name: 'agent', arguments: {}, status: 'running'},
            {id: 'tc-b', name: 'agent', arguments: {}, status: 'running'},
        ]
        handleSubagentStart({...makeCtx({}), event: {taskId: 'conv-child-1', description: '子任务'}})
        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockRegister).not.toHaveBeenCalled()
    })
})

// ── 缺陷 1 回归：done 无子 toolCall 时不得误置父工具终态 ──
describe('缺陷1 — done 不得误置父工具终态', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockClearToolCall.mockClear()
        mockAppendLog.mockClear()
        mockRegister.mockClear()
        mockContentBlocks.mockClear()
        // 单消息两个 running 父 agent 工具（无 taskId，也无子 toolCall）
        mockState.messagesMap['conv-bg'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [
                {id: 'tc-a', name: 'agent', arguments: {}, status: 'running'},
                {id: 'tc-b', name: 'agent', arguments: {}, status: 'running'},
            ]},
        ]
    })

    it('① start 无 toolCallId：多候选时不写入', () => {
        handleSubagentStart({...makeCtx({}), event: {taskId: 'X', description: '子任务'}})
        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockRegister).not.toHaveBeenCalled()
    })

    it('② progress 无 toolCallId：多候选时不补写 taskId', () => {
        handleSubagentProgress({
            ...makeCtx({}),
            event: {taskId: 'X', progress: '子 Agent 进度: 10%'},
        } as unknown as StreamCtx)
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('③ done：父工具仍 running，不以父工具 id 调用 clearToolCall', () => {
        const ctx = {
            ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
            event: {taskId: 'X', success: true},
        } as unknown as StreamCtx
        handleSubagentDone(ctx)
        const toolCalls = mockState.messagesMap['conv-bg'][0].toolCalls
        expect(toolCalls[0].status).toBe('running')
        expect(toolCalls[1].status).toBe('running')
        expect(mockClearToolCall).not.toHaveBeenCalledWith('tc-a')
        expect(mockClearToolCall).not.toHaveBeenCalledWith('tc-b')
    })
})

// ── 缺陷 2 回归：handleAgentProgress 按 toolCallId 锚定消息 ──
describe('缺陷2 — handleAgentProgress 按 toolCallId 锚定消息', () => {
    beforeEach(() => {
        mockUpdate.mockClear()
        mockUpdateToolCall.mockClear()
        mockState.messagesMap['conv-bg'] = [
            {id: 'msg-1', role: 'assistant', toolCalls: [
                {id: 'tc-old', name: 'agent', arguments: {}, status: 'running'},
            ]},
            {id: 'msg-2', role: 'assistant', toolCalls: [
                {id: 'tc-live', name: 'agent', arguments: {}, status: 'running'},
            ]},
        ]
    })

    const progressCtx = (toolCallId: string) => ({
        ...makeCtx({'conv-bg': {streamingMessageId: null, agentState: {status: 'idle'}}}),
        event: {toolCallId, inputTokens: 100, outputTokens: 20, totalTokens: 120},
    } as unknown as StreamCtx)

    it('多 running 消息时 tokenUsage 落到 toolCallId 对应的工具', () => {
        handleAgentProgress(progressCtx('tc-live'))
        expect(mockUpdateToolCall).toHaveBeenCalledWith('tc-live', expect.objectContaining({
            tokenUsage: expect.objectContaining({inputTokens: 100}),
        }))
    })

    it('对照组：tc-old 正常收到 tokenUsage', () => {
        handleAgentProgress(progressCtx('tc-old'))
        expect(mockUpdateToolCall).toHaveBeenCalledWith('tc-old', expect.objectContaining({
            tokenUsage: expect.objectContaining({inputTokens: 100}),
        }))
    })
})
