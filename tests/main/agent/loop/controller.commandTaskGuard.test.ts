/**
 * M2：commandContext 分支的 CT 注入幂等守卫（controller 级）
 *
 * 场景（T2）：重试链路只回传 message.content（不带 metadata）→ 正文仍以 /xxx 开头
 * → detectCommandContext 经正文解析命中 skill → 同一会话再次 run 时再追加一份
 * 内容相同的 CT（技能指导数 KB 级，token 双计）。
 *
 * 断言：
 * - M2-a 同一会话第二次 run、commandContext 相同 → 不再追加 CT（state 与落库均不变）
 * - M2-b commandContext 不同（模板不同）→ 正常追加
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mocks = vi.hoisted(() => ({
    llmQueue: [] as any[],
    commandContext: null as any,
    // 每次 LLM 调用前捕获的 state.messages 快照（CT 注入发生在 LLM 调用之前）
    llmStates: [] as any[][],
    // writeMessagesDelta 落库留痕
    writes: [] as any[],
    // system_settings 内存桩（隔离原生 sqlite：tools 发送记录）
    settings: {} as Record<string, string>,
}))

vi.mock('../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {
        get: (key: string) => mocks.settings[key] ?? null,
        set: (key: string, value: string) => {
            mocks.settings[key] = value
            return true
        },
        getJson: (key: string) => {
            const raw = mocks.settings[key]
            if (!raw) return null
            try {
                return JSON.parse(raw)
            } catch {
                return null
            }
        },
        setJson: (key: string, value: unknown) => {
            mocks.settings[key] = JSON.stringify(value)
            return true
        },
        delete: (key: string) => {
            delete mocks.settings[key]
            return true
        },
        getAll: () => ({...mocks.settings}),
    },
}))

vi.mock('../../../../src/main/agent/loop/execute', async (importOriginal) => {
    return {
        ...(await importOriginal<any>()),
        executeLlmCallWithRetry: async function* (ctx: any) {
            mocks.llmStates.push(ctx.state.messages.map((m: any) => ({...m})))
            return mocks.llmQueue.shift()
        },
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
        detectCommandContext: async () => ({commandContext: mocks.commandContext}),
        defaultRoleForTrace: () => 'primary',
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

vi.mock('../../../../src/main/agent/loop/catalogPublish', async () => ({
    restoreCatalogState: () => ({incompleteStreak: 0}),
    runCatalogPreStep: (state: any) => ({state, catalogState: {incompleteStreak: 0}}),
}))

vi.mock('../../../../src/main/agent/loop/envPublish', async () => ({
    restoreEnvState: () => ({}),
    runEnvPreStep: (state: any) => ({state, envState: {}}),
}))

vi.mock('../../../../src/main/agent/loop/memoryPublish', async () => ({
    restoreMemoryState: () => ({}),
    runMemoryPreStep: (state: any) => ({state, memoryState: {}}),
}))

vi.mock('../../../../src/main/agent/loop/languageGuardPublish', async () => ({
    restoreLanguageGuardState: () => ({}),
    runLanguageGuardPreStep: (state: any) => ({state, languageGuardState: {}}),
    isLanguageGuardIteration: () => false,
    resolveSubagentLanguageSection: () => null,
}))

vi.mock('../../../../src/main/agent/permissions/permissionRule', () => ({
    permissionRulesManager: {
        getContext: async () => ({mode: 'auto'}),
    },
}))

vi.mock('../../../../src/main/repositories', () => ({
    createConversationRepository: () => ({
        getSystemPrompt: () => null,
        setSystemPrompt: () => {},
        readMeta: () => ({}),
        writeMessagesDelta: (_sid: string, msg: any) => {
            mocks.writes.push({...msg})
        },
    }),
}))

import {AgentLoopController} from '../../../../src/main/agent/loop/controller'
import {LLMCaller} from '../../../../src/main/agent/loop/llmCaller'
import {ToolExecutor} from '../../../../src/main/agent/loop/toolExecutor'

/** 单轮纯文本收尾（无工具调用）驱动循环退出 */
function textResult() {
    return {
        assistantContent: 'done-text', assistantThinking: '', assistantThinkingSignature: '',
        assistantReasoningContent: '', collectedToolCalls: [], plannedCommands: undefined,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        llmDuration: 0, adapter: null, ttftMs: undefined, decodeMs: undefined, tokensPerSecond: undefined,
        currentProvider: 'test-provider', currentModel: 'test-model',
        currentConfigSource: '', currentSchemeName: null, providerName: 'test-provider', providerId: 'p1',
    }
}

