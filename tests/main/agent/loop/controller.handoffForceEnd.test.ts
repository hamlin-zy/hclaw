/**
 * Controller session_handoff 强制结束轮次回归测试
 *
 * 设计意图（2026-09 修复）：
 * - 模型主动调用 session_handoff 后必须强制结束本轮：新会话已创建、任务已移交，
 *   主会话不应再带着交接结果进入下一轮 LLM 调用（上下文已接近上限，继续轮询会爆窗）。
 * - 不再因 handoffRequested 强制结束：模型可能在收到交接指令后先调用本地工具
 *   确认信息（读文件、生成总结等）再调用 session_handoff，防重复注入由
 *   execute.ts 的 handoffInjectedBySession 会话级去重机制保证。
 *
 * 历史 bug 记录：
 * - Bug A（已修复，行为已变）：旧实现里 handoffRequested=true 但模型未调 session_handoff
 *   会 yield error 中断任务。新行为是允许继续（模型可先调工具再生成总结）。
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
        // MCP 注入通道：mock 为恒等（本用例不关心 MCP 过滤）
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

describe('controller session_handoff 强制结束轮次', () => {
    it('模型主动调用 session_handoff → done completed，任务正常交接', async () => {
        mocks.llmQueue = [tcResult([HANDOFF_TOOL_CALL])]
        const events = await runAndCollect(makeParams())

        const done = events.find((e: any) => e.type === 'done') as any
        expect(done).toBeTruthy()
        expect(done.reason).toBe('completed')
        expect(events.some((e: any) => e.type === 'error')).toBe(false)
    })

    it('模型主动调用 session_handoff（handoffRequested=true 亦不影响）→ done completed', async () => {
        // 交接门注入 + 模型成功调用 → 正常交接
        mocks.llmQueue = [{...tcResult([HANDOFF_TOOL_CALL]), handoffRequested: true}]
        const events = await runAndCollect(makeParams())

        const done = events.find((e: any) => e.type === 'done') as any
        expect(done).toBeTruthy()
        expect(done.reason).toBe('completed')
        expect(events.some((e: any) => e.type === 'error')).toBe(false)
    })

    it('handoffRequested=true 但模型未调用 session_handoff → 不报错，允许进入下一轮（模型可先调工具确认信息再交接）', async () => {
        // 新行为：不再因"收到交接指令但未调用 session_handoff"就报错中断。
        // 模型可能在收到 prompt 后先调用本地工具（读文件、生成总结等）
        // 再生成结构化交接总结并调用 session_handoff，本用例覆盖该合理场景。
        // 第 2 轮返回无工具调用 → 自然退出（handleNoToolCalls → early_exit）。
        mocks.llmQueue = [
            {...tcResult(), handoffRequested: true},  // 第 1 轮：注入了交接指令，但只调了普通工具
            tcResult([]),                              // 第 2 轮：模型无工具调用，任务自然结束
        ]
        const events = await runAndCollect(makeParams())

        // 关键 1：不出现"交接未完成"错误
        expect(
            events.some((e: any) => e.type === 'error' && String(e.error).includes('交接未完成')),
            '不应因未调用 session_handoff 就报错中断',
        ).toBe(false)

        // 关键 2：真的进入了第 2 轮（mock 队列第 2 项被消费）
        expect(mocks.llmQueue.length).toBe(0)
    })

    it('graceful-stop（error 后返回 null）→ 必须有 done 事件，渲染端不能卡"响应中"', async () => {
        mocks.llmQueue = ['ERROR_THEN_NULL']
        const events = await runAndCollect(makeParams())

        expect(events.some((e: any) => e.type === 'error')).toBe(true)
        const done = events.find((e: any) => e.type === 'done') as any
        expect(done, 'error 后无 done 事件 → 渲染端永久停留在响应中').toBeTruthy()
        expect(done.reason).toBe('error')
    })
})
