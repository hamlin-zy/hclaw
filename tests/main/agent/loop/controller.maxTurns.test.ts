/**
 * Controller 达轮数上限截断回归测试
 *
 * 背景：模型循环跑满 maxTurns 后，此前 yield done(reason 'completed') 谎报完成，
 * 渲染端与渠道均无法感知任务被截断。现改为独立终态 done(reason 'max_turns_reached')，
 * 并携带 turns / maxTurns 供 UI 展示「已达 N 轮上限」。
 *
 * 覆盖：run() 在 loopResult==='max_turns' 时发出 done(reason 'max_turns_reached',
 *       turns, maxTurns)，且不再发出 reason 'completed' 的 done。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mocks = vi.hoisted(() => {
    return {
        llmQueue: [] as any[],
    }
})

vi.mock('../../../../src/main/agent/loop/execute', async (importOriginal) => {
    const {addMessage} = await import('../../../../src/main/agent/state')
    return {
        ...(await importOriginal<any>()),
        executeLlmCallWithRetry: async function* () {
            return mocks.llmQueue.shift()
        },
        executeToolCalls: async function* (args: any) {
            for (const tc of args.collectedToolCalls) {
                args.state = addMessage(args.state, {
                    role: 'tool', toolCallId: tc.id, toolResult: 'RESULT', content: 'RESULT',
                })
            }
            return {state: args.state, events: []}
        },
        extractMediaFromToolResults: (state: any) => state,
    }
})

vi.mock('../../../../src/main/agent/loop/setup', async () => {
    const {createLoopState} = await import('../../../../src/main/agent/state')
    return {
        initializeRunEnvironment: async function* (params: any) {
            return {
                state: createLoopState(params.messages),
                getSettings: () => params.settings,
                workingDir: params.workingDir,
            }
        },
        detectCommandContext: async () => ({commandContext: null}),
        defaultRoleForTrace: (traceContext?: string) => (traceContext === 'subAgent' ? 'lightweight' : 'primary'),
        selectModelForTurn: async function* () {
            return {
                modelConfig: {model: 'test-model', provider: 'test-provider'},
                schemeId: null, schemeName: null, suggestedRole: 'primary',
                providerName: 'test-provider', providerId: 'p1',
            }
        },
        filterToolsForDegrade: async () => [],
        filterTools: async () => [],
        buildSystemPrompt: async () => 'SYS',
        applyMcpCatalogChannel: (tools: any[]) => tools,
    }
})

vi.mock('../../../../src/main/agent/loop/catalogPublish', async () => {
    return {
        restoreCatalogState: () => ({incompleteStreak: 0}),
        runCatalogPreStep: (state: any) => ({state, catalogState: {incompleteStreak: 0}}),
    }
})

vi.mock('../../../../src/main/agent/permissions/permissionRule', () => ({
    permissionRulesManager: {
        getContext: async () => ({mode: 'auto'}),
    },
}))

import {AgentLoopController} from '../../../../src/main/agent/loop/controller'
import {LLMCaller} from '../../../../src/main/agent/loop/llmCaller'
import {ToolExecutor} from '../../../../src/main/agent/loop/toolExecutor'
import type {AgentStreamEvent} from '../../../../src/main/agent/stream'

const TOOL_CALL = {id: 't1', name: 'read_file', arguments: {path: 'x'}}

function tcResult() {
    return {
        assistantContent: '', assistantThinking: '', assistantThinkingSignature: '',
        assistantReasoningContent: '', collectedToolCalls: [TOOL_CALL], plannedCommands: undefined,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        llmDuration: 0, adapter: null,
        currentProvider: 'test-provider', currentModel: 'test-model',
        currentConfigSource: '', currentSchemeName: null, providerName: 'test-provider', providerId: 'p1',
    }
}

function makeParams(maxTurns: number) {
    return {
        messages: [{role: 'user' as const, content: 'go'}],
        modelConfig: {model: 'test-model', provider: 'test-provider'} as any,
        workingDir: 'E:\\tmp',
        // loopDetection off：本用例只关心达轮数上限路径
        settings: {agent: {maxTurns, loopDetection: {mode: 'off', threshold: 3}}} as any,
    } as any
}

async function runAndCollect(params: any) {
    const controller = new AgentLoopController(new LLMCaller() as any, new ToolExecutor() as any)
    const events: AgentStreamEvent[] = []
    for await (const e of controller.run(params)) events.push(e as AgentStreamEvent)
    return events
}

beforeEach(() => {
    mocks.llmQueue = []
})

describe('controller 达轮数上限 → 独立终态', () => {
    it('跑满 maxTurns → done reason= max_turns_reached，携带 turns/maxTurns，且不再谎报 completed', async () => {
        mocks.llmQueue = [tcResult(), tcResult()]
        const events = await runAndCollect(makeParams(2))

        const dones = events.filter((e: any) => e.type === 'done') as any[]
        expect(dones.length).toBe(1)
        expect(dones[0].reason).toBe('max_turns_reached')
        expect(dones[0].turns).toBe(2)
        expect(dones[0].maxTurns).toBe(2)
        // 不再谎报完成
        expect(events.some((e: any) => e.type === 'done' && e.reason === 'completed')).toBe(false)
    })
})
