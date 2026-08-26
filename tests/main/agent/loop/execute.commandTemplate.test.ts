import {describe, expect, it, vi, afterEach} from 'vitest'
import {executeLlmCallWithRetry, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

/**
 * R1：命令模板必须尾随注入（末尾 user 消息），不得拼接进 systemPrompt。
 * 否则命令轮 system 与普通轮不一致 → 供应商前缀缓存全部失效（cached_tokens 归零）。
 */
describe('executeLlmCallWithRetry 命令模板尾随注入（R1）', () => {
  afterEach(() => vi.restoreAllMocks())

  const TEMPLATE = '/write-plan 请输出完整计划'

  async function* okStream(): AsyncGenerator<StreamChunk> {
    yield {type: 'text', content: 'ok'}
    yield {type: 'usage', inputTokens: 1, outputTokens: 2}
    yield {type: 'done', stopReason: 'end_turn'}
  }

  function buildCtx(chat: ReturnType<typeof vi.fn>, provider: string, commandTemplate: string): ExecuteLlmCallParams {
    const adapter = {
      chat,
      getModelInfo: () => ({maxContextTokens: 128_000}),
      invalidateConvertCache: vi.fn(),
    } as unknown as ModelAdapter

    const llmCaller = {
      getAdapter: vi.fn().mockResolvedValue({
        adapter,
        providerType: provider,
        modelId: 'test-model',
        configSource: 'scheme-param',
        schemeName: null,
      }),
    } as unknown as Parameters<typeof executeLlmCallWithRetry>[0]['llmCaller']

    return {
      llmCaller,
      state: {messages: [{role: 'user', content: 'hello'}] as ChatMessage[]} as never,
      systemPrompt: 'CORE_SYSTEM_PROMPT',
      commandTemplate,
      availableToolDefinitions: [],
      preCapabilityToolDefinitions: [],
      modelConfig: {provider, model: 'test-model'} as never,
      workModeRole: 'primary',
      schemeName: null,
      getSettings: () => ({
        agent: {retryCount: 3, initialRetryDelay: 1, maxRetryDelay: 5, llmTimeout: 5000},
        model: {defaultMaxTokens: 4096, defaultTemperature: 0},
      }) as never,
      params: {
        abortSignal: undefined,
        requestConfirmation: undefined,
        sessionId: 'test-session',
        schemeUpdatePromise: undefined,
      } as never,
      turns: 1,
      preprocessCache: new PreprocessCache(),
      directModel: false,
    }
  }

  async function drive(ctx: ExecuteLlmCallParams) {
    const gen = executeLlmCallWithRetry(ctx)
    let done: IteratorResult<unknown, unknown>
    do {
      done = await gen.next()
    } while (!done.done)
  }

  it('openai chat 路径：system 不含模板，模板在末尾 user 消息中', async () => {
    const chat = vi.fn().mockImplementation(() => okStream())
    await drive(buildCtx(chat, 'deepseek', TEMPLATE))

    expect(chat).toHaveBeenCalledTimes(1)
    const call = chat.mock.calls[0][0]

    // system 与普通轮逐字一致（不拼接模板）
    expect(call.systemPrompt).toBe('CORE_SYSTEM_PROMPT')

    // 模板出现在消息序列末尾
    const msgs = call.messages as ChatMessage[]
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(String(last.content)).toContain('<command-task>')
    expect(String(last.content)).toContain(TEMPLATE)

    // 不再把 commandTemplate 作为独立参数传给 adapter
    expect(call.commandTemplate).toBeUndefined()
  })

  it('anthropic 路径：同样尾随注入而非拼接 system', async () => {
    const chat = vi.fn().mockImplementation(() => okStream())
    await drive(buildCtx(chat, 'anthropic', TEMPLATE))

    const call = chat.mock.calls[0][0]
    expect(call.systemPrompt).toBe('CORE_SYSTEM_PROMPT')
    const msgs = call.messages as ChatMessage[]
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(String(last.content)).toContain(TEMPLATE)
  })

  it('无命令轮：不追加任何模板消息', async () => {
    const chat = vi.fn().mockImplementation(() => okStream())
    await drive(buildCtx(chat, 'deepseek', ''))

    const call = chat.mock.calls[0][0]
    const msgs = call.messages as ChatMessage[]
    expect(msgs.some(m => String(m.content ?? '').includes('<command-task>'))).toBe(false)
  })
})
