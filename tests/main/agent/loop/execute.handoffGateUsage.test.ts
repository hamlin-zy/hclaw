import {describe, expect, it, vi, afterEach} from 'vitest'
import {executeLlmCallWithRetry, MID_LOOP_HANDOFF_PROMPT, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'

/**
 * mid-loop 交接门分子修复回归测试：
 * gate 分子必须优先使用上一轮 LLM 请求的真实 usage（inputTokens + cacheReadTokens）。
 * B1 重构后 loop 内存态 assistant 消息不再携带 llmStats，
 * 原 resolveContextUsageTokens 恒回退 chars/4 估算 → 中文低估约 4 倍 → gate 永不触发。
 */
describe('executeLlmCallWithRetry mid-loop 交接门（真实 usage 优先）', () => {
  afterEach(() => vi.restoreAllMocks())

  /** 唯一 sessionId，避免用例间共享模块级 usage 记录 */
  let seq = 0

  function buildCtx(
    chat: ReturnType<typeof vi.fn>,
    sessionId: string,
    history: ChatMessage[],
  ): ExecuteLlmCallParams {
    const adapter = {
      chat,
      getModelInfo: () => ({maxContextTokens: 128_000}),
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
        agent: {retryCount: 3, initialRetryDelay: 1, maxRetryDelay: 5, llmTimeout: 5000, handoffThresholdRatio: 0.5, midLoopOverflowMode: 'auto-handoff'},
        model: {defaultMaxTokens: 4096, defaultTemperature: 0},
      }) as never,
      params: {
        abortSignal: undefined,
        requestConfirmation: undefined,
        sessionId,
        schemeUpdatePromise: undefined,
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
    // 流返回真实 usage 80k > 0.5 × 128k = 64k
    const chat = vi.fn().mockImplementation(usageStream(50_000, 30_000))
    await drive(buildCtx(chat, sessionId, history))
    expect(chat).toHaveBeenCalledTimes(1)
    const firstMsgs = chat.mock.calls[0][0].messages as ChatMessage[]
    expect(firstMsgs.some(m => String(m.content ?? '').includes('准备交接'))).toBe(false)

    // 第 2 次调用：gate 应消费第 1 轮真实 usage（80k > 64k）→ 注入
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
})
