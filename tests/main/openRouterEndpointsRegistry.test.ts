import {describe, expect, it, beforeEach, afterEach} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {OpenRouterEndpointsRegistry} from '@/main/openRouterEndpointsRegistry'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-endpoints-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

/** 构造 OpenRouter /models/{author}/{slug}/endpoints 响应 */
function endpointsResponse(id: string, endpoints: unknown[]): string {
  return JSON.stringify({data: {id, endpoints}})
}

const GPT4O_ENDPOINTS = [
  {tag: 'azure', provider_name: 'Azure', context_length: 128000, supports_implicit_caching: false, uptime_last_30m: 99.95},
  {tag: 'openai', provider_name: 'OpenAI', context_length: 128000, supports_implicit_caching: true, uptime_last_30m: 99.8},
]

function okFetch(body: string, onCall?: (url: string) => void): typeof fetch {
  return (async (url: string) => {
    onCall?.(String(url))
    return {ok: true, status: 200, text: async () => body}
  }) as unknown as typeof fetch
}

const CACHE_FILE = 'or-endpoints.json'

describe('OpenRouterEndpointsRegistry', () => {
  it('首次拉取：返回 providers + 写盘（结构为 {[modelId]: {fetchedAt, providers}}）', async () => {
    const fetchFn = okFetch(endpointsResponse('openai/gpt-4o', GPT4O_ENDPOINTS)) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})

    const r = await reg.getModelEndpoints('openai/gpt-4o')
    expect(r.providers).toHaveLength(2)
    expect(r.providers[0].slug).toBe('azure')
    expect(r.fetchedAt).toBeGreaterThan(0)

    const cacheFile = path.join(tmpDir, CACHE_FILE)
    expect(fs.existsSync(cacheFile)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    expect(parsed['openai/gpt-4o'].providers).toHaveLength(2)
    expect(parsed['openai/gpt-4o'].fetchedAt).toBe(r.fetchedAt)
  })

  it('请求 URL 使用 baseModelSlug（:nitro 变体不进入 URL），并按该 slug 建缓存键', async () => {
    const urls: string[] = []
    const fetchFn = okFetch(endpointsResponse('deepseek/deepseek-r1', []), u => urls.push(u)) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})

    await reg.getModelEndpoints('deepseek/deepseek-r1:nitro')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/models/deepseek/deepseek-r1/endpoints')
    expect(urls[0]).not.toContain(':nitro')

    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, CACHE_FILE), 'utf8'))
    expect(Object.keys(parsed)).toEqual(['deepseek/deepseek-r1'])
  })

  it('二次查询命中内存缓存，不重复 fetch', async () => {
    let callCount = 0
    const fetchFn = okFetch(endpointsResponse('openai/gpt-4o', GPT4O_ENDPOINTS), () => callCount++) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})

    await reg.getModelEndpoints('openai/gpt-4o')
    await reg.getModelEndpoints('openai/gpt-4o')
    expect(callCount).toBe(1)
  })

  it('新实例从盘命中缓存，不发网络请求', async () => {
    const reg1 = new OpenRouterEndpointsRegistry({
      cacheDir: tmpDir,
      fetchFn: okFetch(endpointsResponse('openai/gpt-4o', GPT4O_ENDPOINTS)) as typeof fetch,
    })
    await reg1.getModelEndpoints('openai/gpt-4o')

    let callCount = 0
    const reg2 = new OpenRouterEndpointsRegistry({
      cacheDir: tmpDir,
      fetchFn: (async () => {
        callCount++
        throw new Error('should not fetch')
      }) as unknown as typeof fetch,
    })
    const r = await reg2.getModelEndpoints('openai/gpt-4o')
    expect(callCount).toBe(0)
    expect(r.providers).toHaveLength(2)
  })

  it('force=true 强制重拉并更新缓存', async () => {
    let callCount = 0
    const bodies = [
      endpointsResponse('a/b', [{tag: 'old', provider_name: 'Old'}]),
      endpointsResponse('a/b', [{tag: 'new', provider_name: 'New'}]),
    ]
    const fetchFn = (async () => {
      const body = bodies[Math.min(callCount, bodies.length - 1)]
      callCount++
      return {ok: true, status: 200, text: async () => body}
    }) as unknown as typeof fetch

    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})
    const first = await reg.getModelEndpoints('a/b')
    expect(first.providers[0].slug).toBe('old')

    const forced = await reg.getModelEndpoints('a/b', true)
    expect(callCount).toBe(2)
    expect(forced.providers[0].slug).toBe('new')

    // 落盘也是新数据
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, CACHE_FILE), 'utf8'))
    expect(parsed['a/b'].providers[0].slug).toBe('new')
  })

  it('fetch 抛错：静默返回空且不破坏已有缓存', async () => {
    const reg1 = new OpenRouterEndpointsRegistry({
      cacheDir: tmpDir,
      fetchFn: okFetch(endpointsResponse('a/b', [{tag: 'azure', provider_name: 'Azure'}])) as typeof fetch,
    })
    await reg1.getModelEndpoints('a/b')

    const failing = new OpenRouterEndpointsRegistry({
      cacheDir: tmpDir,
      fetchFn: (async () => { throw new Error('network down') }) as unknown as typeof fetch,
    })
    const r = await failing.getModelEndpoints('a/b', true)
    expect(r).toEqual({fetchedAt: 0, providers: []})

    // 磁盘缓存未被破坏
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, CACHE_FILE), 'utf8'))
    expect(parsed['a/b'].providers[0].slug).toBe('azure')
  })

  it('HTTP 非 2xx → 静默返回空（不抛）', async () => {
    const fetchFn = (async () => ({ok: false, status: 404, text: async () => ''})) as unknown as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})
    await expect(reg.getModelEndpoints('a/b')).resolves.toEqual({fetchedAt: 0, providers: []})
  })

  it('响应畸形（缺 data/endpoints）→ 静默返回空，不写脏缓存', async () => {
    const fetchFn = okFetch(JSON.stringify({data: {id: 'a/b'}})) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})
    const r = await reg.getModelEndpoints('a/b')
    expect(r).toEqual({fetchedAt: 0, providers: []})
    expect(fs.existsSync(path.join(tmpDir, CACHE_FILE))).toBe(false)
  })

  it('并发同一 modelId 合并为一次请求', async () => {
    let callCount = 0
    const fetchFn = (async () => {
      callCount++
      await new Promise(r => setTimeout(r, 20))
      return {ok: true, status: 200, text: async () => endpointsResponse('a/b', [{tag: 'x', provider_name: 'X'}])}
    }) as unknown as typeof fetch

    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})
    const [r1, r2] = await Promise.all([reg.getModelEndpoints('a/b'), reg.getModelEndpoints('a/b')])
    expect(callCount).toBe(1)
    expect(r1.providers[0].slug).toBe('x')
    expect(r2.providers[0].slug).toBe('x')
  })

  it('空 modelId → 直接返回空，不发请求', async () => {
    let callCount = 0
    const fetchFn = okFetch('{}', () => callCount++) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})
    await expect(reg.getModelEndpoints('')).resolves.toEqual({fetchedAt: 0, providers: []})
    await expect(reg.getModelEndpoints('   ')).resolves.toEqual({fetchedAt: 0, providers: []})
    expect(callCount).toBe(0)
  })

  it('缓存文件损坏 → 不崩溃，重新拉取', async () => {
    fs.mkdirSync(tmpDir, {recursive: true})
    fs.writeFileSync(path.join(tmpDir, CACHE_FILE), '{broken json')

    let callCount = 0
    const fetchFn = okFetch(endpointsResponse('a/b', [{tag: 'x', provider_name: 'X'}]), () => callCount++) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})

    const r = await reg.getModelEndpoints('a/b')
    expect(r.providers).toHaveLength(1)
    expect(callCount).toBe(1)
  })

  it('force=true 不复用在途的普通请求（刷新拿新结果，而非旧响应）', async () => {
    let callCount = 0
    const fetchFn = (async () => {
      callCount++
      const n = callCount
      await new Promise(r => setTimeout(r, 10))
      return {ok: true, status: 200, text: async () => endpointsResponse('a/b', [{tag: `p${n}`, provider_name: `P${n}`}])}
    }) as unknown as typeof fetch

    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})
    const normal = reg.getModelEndpoints('a/b')        // 普通请求在途
    const forced = reg.getModelEndpoints('a/b', true)  // 「刷新」不得复用上面那笔
    const [a, b] = await Promise.all([normal, forced])
    expect(callCount).toBe(2)
    expect(a.providers[0].slug).toBe('p1')
    expect(b.providers[0].slug).toBe('p2')
  })

  it('内存命中返回浅拷贝：调用方改动结果不污染注册表缓存', async () => {
    const fetchFn = okFetch(endpointsResponse('a/b', [{tag: 'x', provider_name: 'X'}])) as typeof fetch
    const reg = new OpenRouterEndpointsRegistry({cacheDir: tmpDir, fetchFn})

    const first = await reg.getModelEndpoints('a/b')
    first.providers.push({slug: 'injected', name: 'Injected', supportsImplicitCaching: false})
    first.fetchedAt = -1

    const second = await reg.getModelEndpoints('a/b')
    expect(second.providers).toHaveLength(1)
    expect(second.fetchedAt).toBeGreaterThan(0)
  })
})
