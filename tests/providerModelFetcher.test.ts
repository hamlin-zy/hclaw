// tests/providerModelFetcher.test.ts
import {afterEach, describe, expect, it, vi} from 'vitest'
import {classifyTestError, fetchProviderModels, testProviderModel} from '../src/main/providerModelFetcher'

const okJson = (body: unknown) => ({ok: true, status: 200, text: async () => JSON.stringify(body)}) as unknown as Response
const errRes = (status: number, body = '') => ({ok: status < 400, status, text: async () => body}) as unknown as Response

afterEach(() => vi.unstubAllGlobals())

describe('fetchProviderModels', () => {
  it('openai 成功拉取并推断类型', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({data: [{id: 'gpt-4o'}, {id: 'dall-e-3'}, {id: 'whisper-1'}]})))
    const r = await fetchProviderModels({type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k'})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.map(m => m.id)).toEqual(['gpt-4o', 'dall-e-3', 'whisper-1'])
      expect(r.data.map(m => m.modelType)).toEqual(['text', 'image', 'voice'])
    }
  })
  it('anthropic 404 回退 openai 成功且切换 Bearer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errRes(404))
      .mockResolvedValueOnce(okJson({data: [{id: 'deepseek-v4-pro'}]}))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchProviderModels({type: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k'})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.map(m => m.id)).toEqual(['deepseek-v4-pro'])
    const calls = fetchMock.mock.calls
    expect(String(calls[1][0])).toBe('https://api.deepseek.com/models')
    expect((calls[1][1] as any).headers.Authorization).toBe('Bearer k')
  })
  it('anthropic 回退仍 404 → unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errRes(404)))
    const r = await fetchProviderModels({type: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'k'})
    expect(r).toEqual({success: false, error: '该服务商不支持自动获取，请手动添加模型', code: 'unsupported'})
  })
  it('401 → auth', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errRes(401)))
    const r = await fetchProviderModels({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'bad'})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.code).toBe('auth')
  })
  it('网络失败 → network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const r = await fetchProviderModels({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k'})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.code).toBe('network')
  })
  it('非 JSON → parse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, text: async () => '<html>login</html>'} as unknown as Response))
    const r = await fetchProviderModels({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k'})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.code).toBe('parse')
  })
  it('空列表 → empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({data: []})))
    const r = await fetchProviderModels({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k'})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.code).toBe('empty')
  })
  it('google oauth2 过期时刷新 token 并通过 oauthTokens 返回', async () => {
    const refreshGoogleToken = vi.fn().mockResolvedValue({accessToken: 'new-token', expiryDate: Date.now() + 3600_000})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({models: [{name: 'models/gemini-2.5-pro'}]})))
    const r = await fetchProviderModels({
      type: 'google', authType: 'google-oauth2',
      accessToken: 'old', refreshToken: 'rt', expiryDate: Date.now() - 1000,
    }, {refreshGoogleToken})
    expect(refreshGoogleToken).toHaveBeenCalledWith('rt')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.oauthTokens?.accessToken).toBe('new-token')
      expect(r.data.map(m => m.id)).toEqual(['gemini-2.5-pro'])
    }
  })
  it('google 有效 token 不刷新', async () => {
    const refreshGoogleToken = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({models: []})))
    await fetchProviderModels({type: 'google', authType: 'google-oauth2', accessToken: 'ok', refreshToken: 'rt', expiryDate: Date.now() + 3600_000}, {refreshGoogleToken})
    expect(refreshGoogleToken).not.toHaveBeenCalled()
  })
})

