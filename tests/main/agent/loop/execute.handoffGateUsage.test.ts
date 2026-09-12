import {describe, expect, it, vi, afterEach} from 'vitest'
import {executeLlmCallWithRetry, MID_LOOP_HANDOFF_PROMPT, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'

/**
 * mid-loop 交接门分子修复回归测试：
 * gate 分子必须优先使用上一轮 LLM 请求的真实 usage（inputTokens + cacheReadTokens）。
 * B1 重构后 loop 内存态 assistant 消息不再携带 llmStats，
 * 原 resolveContextUsageTokens 恒回退 chars/4 估算 → 中文低估约 4 倍 → gate 永不触发。
 *
 * 另一回归面：子会话（traceContext='subAgent'）必须完全不参与交接门——
 * 注入会诱导 session_handoff，agentTool 随即拿到"已完成"的空/半成品结果。
 */
describe('executeLlmCallWithRetry mid-loop 交接门（真实 usage 优先）', () => {
  afterEach(() => vi.restoreAllMocks())

  /** 唯一 sessionId，避免用例间共享模块级 usage 记录 */
  let seq = 0

  function buildCtx(
    chat: ReturnType<typeof vi.fn>,
    sessionId: string,
    history: ChatMessage[],
    opts: { traceContext?: 'subAgent'; overflowMode?: 'auto-handoff' | 'graceful-stop' } = {},
  ): ExecuteLlmCallParams {
    const adapter = {
      chat,
      getModelInfo: () => ({}),
      invalidateConvertCache: vi.fn(),
    } as unknown as ModelAdapter

    const llmCaller = {
      getAdapter: vi.fn().mockResolvedValue({
        adapter,
        providerType: 'anthropic',
        modelId: 'test-model',
        configSource: 'scheme-param',
        schemeName: null,
      }),
    } as unknown as Parameters<typeof executeLlmCallWithRetry>[0]['llmCaller']

    return {
      llmCaller,
      state: {messages: history} as never,
      systemPrompt: 'CORE_SYSTEM_PROMPT',
      availableToolDefinitions: [],
      preCapabilityToolDefinitions: [],
      modelConfig: {provider: 'anthropic', model: 'test-model'} as never,
      workModeRole: 'primary',
      schemeName: null,
      getSettings: () => ({
        agent: {retryCount: 3, initialRetryDelay: 1, maxRetryDelay: 5, llmTimeout: 5000, handoffThresholdRatio: 0.5, midLoopOverflowMode: opts.overflowMode ?? 'auto-handoff'},
        model: {defaultMaxTokens: 4096, defaultTemperature: 0},
      }) as never,
      params: {
        abortSignal: undefined,
        requestConfirmation: undefined,
        sessionId,
        schemeUpdatePromise: undefined,
        ...(opts.traceContext ? {traceContext: opts.traceContext} : {}),
      } as never,
      turns: 1,
      preprocessCache: new PreprocessCache(),
      directModel: false,
    }
  }

  async function drive(ctx: ExecuteLlmCallParams) {
    const gen = executeLlmCallWithRetry(ctx)
    let result: IteratorResult<unknown, unknown>
    do {
      result = await gen.next()
    } while (!result.done)
    return result.value
  }

  function usageStream(inputTokens: number, cacheReadTokens: number): () => AsyncGenerator<StreamChunk> {
    return async function* () {
      yield {type: 'text', content: 'ok'}
      yield {type: 'usage', inputTokens, outputTokens: 2, cacheReadTokens}
      yield {type: 'done', stopReason: 'end_turn'}
    }
  }

  it('上一轮真实 usage 超阈值 → 下一轮注入交接指令（末尾 user 消息）', async () => {
    const sessionId = `gate-over-${++seq}`
    const history: ChatMessage[] = [{role: 'user', content: 'hello'}]

    // 第 1 次调用：gate 无真实 usage 记录 → 字符估算（极小）→ 不注入；
    // 流返回真实 usage 550k > 0.5 × 1M = 500k（test-model 无注册窗口，走 1M fallback）
    const chat = vi.fn().mockImplementation(usageStream(400_000, 150_000))
    await drive(buildCtx(chat, sessionId, history))
    expect(chat).toHaveBeenCalledTimes(1)
    const firstMsgs = chat.mock.calls[0][0].messages as ChatMessage[]
    expect(firstMsgs.some(m => String(m.content ?? '').includes('准备交接'))).toBe(false)

    // 第 2 次调用：gate 应消费第 1 轮真实 usage（550k > 500k 阈值）→ 注入
    const chat2 = vi.fn().mockImplementation(usageStream(1, 0))
    await drive(buildCtx(chat2, sessionId, history))
    expect(chat2).toHaveBeenCalledTimes(1)
    const msgs = chat2.mock.calls[0][0].messages as ChatMessage[]
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(String(last.content)).toContain(MID_LOOP_HANDOFF_PROMPT.slice(0, 20))
    expect(String(last.content)).toContain('session_handoff')
  })

  it('上一轮真实 usage 低于阈值 → 不注入', async () => {
    const sessionId = `gate-under-${++seq}`
    const chat = vi.fn().mockImplementation(usageStream(10_000, 5_000))
    await drive(buildCtx(chat, sessionId, [{role: 'user', content: 'hello'}]))

    const chat2 = vi.fn().mockImplementation(usageStream(1, 0))
    await drive(buildCtx(chat2, sessionId, [{role: 'user', content: 'hello'}]))
    const msgs = chat2.mock.calls[0][0].messages as ChatMessage[]
    expect(msgs.some(m => String(m.content ?? '').includes('准备交接'))).toBe(false)
  })

  it('子会话（traceContext=subAgent）超阈值 → 不注入交接指令（保护 agentTool 返回语义）', async () => {
    const sessionId = `gate-subagent-${++seq}`
    // 第 1 轮：记录真实 usage 550k > 0.5 × 1M（test-model 走 1M fallback）
    const chat = vi.fn().mockImplementation(usageStream(400_000, 150_000))
    await drive(buildCtx(chat, sessionId, [{role: 'user', content: 'hello'}]))

    // 第 2 轮：同一会话以子会话身份运行 → 门短路，即使超阈值也不注入
    const chat2 = vi.fn().mockImplementation(usageStream(400_000, 150_000))
    await drive(buildCtx(chat2, sessionId, [{role: 'user', content: 'hello'}], {traceContext: 'subAgent'}))
    const subMsgs = chat2.mock.calls[0][0].messages as ChatMessage[]
    expect(subMsgs.some(m => String(m.content ?? '').includes('准备交接'))).toBe(false)

    // 对照：同一 sessionId 以主会话身份运行 → 仍正常注入（证明差异来自 traceContext，而非 fixture 失效）
    const chat3 = vi.fn().mockImplementation(usageStream(1, 0))
    await drive(buildCtx(chat3, sessionId, [{role: 'user', content: 'hello'}]))
    const mainMsgs = chat3.mock.calls[0][0].messages as ChatMessage[]
    expect(mainMsgs.some(m => String(m.content ?? '').includes(MID_LOOP_HANDOFF_PROMPT.slice(0, 20)))).toBe(true)
  })

  it('子会话 + graceful-stop 档位 → 不触发 stop（正常返回结果而非 null）', async () => {
    const sessionId = `gate-subagent-stop-${++seq}`
    const chat = vi.fn().mockImplementation(usageStream(400_000, 150_000))
    await drive(buildCtx(chat, sessionId, [{role: 'user', content: 'hello'}]))

    const chat2 = vi.fn().mockImplementation(usageStream(400_000, 150_000))
    const result = await drive(buildCtx(chat2, sessionId, [{role: 'user', content: 'hello'}], {
      traceContext: 'subAgent',
      overflowMode: 'graceful-stop',
    }))
    // stop 路径返回 null（controller 随即 early_exit）——子会话必须走正常返回
    expect(result).not.toBeNull()
  })
})
