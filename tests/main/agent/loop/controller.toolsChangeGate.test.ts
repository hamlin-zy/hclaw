/**
 * tools 变动门测试
 *
 * tools 数组位于编码请求中 messages 之前，会话中途变化会使前缀从 tools 段失配，
 * 已积累的 prompt 缓存全部作废。验证 Controller 在请求发出前的拦截行为：
 * 1. 首轮（无上一轮记录）不拦截
 * 2. 工具集变化 → 调用 confirmToolsChange，continue 则继续本轮
 * 3. cancel → done(tools_change_cancelled) 且不发起本轮 LLM 调用
 * 4. 工具集不变 → 不调用 confirmToolsChange
 * 5. 无回调（子 Agent / 渠道会话）→ 静默放行
 * 6. snooze_today → 视同继续放行
 * 7. 跨 run 持久化：新 Worker（新 controller）首轮即可与上一轮比较（记录落 system_settings）
 * 8. 顺序变化（集合不变）同样触发拦截
 * 9. 降级路径：基线取「上一轮实际发送」名单，而非本轮 available
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mocks = vi.hoisted(() => {
    return {
        llmQueue: [] as any[],
        filterToolsQueue: [] as Array<Array<{name: string}>>,
        // 覆盖「本轮实际发送」的名单；用于模拟 400 降级（发送 preCapability 集，≠ available）
        sentNamesQueue: [] as Array<string[] | undefined>,
        // system_settings 内存桩：跨 controller（模拟跨 Worker）持久化 tools 发送记录
        settings: {} as Record<string, string>,
        // 目录 pre-step 的实参留痕：验证 mcpToolDeclared 接线（call_mcp_tool 是否真的下发了）
        catalogCalls: [] as Array<{mcpToolDeclared?: boolean}>,
    }
})

// tools 变动记录持久化在 system_settings（见 toolsSentRecord.ts）。
// 用内存桩替代真实 sqlite，既可验证跨 run 读写，又不触碰原生 DB。
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
    const {addMessage} = await import('../../../../src/main/agent/state')
    const {recordLastSentToolNames} = await import('../../../../src/main/agent/loop/toolsSentRecord')
    return {
        ...(await importOriginal<any>()),
        executeLlmCallWithRetry: async function* (ctx: any) {
            // 模拟「实际发送」：默认记录 availableToolDefinitions；
            // sentNamesQueue 可覆盖为降级路径实际发送的 preCapability 集。
            // 真实 execute 的记录点见 execute.ts toolsToSend 处。
            if (ctx?.params?.sessionId) {
                const override = mocks.sentNamesQueue.shift()
                const names = override ?? (ctx.availableToolDefinitions ?? []).map((t: any) => t.name)
                recordLastSentToolNames(ctx.params.sessionId, names)
            }
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
        filterTools: async () => mocks.filterToolsQueue.shift() ?? [],
        buildSystemPrompt: async () => 'SYS',
        // MCP 注入通道：mock 为恒等（本用例不关心 MCP 过滤）
        applyMcpCatalogChannel: (tools: any[]) => tools,
    }
})

vi.mock('../../../../src/main/agent/loop/catalogPublish', async () => {
    return {
        restoreCatalogState: () => ({incompleteStreak: 0}),
        runCatalogPreStep: (state: any, _cs: any, _repo: any, _sid: any, _full: any, mcpToolDeclared?: boolean) => {
            mocks.catalogCalls.push({mcpToolDeclared})
            return {state, catalogState: {incompleteStreak: 0}}
        },
    }
})

vi.mock('../../../../src/main/agent/permissions/permissionRule', () => ({
    permissionRulesManager: {
        getContext: async () => ({mode: 'auto'}),
    },
}))

// sessionId 存在时 controller 会尝试从 DB 读系统提示词缓存；测试无需真实 DB
vi.mock('../../../../src/main/repositories', () => ({
    createConversationRepository: () => null,
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

/** 无工具调用的收尾轮，驱动循环退出 */
function textResult() {
    return {...tcResult(), collectedToolCalls: [], assistantContent: 'done-text'}
}

function makeParams(opts: {
    sessionId: string
    confirmToolsChange?: (info: any) => Promise<'continue' | 'cancel' | 'snooze_today'>
}) {
    return {
        sessionId: opts.sessionId,
        messages: [{role: 'user' as const, content: 'go'}],
        modelConfig: {model: 'test-model', provider: 'test-provider'} as any,
        workingDir: 'E:\\tmp',
        settings: {agent: {loopDetection: {mode: 'off'}}} as any,
        confirmToolsChange: opts.confirmToolsChange,
    } as any
}

