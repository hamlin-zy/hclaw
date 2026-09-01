import {describe, expect, it, vi, afterEach} from 'vitest'
import {executeLlmCallWithRetry, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'

/**
 * Task 4 重写：CT（<command-task>）已改为真实持久化消息（controller 主循环前
 * 插入 state 并落库），executeLlmCallWithRetry 不再接收 commandTemplate 参数，
 * 也不再合成注入任何尾随消息。本文件保留 executeLlmCallWithRetry 的基础行为用例。
 */
describe('executeLlmCallWithRetry 基础行为', () => {
  afterEach(() => vi.restoreAllMocks())

  async function* okStream(): AsyncGenerator<StreamChunk> {
    yield {type: 'text', content: 'ok'}
    yield {type: 'usage', inputTokens: 1, outputTokens: 2}
    yield {type: 'done', stopReason: 'end_turn'}
  }

  function buildCtx(chat: ReturnType<typeof vi.fn>, provider: string): ExecuteLlmCallParams {
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

  it('openai chat 路径：system 透传，消息按 state 原样发送', async () => {
    const chat = vi.fn().mockImplementation(() => okStream())
    await drive(buildCtx(chat, 'deepseek'))

    expect(chat).toHaveBeenCalledTimes(1)
    const call = chat.mock.calls[0][0]

    expect(call.systemPrompt).toBe('CORE_SYSTEM_PROMPT')

    // 不再有合成 CT：消息序列与 state 一致，末尾不出现 <command-task>
    const msgs = call.messages as ChatMessage[]
    expect(msgs).toHaveLength(1)
    expect(msgs.every(m => !String(m.content ?? '').includes('<command-task>'))).toBe(true)

    // 不再把 commandTemplate 作为独立参数传给 adapter
    expect(call.commandTemplate).toBeUndefined()
  })

  it('anthropic 路径：同样透传，不注入任何模板消息', async () => {
    const chat = vi.fn().mockImplementation(() => okStream())
    await drive(buildCtx(chat, 'anthropic'))

    const call = chat.mock.calls[0][0]
    expect(call.systemPrompt).toBe('CORE_SYSTEM_PROMPT')
    const msgs = call.messages as ChatMessage[]
    expect(msgs.some(m => String(m.content ?? '').includes('<command-task>'))).toBe(false)
  })

  it('历史带旧 commandTemplate metadata：仍原样发送，不合成 CT（metadata 不影响内容字节）', async () => {
    const chat = vi.fn().mockImplementation(() => okStream())
    const ctx = buildCtx(chat, 'deepseek')
    ctx.state = {
      messages: [
        {role: 'user', content: 'hello', id: 'm0', metadata: {commandId: 'cmd-abc', commandTemplate: '/skill x'}},
        {role: 'assistant', content: 'ok', id: 'a1'},
      ] as ChatMessage[],
    } as never
    await drive(ctx)

    const call = chat.mock.calls[0][0]
    const msgs = call.messages as ChatMessage[]
    expect(msgs).toHaveLength(2)
    expect(msgs.some(m => String(m.content ?? '').includes('<command-task>'))).toBe(false)
  })
})