const CT_TEMPLATE = '# 代理模式: my-skill\n\n你是 my-skill。请做 X。'
const CT_TEMPLATE_OTHER = '# 代理模式: other-skill\n\n你是 other-skill。请做 Y。'

function makeCommandContext(commandTemplate: string) {
    return {commandId: 'skill:my-skill', commandTemplate, commandArgs: 'go'} as any
}

function makeParams(opts: {sessionId: string; messages: any[]}) {
    return {
        sessionId: opts.sessionId,
        messages: opts.messages,
        modelConfig: {model: 'test-model', provider: 'test-provider'} as any,
        workingDir: 'E:\\tmp',
        settings: {agent: {loopDetection: {mode: 'off'}}} as any,
    } as any
}

/** 跑一次 run，返回本轮首次 LLM 调用前捕获的 state.messages */
async function runOnce(params: any): Promise<any[]> {
    const controller = new AgentLoopController(new LLMCaller() as any, new ToolExecutor() as any)
    for await (const _e of controller.run(params)) { /* drain */ }
    return mocks.llmStates[mocks.llmStates.length - 1]
}

const countCt = (messages: any[]) =>
    messages.filter(m => m?.metadata?.sourceKind === 'command-task').length

beforeEach(() => {
    mocks.llmQueue = []
    mocks.commandContext = null
    mocks.llmStates = []
    mocks.writes = []
    mocks.settings = {}
})

describe('controller commandContext 分支：CT 注入幂等守卫', () => {
    it('M2-a 同一会话第二次 run、commandContext 相同 → 不再追加 CT', async () => {
        mocks.commandContext = makeCommandContext(CT_TEMPLATE)

        // run 1：注入 1 条 CT
        mocks.llmQueue = [textResult()]
        const firstMessages = await runOnce(makeParams({
            sessionId: 'conv-guard',
            messages: [{role: 'user', content: '/my-skill go'}],
        }))
        expect(countCt(firstMessages)).toBe(1)

        // run 2：消息流已含 run 1 注入的 CT（模拟重试/续聊从 DB 重建），commandContext 仍解析出同一模板
        mocks.writes = []
        mocks.llmQueue = [textResult()]
        const secondMessages = await runOnce(makeParams({
            sessionId: 'conv-guard',
            messages: firstMessages,
        }))

        // 改前：会追加第二条（countCt = 2）→ 红灯
        expect(countCt(secondMessages)).toBe(1)
        // 落库同样不得再写入 CT
        expect(mocks.writes.filter(m => m?.metadata?.sourceKind === 'command-task').length).toBe(0)
    })

    it('M2-b commandContext 不同（模板不同）→ 正常追加', async () => {
        mocks.commandContext = makeCommandContext(CT_TEMPLATE)
        mocks.llmQueue = [textResult()]
        const firstMessages = await runOnce(makeParams({
            sessionId: 'conv-guard-2',
            messages: [{role: 'user', content: '/my-skill go'}],
        }))
        expect(countCt(firstMessages)).toBe(1)

        mocks.commandContext = makeCommandContext(CT_TEMPLATE_OTHER)
        mocks.llmQueue = [textResult()]
        const secondMessages = await runOnce(makeParams({
            sessionId: 'conv-guard-2',
            messages: firstMessages,
        }))
        expect(countCt(secondMessages)).toBe(2)
    })
})
