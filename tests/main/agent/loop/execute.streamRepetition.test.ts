import {describe, expect, it, vi, afterEach} from 'vitest'
import {executeLlmCallWithRetry, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'
import type {LlmStreamResult} from '../../../../src/main/agent/loop/types'

/**
 * 缺陷 D3 回归（主进程 LLM 循环）：
 * `for await (const chunk of stream)` 在检测到重复时曾直接 `break`。
 * 但 usage（OpenAI/Anthropic 适配器均在流末尾 `yield* sendUsage()`）与
 * thinking_signature（Anthropic extended thinking 后段回传）位于流末尾，
 * break 后这些 chunk 永不被消费 → 触发截断的那次请求 inputTokens/outputTokens = 0
 * （污染 lastRequestUsageBySession），assistantThinkingSignature 保持 ''。
 *
 * 修复语义：检测到重复改为「置 repetitionDetected 标志 + 内容分支守卫」，
 * 其余（usage / thinking_signature / done / error）照常消费。
 */
describe('executeLlmCallWithRetry 流式重复检测（D3：检测后继续消费剩余流）', () => {
  afterEach(() => vi.restoreAllMocks())

  /** 唯一 sessionId，避免模块级 lastRequestUsageBySession 跨用例污染（交接门分子） */
  let seq = 0

  /** 长于探测窗口（默认 shingleSize=120）的可重复片段 */
  const SEG = '这是一段用于触发流式重复检测的长文本片段，需要足够长度覆盖一百二十字符的探测窗口，并在此之后被完整重复多次形成循环输出。'

  function buildCtx(
    chat: ReturnType<typeof vi.fn>,
    opts: { repetition?: {enabled: boolean; shingleSize: number; threshold: number; checkInterval: number} } = {},
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

    const agent: Record<string, unknown> = {
      retryCount: 3,
      initialRetryDelay: 1,
      maxRetryDelay: 5,
      llmTimeout: 5000,
    }
    // 缺省不写该键 = 走 execute 的「未配置 ⇒ 开启 + detector 默认参数」路径
    if (opts.repetition) agent.streamRepetitionDetection = opts.repetition

    return {
      llmCaller,
      state: {messages: [{role: 'user', content: 'hi'}] as ChatMessage[]} as never,
      systemPrompt: 'sys',
      availableToolDefinitions: [],
      preCapabilityToolDefinitions: [],
      modelConfig: {provider: 'anthropic', model: 'test-model'} as never,
      workModeRole: 'primary',
      schemeName: null,
      getSettings: () => ({
        agent,
        model: {defaultMaxTokens: 4096, defaultTemperature: 0},
      }) as never,
      params: {
        abortSignal: undefined,
        requestConfirmation: undefined,
        sessionId: `srd-${++seq}`,
        schemeUpdatePromise: undefined,
      } as never,
      turns: 1,
      preprocessCache: new PreprocessCache(),
      directModel: false,
    }
  }

  /** 驱动生成器至完成，收集全部 yield 事件 + 最终返回值 */
  async function drive(ctx: ExecuteLlmCallParams) {
    const gen = executeLlmCallWithRetry(ctx)
    const events: Array<{type: string; message?: string}> = []
    let r = await gen.next()
    while (!r.done) {
      events.push(r.value as {type: string; message?: string})
      r = await gen.next()
    }
    return {result: r.value as LlmStreamResult | null, events}
  }

  it('text 重复流：截断 + warning + 流末尾 usage 仍被消费', async () => {
    const fullText = '前置说明。' + SEG.repeat(12)
    async function* textRepeatStream(): AsyncGenerator<StreamChunk> {
      yield {type: 'text', content: '前置说明。'}
      yield {type: 'text', content: SEG.repeat(12)}
      // 适配器流末尾发送 usage（openaiAdapter.ts 的 yield* sendUsage()）
      yield {type: 'usage', inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89}
      yield {type: 'done', stopReason: 'end_turn'}
    }

    const chat = vi.fn().mockImplementation(textRepeatStream)
    const {result, events} = await drive(buildCtx(chat))

    expect(result).not.toBeNull()
    // 截断：保留一份完整内容，丢弃重复尾部
    expect(result!.assistantContent.length).toBeGreaterThan(0)
    expect(result!.assistantContent.length).toBeLessThan(fullText.length)
    // 用户可见提示
    expect(events.some(e => e.type === 'warning' && String(e.message).includes('重复循环'))).toBe(true)
    // ★ D3 回归守卫：usage 位于流末尾，检测触发后仍必须被消费（修复前恒为 0）
    expect(result!.inputTokens).toBe(1234)
    expect(result!.outputTokens).toBe(567)
    expect(result!.cacheReadTokens).toBe(89)
  })

  it('thinking 重复流：思考块被截断 + 流末尾 thinking_signature 被保留', async () => {
    async function* thinkingRepeatStream(): AsyncGenerator<StreamChunk> {
      // 先给一点正文，避免截断后 assistantContent 为空触发「空响应」错误
      yield {type: 'text', content: '开始思考。'}
      yield {type: 'thinking', content: SEG.repeat(12)}
      // Anthropic 在 thinking 块之后回传 signature（execute.ts 的 thinking_signature 分支）
      yield {type: 'thinking_signature', signature: 'sig-abc-123'}
      yield {type: 'usage', inputTokens: 111, outputTokens: 22}
      yield {type: 'done', stopReason: 'end_turn'}
    }

    const chat = vi.fn().mockImplementation(thinkingRepeatStream)
    const {result, events} = await drive(buildCtx(chat))

    expect(result).not.toBeNull()
    expect(result!.assistantThinking.length).toBeGreaterThan(0)
    expect(result!.assistantThinking.length).toBeLessThan(SEG.repeat(12).length)
    expect(events.some(e => e.type === 'warning' && String(e.message).includes('思考块'))).toBe(true)
    // ★ D3 回归守卫：signature 位于流末尾，修复前 break 后恒为 ''
    expect(result!.assistantThinkingSignature).toBe('sig-abc-123')
    expect(result!.inputTokens).toBe(111)
  })

  it('enabled:false：长重复流不截断、无 warning、全文返回', async () => {
    const fullText = '前置说明。' + SEG.repeat(12)
    async function* repeatStream(): AsyncGenerator<StreamChunk> {
      yield {type: 'text', content: '前置说明。'}
      yield {type: 'text', content: SEG.repeat(12)}
      yield {type: 'usage', inputTokens: 7, outputTokens: 8}
      yield {type: 'done', stopReason: 'end_turn'}
    }

    const chat = vi.fn().mockImplementation(repeatStream)
    const {result, events} = await drive(buildCtx(chat, {
      repetition: {enabled: false, shingleSize: 120, threshold: 3, checkInterval: 60},
    }))

    expect(result).not.toBeNull()
    expect(result!.assistantContent).toBe(fullText)
    expect(events.some(e => e.type === 'warning')).toBe(false)
    expect(result!.inputTokens).toBe(7)
  })
})
