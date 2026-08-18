/**
 * handleAgentStart — providerName 优先回退 provider 单元测试
 *
 * 覆盖需求：InputArea 下方提示信息改为「{服务商名称}/{模型名称}运行中」
 * handleAgentStart 是 agent_start 事件在渲染端的入口：
 * - 新事件携带 providerName（providers.name 人类可读名）→ 优先存入 currentModelProvider
 * - 旧事件只有 provider（api 类型）→ 回退使用 event.provider
 *
 * Mock 策略（参考 streamSubAgents.llmCallDone.test.ts）：
 * - conversationStore 用 vi.hoisted + vi.mock 替换为内存 stub
 * - handleAgentStart 调用 set(updater)（zustand updater 模式），mock 的 set 直接
 *   执行 updater 并记录返回的 patch，断言 patch 而非函数参数
 * - streamCore 顶层还 import 了 textBatch/thinkingBatch，但 handleAgentStart 不调用它们，
 *   仅 import 链存在即可
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── 依赖 mock：conversationStore 用 hoisted 状态（工厂被提升，必须 hoisted 引用） ──
const {mockPrevState, mockUpdateConvData} = vi.hoisted(() => ({
    mockPrevState: {
        agentState: {status: 'idle', mode: 'auto', phase: 'idle'},
        convAgentStates: {},
    },
    mockUpdateConvData: vi.fn(),
}))

vi.mock('@/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({activeConversationId: 'conv-1'}),
    },
    recordTextBlock: vi.fn(),
}))

import {handleAgentStart} from '@/renderer/stores/agentStore/handlers/streamCore'

// set 模拟 zustand updater 模式：执行 updater(prev) 记录返回的 patch
const mockSet = vi.fn((updater: (prev: unknown) => unknown) => updater(mockPrevState))

function makeCtx(event: unknown) {
    return {
        set: mockSet,
        get: () => ({
            convAgentStates: {
                'conv-1': {agentState: {status: 'idle', mode: 'auto', phase: 'idle'}},
            },
            updateConvData: mockUpdateConvData,
        }),
        convId: 'conv-1',
        isAgentAborted: false,
        isActiveConv: true,
        event,
    }
}

/** 取最近一次 set(updater) 返回的 patch */
function lastPatch(): any {
    const calls = mockSet.mock.calls
    const updater = calls[calls.length - 1][0] as (prev: unknown) => unknown
    return updater(mockPrevState)
}

describe('handleAgentStart — providerName 优先回退 provider', () => {
    beforeEach(() => {
        mockSet.mockClear()
        mockUpdateConvData.mockClear()
    })

    it('携带 providerName 时优先使用服务商名称（人类可读）', () => {
        handleAgentStart(makeCtx({
            type: 'agent_start',
            model: 'deepseek-v3',
            provider: 'custom',
            providerName: 'OpenRouter',
            tools: [],
        }) as any)

        const patch = lastPatch()
        expect(patch.agentState.currentModelName).toBe('deepseek-v3')
        expect(patch.agentState.currentModelProvider).toBe('OpenRouter')
    })

    it('无 providerName 时回退到 event.provider（api 类型，兼容旧事件）', () => {
        handleAgentStart(makeCtx({
            type: 'agent_start',
            model: 'qwen3:8b',
            provider: 'ollama',
            tools: [],
        }) as any)

        const patch = lastPatch()
        expect(patch.agentState.currentModelName).toBe('qwen3:8b')
        expect(patch.agentState.currentModelProvider).toBe('ollama')
    })

    it('providerName 与 provider 均缺失时 currentModelProvider 为空，不抛错', () => {
        handleAgentStart(makeCtx({
            type: 'agent_start',
            model: 'some-model',
            tools: [],
        }) as any)

        const patch = lastPatch()
        expect(patch.agentState.currentModelProvider).toBeUndefined()
    })
})