async function runAndCollect(params: any) {
    const controller = new AgentLoopController(new LLMCaller() as any, new ToolExecutor() as any)
    const events: AgentStreamEvent[] = []
    for await (const e of controller.run(params)) events.push(e as AgentStreamEvent)
    return events
}

const tools = (...names: string[]) => names.map(name => ({name}))

beforeEach(() => {
    mocks.llmQueue = []
    mocks.filterToolsQueue = []
    mocks.sentNamesQueue = []
    mocks.settings = {}
    mocks.catalogCalls = []
})

describe('controller tools 变动门', () => {
    it('首轮无上一轮记录 → 不调用 confirmToolsChange', async () => {
        mocks.llmQueue = [tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file', 'write_file'), tools('read_file', 'write_file')]
        const confirm = vi.fn(async (_info: any) => 'continue' as const)
        const events = await runAndCollect(makeParams({sessionId: 'conv-first', confirmToolsChange: confirm}))

        expect(confirm).not.toHaveBeenCalled()
        // 正常进入 LLM 调用（队列被消费）
        expect(mocks.llmQueue.length).toBe(0)
        expect(events.some(e => (e as any).type === 'agent_start')).toBe(true)
    })

    it('工具集变化 + continue → 调用确认并继续本轮', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file'), tools('read_file', 'write_file'), tools('read_file', 'write_file')]
        const confirm = vi.fn(async (_info: any) => 'continue' as const)
        const events = await runAndCollect(makeParams({sessionId: 'conv-continue', confirmToolsChange: confirm}))

        expect(confirm).toHaveBeenCalledTimes(1)
        const info = confirm.mock.calls[0][0]
        expect(info.added).toEqual(['write_file'])
        expect(info.removed).toEqual([])
        // 第二轮照常发起 LLM 调用
        expect(mocks.llmQueue.length).toBe(0)
        expect(events.some(e => (e as any).type === 'done' && (e as any).reason === 'tools_change_cancelled')).toBe(false)
    })

    it('取消 → done(tools_change_cancelled)，本轮不发起 LLM 调用', async () => {
        mocks.llmQueue = [tcResult(), tcResult()]
        mocks.filterToolsQueue = [tools('read_file'), tools('read_file', 'write_file')]
        const confirm = vi.fn(async () => 'cancel' as const)
        const events = await runAndCollect(makeParams({sessionId: 'conv-cancel', confirmToolsChange: confirm}))

        expect(confirm).toHaveBeenCalledTimes(1)
        const dones = events.filter(e => (e as any).type === 'done') as any[]
        expect(dones.length).toBe(1)
        expect(dones[0].reason).toBe('tools_change_cancelled')
        // 第二轮未消费 LLM 队列 = 请求被阻断
        expect(mocks.llmQueue.length).toBe(1)
    })

    it('工具集不变 → 不调用 confirmToolsChange', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file'), tools('read_file'), tools('read_file')]
        const confirm = vi.fn(async () => 'cancel' as const)
        const events = await runAndCollect(makeParams({sessionId: 'conv-same', confirmToolsChange: confirm}))

        expect(confirm).not.toHaveBeenCalled()
        expect(mocks.llmQueue.length).toBe(0)
        expect(events.some(e => (e as any).reason === 'tools_change_cancelled')).toBe(false)
    })

    it('无回调（子 Agent / 渠道会话）→ 静默放行', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file'), tools('read_file', 'write_file'), tools('read_file', 'write_file')]
        const events = await runAndCollect(makeParams({sessionId: 'conv-nocb'}))

        expect(mocks.llmQueue.length).toBe(0)
        expect(events.some(e => (e as any).reason === 'tools_change_cancelled')).toBe(false)
    })

    it('snooze_today → 视同继续放行', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file'), tools('read_file', 'write_file'), tools('read_file', 'write_file')]
        const confirm = vi.fn(async () => 'snooze_today' as const)
        const events = await runAndCollect(makeParams({sessionId: 'conv-snooze', confirmToolsChange: confirm}))

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(mocks.llmQueue.length).toBe(0)
        expect(events.some(e => (e as any).reason === 'tools_change_cancelled')).toBe(false)
    })

    it('跨 run 持久化：新 Worker（新 controller）首轮即与上一轮实际发送比较', async () => {
        // run 1：两轮工具集不变，记录落 system_settings
        mocks.llmQueue = [tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file'), tools('read_file')]
        const confirm1 = vi.fn(async (_info: any) => 'continue' as const)
        await runAndCollect(makeParams({sessionId: 'conv-crossrun', confirmToolsChange: confirm1}))
        expect(confirm1).not.toHaveBeenCalled()

        // run 2：全新 controller（每次用户发消息 = 新 Worker 线程），tools 变化 → 必须拦截
        mocks.llmQueue = [tcResult(), textResult()]
        mocks.filterToolsQueue = [tools('read_file', 'write_file'), tools('read_file', 'write_file')]
        const confirm2 = vi.fn(async (_info: any) => 'continue' as const)
        await runAndCollect(makeParams({sessionId: 'conv-crossrun', confirmToolsChange: confirm2}))

        expect(confirm2).toHaveBeenCalledTimes(1)
        const info = confirm2.mock.calls[0][0]
        expect(info.previous).toEqual(['read_file'])
        expect(info.added).toEqual(['write_file'])
        expect(info.removed).toEqual([])
        expect(mocks.llmQueue.length).toBe(0)
    })

    it('顺序变化同样触发拦截（顺序敏感比较，集合不变）', async () => {
        mocks.llmQueue = [tcResult(), tcResult(), textResult()]
        mocks.filterToolsQueue = [
            tools('read_file', 'write_file'),
            tools('write_file', 'read_file'),
            tools('write_file', 'read_file'),
        ]
        const confirm = vi.fn(async (_info: any) => 'continue' as const)
        await runAndCollect(makeParams({sessionId: 'conv-order', confirmToolsChange: confirm}))

        expect(confirm).toHaveBeenCalledTimes(1)
        const info = confirm.mock.calls[0][0]
        expect(info.added).toEqual([])
        expect(info.removed).toEqual([])
        expect(info.previous).toEqual(['read_file', 'write_file'])
        expect(info.current).toEqual(['write_file', 'read_file'])
        expect(mocks.llmQueue.length).toBe(0)
    })

    it('降级路径基线：以上一轮「实际发送」名单为准，而非本轮 available', async () => {
        // run 1（单轮即结束）：available=['read_file']，但实际因 400 降级发送了含 analyze_image 的完整集
        mocks.llmQueue = [textResult()]
        mocks.filterToolsQueue = [tools('read_file')]
        mocks.sentNamesQueue = [['read_file', 'analyze_image']]
        const confirm1 = vi.fn(async (_info: any) => 'continue' as const)
        await runAndCollect(makeParams({sessionId: 'conv-degrade', confirmToolsChange: confirm1}))
        expect(confirm1).not.toHaveBeenCalled()

        // run 2：available 仍为 ['read_file']（未变），但上一轮实际发送含 analyze_image
        // → 若基线错误地取 available，则不会拦截；正确基线（实际发送）应触发拦截。
        mocks.llmQueue = [textResult()]
        mocks.filterToolsQueue = [tools('read_file')]
        const confirm2 = vi.fn(async (_info: any) => 'continue' as const)
        await runAndCollect(makeParams({sessionId: 'conv-degrade', confirmToolsChange: confirm2}))

        expect(confirm2).toHaveBeenCalledTimes(1)
        const info = confirm2.mock.calls[0][0]
        expect(info.previous).toEqual(['read_file', 'analyze_image'])
        expect(info.removed).toEqual(['analyze_image'])
    })

    it('MCP 目录门控接线：mcpToolDeclared 取自本轮实际下发的 tools', async () => {
        // 含 call_mcp_tool → 目录可发布
        mocks.llmQueue = [textResult()]
        mocks.filterToolsQueue = [tools('read_file', 'call_mcp_tool')]
        await runAndCollect(makeParams({sessionId: 'conv-mcp-on'}))
        expect(mocks.catalogCalls[mocks.catalogCalls.length - 1]?.mcpToolDeclared).toBe(true)

        // 不含（如受限子 Agent）→ 不发布 MCP 目录
        mocks.llmQueue = [textResult()]
        mocks.filterToolsQueue = [tools('read_file')]
        await runAndCollect(makeParams({sessionId: 'conv-mcp-off'}))
        expect(mocks.catalogCalls[mocks.catalogCalls.length - 1]?.mcpToolDeclared).toBe(false)
    })
})
