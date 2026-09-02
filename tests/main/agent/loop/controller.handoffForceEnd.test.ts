/**
 * Controller 交接门强制结束轮次回归测试（bug：静默中断）
 *
 * 背景（2026-09 bug 排查）：
 * - Bug A：mid-loop 交接门注入（handoffRequested=true）后，controller.ts 无论模型
 *   是否真的调用 session_handoff，都 yield done('completed') 并退出。弱模型经常
 *   只回复总结文本不调工具 → UI 假报"已完成"，任务未移交 = 静默中断。
 *   期望：未调用 session_handoff 时必须 yield error（提示交接未完成），
 *   done reason 为 'error' 而非 'completed'。
 * - Bug B：graceful-stop 模式下 executeLlmCallWithRetry yield error 后返回 null
 *   → controller 直接 return early_exit，不发 done 事件 → 渲染端永久卡"响应中"。
 *   期望：error 后必须有 done 事件（reason 'error'）。
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
            const result = mocks.llmQueue.shift()
            // 模拟 graceful-stop 路径：先 yield error，再返回 null
            if (result === 'ERROR_THEN_NULL') {
                yield {type: 'error', error: '上下文已接近窗口上限（约 90%），本轮已停止。'}
                return null
            }
            return result
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

const HANDOFF_TOOL_CALL = {id: 'h1', name: 'session_handoff', arguments: {handoffSummary: 's', newConversationTitle: 't'}}

function tcResult(toolCalls: any[] = [{id: 't1', name: 'read_file', arguments: {path: 'x'}}]) {
    return {
        assistantContent: '', assistantThinking: '', assistantThinkingSignature: '',
        assistantReasoningContent: '', collectedToolCalls: toolCalls, plannedCommands: undefined,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        llmDuration: 0, adapter: null,
        currentProvider: 'test-provider', currentModel: 'test-model',
        currentConfigSource: '', currentSchemeName: null, providerName: 'test-provider', providerId: 'p1',
    }
}

function makeParams() {
    return {
        messages: [{role: 'user' as const, content: 'go'}],
        modelConfig: {model: 'test-model', provider: 'test-provider'} as any,
        workingDir: 'E:\\tmp',
        settings: {agent: {loopDetection: {mode: 'notify', threshold: 3}}} as any,
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

describe('controller 交接门强制结束轮次', () => {
    it('Bug A：handoffRequested=true 但模型未调用 session_handoff → 必须 yield error 且 done reason 非 completed', async () => {
        // 模拟弱模型：收到交接指令后只调了普通工具（未调 session_handoff）
        mocks.llmQueue = [{...tcResult(), handoffRequested: true}]
        const events = await runAndCollect(makeParams())

        const error = events.find((e: any) => e.type === 'error') as any
        expect(error, '未调用 session_handoff 却没有 error 提示（假报完成 = 静默中断）').toBeTruthy()
        expect(error.error).toContain('交接')

        const done = events.find((e: any) => e.type === 'done') as any
        expect(done).toBeTruthy()
        expect(done.reason).not.toBe('completed')
    })

    it('Bug A 对照：handoffRequested=true 且模型调用了 session_handoff → done completed（正常交接）', async () => {
        mocks.llmQueue = [{...tcResult([HANDOFF_TOOL_CALL]), handoffRequested: true}]
        const events = await runAndCollect(makeParams())

        const done = events.find((e: any) => e.type === 'done') as any
        expect(done).toBeTruthy()
        expect(done.reason).toBe('completed')
        expect(events.some((e: any) => e.type === 'error')).toBe(false)
    })

    it('Bug A 对照：模型主动调用 session_handoff（无 handoffRequested）→ done completed', async () => {
        mocks.llmQueue = [tcResult([HANDOFF_TOOL_CALL])]
        const events = await runAndCollect(makeParams())

        const done = events.find((e: any) => e.type === 'done') as any
        expect(done).toBeTruthy()
        expect(done.reason).toBe('completed')
        expect(events.some((e: any) => e.type === 'error')).toBe(false)
    })

    it('Bug B：graceful-stop（error 后返回 null）→ 必须有 done 事件，渲染端不能卡"响应中"', async () => {
        mocks.llmQueue = ['ERROR_THEN_NULL']
        const events = await runAndCollect(makeParams())

        expect(events.some((e: any) => e.type === 'error')).toBe(true)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done, 'error 后无 done 事件 → 渲染端永久停留在响应中').toBeTruthy()
        expect(done.reason).toBe('error')
    })
})