describe('testProviderModel', () => {
  const fakeAdapter = (chunks: Array<{type: string; error?: Error}>) => ({
    chat: async function* () { for (const c of chunks) yield c },
    getModelInfo: () => ({}),
  })

  it('done → 成功并返回延迟', async () => {
    const createAdapter = vi.fn().mockReturnValue(fakeAdapter([{type: 'done'}]))
    const r = await testProviderModel({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'gpt-4o'}, {createAdapter})
    expect(r.success).toBe(true)
    if (r.success) expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(createAdapter).toHaveBeenCalledWith(expect.objectContaining({model: 'gpt-4o', apiKey: 'k'}))
  })
  it('error chunk 404 → 模型不存在', async () => {
    const createAdapter = vi.fn().mockReturnValue(fakeAdapter([{type: 'error', error: Object.assign(new Error('x'), {status: 404})}]))
    const r = await testProviderModel({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'bad-model'}, {createAdapter})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toContain('模型不存在')
  })
  it('无 apiKey → 前置错误', async () => {
    const r = await testProviderModel({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: '', model: 'gpt-4o'})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toBe('请先填写 API Key')
  })
  it('空模型名（trim 后）→ 前置错误', async () => {
    const r = await testProviderModel({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k', model: '  '})
    expect(r.success).toBe(false)
  })
  it('ollama 无需 key', async () => {
    const createAdapter = vi.fn().mockReturnValue(fakeAdapter([{type: 'done'}]))
    const r = await testProviderModel({type: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', model: 'llama3'}, {createAdapter})
    expect(r.success).toBe(true)
  })
  it('custom 类型 → 友好提示且不创建适配器', async () => {
    const createAdapter = vi.fn()
    const r = await testProviderModel({type: 'custom', baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'm'}, {createAdapter})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toContain('不支持')
    expect(createAdapter).not.toHaveBeenCalled()
  })
  it('google oauth2 过期刷新后使用新 token', async () => {
    const refreshGoogleToken = vi.fn().mockResolvedValue({accessToken: 'new', expiryDate: Date.now() + 3600_000})
    const createAdapter = vi.fn().mockReturnValue(fakeAdapter([{type: 'done'}]))
    const r = await testProviderModel({type: 'google', authType: 'google-oauth2', accessToken: 'old', refreshToken: 'rt', expiryDate: Date.now() - 1, model: 'gemini-2.5-pro'}, {createAdapter, refreshGoogleToken})
    expect(refreshGoogleToken).toHaveBeenCalled()
    expect(r.success).toBe(true)
    expect(createAdapter).toHaveBeenCalledWith(expect.objectContaining({apiKey: 'new'}))
  })
  it('401 → 认证失败', async () => {
    const createAdapter = vi.fn().mockReturnValue(fakeAdapter([{type: 'error', error: Object.assign(new Error('unauthorized'), {status: 401})}]))
    const r = await testProviderModel({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'bad', model: 'gpt-4o'}, {createAdapter})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toContain('认证失败')
  })
  it('15s 超时 abort 后流无 done → 连接超时而非流提前结束', async () => {
    vi.useFakeTimers()
    try {
      // 真实适配器在 abort 时静默结束流：不 yield done、不 throw，直接 return 终止生成器
      const hangingAdapter = {
        chat: async function* ({abortSignal}: {abortSignal: AbortSignal}) {
          // 在 abort 之前保持挂起，不产生任何 chunk；abort 后结束流（不 yield done）
          await new Promise<void>(resolve => {
            if (abortSignal.aborted) { resolve(); return }
            abortSignal.addEventListener('abort', () => resolve(), {once: true})
          })
        },
        getModelInfo: () => ({}),
      }
      const createAdapter = vi.fn().mockReturnValue(hangingAdapter)
      const promise = testProviderModel({type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'gpt-4o'}, {createAdapter})
      await vi.advanceTimersByTimeAsync(15000)
      const r = await promise
      expect(r).toEqual({success: false, error: '连接超时：请检查 Base URL 与网络'})
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('classifyTestError', () => {
  it('401 → 认证失败', () => expect(classifyTestError({status: 401, message: 'x'})).toContain('认证失败'))
  it('403 → 认证失败', () => expect(classifyTestError({status: 403, message: 'x'})).toContain('认证失败'))
  it('404 → 模型不存在', () => expect(classifyTestError({status: 404, message: 'x'})).toContain('模型不存在'))
  it('AbortError → 连接超时', () => expect(classifyTestError({name: 'AbortError', message: 'aborted'})).toContain('连接超时'))
  it('5xx → 服务商异常', () => expect(classifyTestError({status: 502, message: 'bad gateway'})).toContain('5xx'))
  it('普通错误 → 原始信息截断', () => expect(classifyTestError({message: 'rate limit exceeded'})).toBe('rate limit exceeded'))
})
