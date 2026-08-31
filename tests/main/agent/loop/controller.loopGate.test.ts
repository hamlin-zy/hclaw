/**
 * Task 4：Controller 循环检测门集成测试
 *
 * 通过 vi.mock 替换 controller 的依赖模块（setup/execute/catalogPublish/permissionRule），
 * 用脚本化的 LLM 结果队列驱动 AgentLoopController.run，验证：
 * 1. notify 档：loop_suspected 事件、循环继续
 * 2. pause 档：askUserQuestion '终止 loop' → done reason 'loop_detected'
 * 3. pause 档：'继续一轮' → 继续且再次触发时再次询问
 * 4. off 档：无事件、不询问
 * 5. threshold*2 → loop_escalated
 * 6. pause 档无 askUserQuestion → 降级 notify
 * 7. 子 Agent 运行（modelRole 显式指定）→ 不检测
 * 8. pendingSilences 队列含指纹 → 该模式静默
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {createHash} from 'crypto'

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
const FINGERPRINT = createHash('sha1').update('read_file|path="x"|RESULT').digest('hex')

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

function textResult() {
    return {...tcResult(), collectedToolCalls: [], assistantContent: 'done-text'}
}

function makeParams(opts: {
    mode: 'notify' | 'pause' | 'off'
    askUserQuestion?: (q: string, o?: string[]) => Promise<string>
    modelRole?: string
    pendingSilences?: string[]
}) {
    return {
        messages: [{role: 'user' as const, content: 'go'}],
        modelConfig: {model: 'test-model', provider: 'test-provider'} as any,
        workingDir: 'E:\\tmp',
        settings: {agent: {loopDetection: {mode: opts.mode, threshold: 3}}} as any,
        askUserQuestion: opts.askUserQuestion,
        modelRole: opts.modelRole,
        pendingSilences: opts.pendingSilences,
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

describe('controller 循环检测门', () => {
    it('场景1 notify 档：3 轮相同调用 → loop_suspected(consecutive, 3)，第 4 轮纯文本 → completed', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), textResult()]
        const events = await runAndCollect(makeParams({mode: 'notify'}))
        const suspected = events.find((e: any) => e.type === 'loop_suspected') as any
        expect(suspected).toBeTruthy()
        expect(suspected.kind).toBe('consecutive')
        expect(suspected.repeatCount).toBe(3)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done.reason).toBe('completed')
        // 4 次 LLM 调用（循环未被 notify 阻断）
        expect(mocks.llmQueue.length).toBe(0)
    })

    it('场景2 pause 档：回答 终止 loop → done reason loop_detected，无第 4 次 LLM 调用', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult()]
        const ask = vi.fn(async () => '终止 loop')
        const events = await runAndCollect(makeParams({mode: 'pause', askUserQuestion: ask}))
        expect(ask).toHaveBeenCalledTimes(1)
        const dones = events.filter((e: any) => e.type === 'done') as any[]
        expect(dones.length).toBe(1)
        expect(dones[0].reason).toBe('loop_detected')
        // 队列未被消费完 = 没有第 4 次调用
        expect(mocks.llmQueue.length).toBe(0)
    })

    it('场景3 pause 档：回答 继续一轮 → 循环继续，再次触发时再次询问', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), tcResult(), tcResult()]
        const ask = vi.fn(async (q: string) => q.includes('终止') ? '终止 loop' : '继续一轮')
        // 第 1 次问 → 继续一轮；第 2 次问（升级）→ 终止 loop
        ask.mockImplementationOnce(async () => '继续一轮')
        ask.mockImplementationOnce(async () => '终止 loop')
        const events = await runAndCollect(makeParams({mode: 'pause', askUserQuestion: ask}))
        expect(ask).toHaveBeenCalledTimes(2)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done.reason).toBe('loop_detected')
    })

    it('场景4 off 档：无 loop_suspected、askUserQuestion 不被调用', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), textResult()]
        const ask = vi.fn(async () => '终止 loop')
        const events = await runAndCollect(makeParams({mode: 'off', askUserQuestion: ask}))
        expect(events.some((e: any) => e.type === 'loop_suspected')).toBe(false)
        expect(ask).not.toHaveBeenCalled()
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done.reason).toBe('completed')
    })

    it('场景5：累计到 threshold*2 轮 → loop_escalated', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), tcResult(), tcResult(), tcResult(), textResult()]
        const events = await runAndCollect(makeParams({mode: 'notify'}))
        const types = events.filter((e: any) => e.type === 'loop_suspected' || e.type === 'loop_escalated').map((e: any) => e.type)
        expect(types).toEqual(['loop_suspected', 'loop_escalated'])
    })

    it('场景6 pause 档但未传 askUserQuestion → 降级 notify（发 loop_suspected、不阻塞）', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), textResult()]
        const events = await runAndCollect(makeParams({mode: 'pause'}))
        expect(events.some((e: any) => e.type === 'loop_suspected')).toBe(true)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done.reason).toBe('completed')
    })

    it('场景7 子 Agent 运行（显式 modelRole）→ 无任何检测行为', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), textResult()]
        const events = await runAndCollect(makeParams({mode: 'notify', modelRole: 'primary'}))
        expect(events.some((e: any) => e.type === 'loop_suspected' || e.type === 'loop_escalated')).toBe(false)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done.reason).toBe('completed')
    })

    it('场景8 pendingSilences 队列含指纹 → 该模式静默，不再报', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), tcResult(), textResult()]
        const events = await runAndCollect(makeParams({mode: 'notify', pendingSilences: [FINGERPRINT]}))
        expect(events.some((e: any) => e.type === 'loop_suspected' || e.type === 'loop_escalated')).toBe(false)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done.reason).toBe('completed')
    })
})
