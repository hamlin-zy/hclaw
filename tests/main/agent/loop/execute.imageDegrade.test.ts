import {describe, expect, it, vi, afterEach} from 'vitest'
import {isImageUnsupportedError, shouldRetryAttempt, executeLlmCallWithRetry, type ExecuteLlmCallParams} from '../../../../src/main/agent/loop/execute'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import * as modelCapability from '../../../../src/main/agent/modelCapability'
import type {ChatMessage, ModelAdapter, StreamChunk} from '../../../../src/main/agent/model/types'
import type {ToolDefinitionForLLM} from '../../../../src/main/agent/tools/types'

describe('isImageUnsupportedError（400 降级触发判定）', () => {
  afterEach(() => vi.restoreAllMocks())

  it('匹配 "This model does not support image"（DeepSeek 原文）', () => {
    const err = new Error('400 This model does not support image')
    expect(isImageUnsupportedError(err)).toBe(true)
  })

  it('匹配 "image data is not supported"（变体）', () => {
    const err = new Error('image data is not supported by this model')
    expect(isImageUnsupportedError(err)).toBe(true)
  })

  it('不匹配普通 400（invalid request）', () => {
    const err = new Error('400 invalid request')
    expect(isImageUnsupportedError(err)).toBe(false)
  })

  it('不匹配 401 Auth', () => {
    const err = Object.assign(new Error('401 unauthorized'), {status: 401})
    expect(isImageUnsupportedError(err)).toBe(false)
  })

  it('带 response 结构（OpenAI SDK 风格 error.response.data.error.message）', () => {
    const err = Object.assign(new Error('Provider returned error'), {
      response: {data: {error: {message: 'This model does not support image'}}},
    })
    expect(isImageUnsupportedError(err)).toBe(true)
  })

  it('空错误对象 → false', () => {
    expect(isImageUnsupportedError(null)).toBe(false)
    expect(isImageUnsupportedError(undefined)).toBe(false)
  })
})

describe('shouldRetryAttempt 回归（降级后重试仍恒 true）', () => {
  it('降级场景（image 400）也重试', () => {
    expect(shouldRetryAttempt({message: 'does not support image'}, false, false)).toBe(true)
  })
})

describe('executeLlmCallWithRetry 400 降级自愈（生成器级，mock adapter）', () => {
  afterEach(() => vi.restoreAllMocks())

  const MODEL_ID = 'deepseek-v4-flash'

  function makeDef(name: string): ToolDefinitionForLLM {
    return {name, description: `${name} desc`, inputSchema: {type: 'object', properties: {}}}
  }

  /** attempt 1 流：模拟 DeepSeek 400 "This model does not support image" */
  async function* imageUnsupportedStream(): AsyncGenerator<StreamChunk> {
    throw new Error('400 This model does not support image')
  }

  /** attempt 2 流：正常响应 */
  async function* okStream(): AsyncGenerator<StreamChunk> {
    yield {type: 'text', content: 'ok'}
    yield {type: 'usage', inputTokens: 1, outputTokens: 2}
    yield {type: 'done', stopReason: 'end_turn'}
  }

  function buildCtx(chat: ReturnType<typeof vi.fn>): ExecuteLlmCallParams {
    const adapter = {
      chat,
      getModelInfo: () => ({maxContextTokens: 128_000}),
      invalidateConvertCache: vi.fn(),
    } as unknown as ModelAdapter

    const llmCaller = {
      getAdapter: vi.fn().mockResolvedValue({
        adapter,
        providerType: 'deepseek',
        modelId: MODEL_ID,
        configSource: 'scheme-param',
        schemeName: null,
      }),
    } as unknown as Parameters<typeof executeLlmCallWithRetry>[0]['llmCaller']

    const imageMsg: ChatMessage = {
      role: 'user',
      content: [
        {type: 'text', text: '看图'},
        {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
      ],
    }

    return {
      llmCaller,
      state: {messages: [imageMsg]} as never,
      systemPrompt: 'sys',
      commandTemplate: '',
      // 能力过滤后（多模态模型）：无 analyze_image
      availableToolDefinitions: [makeDef('file_read')],
      // 白名单后、能力过滤前：含 analyze_image（降级恢复源）
      preCapabilityToolDefinitions: [makeDef('file_read'), makeDef('analyze_image')],
      modelConfig: {provider: 'deepseek', model: MODEL_ID} as never,
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
      isCompactCommand: false,
      turns: 1,
      preprocessCache: new PreprocessCache(),
      directModel: false,
    }
  }

  it('image 400 → 下一 attempt 清 image_url + 恢复白名单后 analyze_image（且消息侧判定同源）', async () => {
    // 消息侧同源判定：spy supportsImageInput（execute.ts 与 filterTools 共用同一函数）
    const supportsSpy = vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(true)

    const chat = vi.fn()
      .mockImplementationOnce(() => imageUnsupportedStream())
      .mockImplementationOnce(() => okStream())

    const ctx = buildCtx(chat)
    const gen = executeLlmCallWithRetry(ctx)

    // 驱动整个生成器（含重试回退 1s）直到完成
    let done: IteratorResult<unknown, unknown>
    do {
      done = await gen.next()
    } while (!done.done)

    expect(chat).toHaveBeenCalledTimes(2)

    // attempt 1：图片仍直发主模型（误判多模态）+ 工具集为能力过滤后（无 analyze_image）
    const firstMsgs = chat.mock.calls[0][0].messages as ChatMessage[]
    expect(firstMsgs.some(m => Array.isArray(m.content) && m.content.some(p => (p as {type?: string}).type === 'image_url'))).toBe(true)
    expect((chat.mock.calls[0][0].tools as ToolDefinitionForLLM[]).map(t => t.name)).not.toContain('analyze_image')

    // attempt 2：降级生效 → image_url 被清 + 恢复白名单后完整工具集（含 analyze_image）
    const secondMsgs = chat.mock.calls[1][0].messages as ChatMessage[]
    expect(secondMsgs.some(m => Array.isArray(m.content) && m.content.some(p => (p as {type?: string}).type === 'image_url'))).toBe(false)
    expect((chat.mock.calls[1][0].tools as ToolDefinitionForLLM[]).map(t => t.name)).toContain('analyze_image')

    // ★ 消息侧同源：supportsImageInput 以当前模型 id 被调用（降级场景消息侧路径仍在执行）
    expect(supportsSpy).toHaveBeenCalledWith(MODEL_ID)
  })
})
