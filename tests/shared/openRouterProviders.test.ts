/**
 * 验证 OpenRouter 模型服务商列表解析器（src/shared/openRouterProviders.ts）。
 *
 * 数据来源：实测 GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints（公开接口，无需 apiKey）
 * 注意：provider_slug 实测为 null，服务商 slug 必须取 endpoint.tag。
 */

import {describe, expect, it} from 'vitest'
import {baseModelSlug, parseModelEndpoints} from '@shared/openRouterProviders'

// ─── 真实抓包结构（2026 年 9 月，openai/gpt-4o） ─────────────────────────────
const ENDPOINTS_RESPONSE = {
  data: {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    created: 1715558400,
    endpoints: [
      {
        name: 'Azure | openai/gpt-4o',
        tag: 'azure',
        provider_name: 'Azure',
        context_length: 128000,
        quantization: 'unknown',
        provider_slug: null,
        supports_implicit_caching: false,
        uptime_last_30m: 99.95,
        pricing: {prompt: '0.0000025', completion: '0.00001'},
      },
      {
        name: 'OpenAI | openai/gpt-4o',
        tag: 'openai',
        provider_name: 'OpenAI',
        context_length: 128000,
        quantization: 'unknown',
        provider_slug: null,
        supports_implicit_caching: true,
        uptime_last_30m: 99.8,
        pricing: {prompt: '0.0000025', completion: '0.00001'},
      },
      {
        name: 'DeepInfra | openai/gpt-4o (turbo)',
        tag: 'deepinfra/turbo',
        provider_name: 'DeepInfra',
        context_length: 128000,
        quantization: 'fp8',
        provider_slug: null,
        supports_implicit_caching: true,
        uptime_last_30m: 98.12,
        pricing: {prompt: '0.0000015', completion: '0.000006'},
      },
    ],
  },
}

describe('parseModelEndpoints', () => {
  it('正常解析：tag → slug，provider_name → name，布尔与数值字段透传', () => {
    const providers = parseModelEndpoints(ENDPOINTS_RESPONSE)

    expect(providers).toHaveLength(3)
    expect(providers[0]).toEqual({
      slug: 'azure',
      name: 'Azure',
      supportsImplicitCaching: false,
      contextLength: 128000,
      uptimeLast30m: 99.95,
    })
    // provider_slug 为 null 时必须走 tag（不能把 null 当 slug）
    expect(providers[1].slug).toBe('openai')
    expect(providers[1].supportsImplicitCaching).toBe(true)
    // slug 里本身可含 "/"
    expect(providers[2].slug).toBe('deepinfra/turbo')
    expect(providers[2].name).toBe('DeepInfra')
    expect(providers[2].uptimeLast30m).toBe(98.12)
  })

  it('缺 tag 的条目被跳过', () => {
    const providers = parseModelEndpoints({
      data: {
        id: 'x/y',
        endpoints: [
          {name: 'No Tag', provider_name: 'Ghost'},
          {tag: '', provider_name: 'Empty Tag'},
          {tag: '   ', provider_name: 'Blank Tag'},
          {tag: 'ok', provider_name: 'OK'},
        ],
      },
    })
    expect(providers).toHaveLength(1)
    expect(providers[0].slug).toBe('ok')
  })

  it('provider_name 缺失 / 非字符串 → name 回退为 tag', () => {
    const providers = parseModelEndpoints({
      data: {
        id: 'x/y',
        endpoints: [
          {tag: 'a'},
          {tag: 'b', provider_name: ''},
          {tag: 'c', provider_name: 123},
        ],
      },
    })
    expect(providers.map(p => p.name)).toEqual(['a', 'b', 'c'])
  })

  it('同一 slug 去重（保留首条）', () => {
    const providers = parseModelEndpoints({
      data: {
        id: 'x/y',
        endpoints: [
          {tag: 'azure', provider_name: 'Azure', uptime_last_30m: 99.9},
          {tag: 'azure', provider_name: 'Azure (dup)', uptime_last_30m: 90},
          {tag: 'openai', provider_name: 'OpenAI'},
        ],
      },
    })
    expect(providers).toHaveLength(2)
    expect(providers.map(p => p.slug)).toEqual(['azure', 'openai'])
    expect(providers[0].name).toBe('Azure')
    expect(providers[0].uptimeLast30m).toBe(99.9)
  })

  it('可选数值字段非法（字符串 / NaN / 负数）→ 省略而非写入脏值', () => {
    const providers = parseModelEndpoints({
      data: {
        id: 'x/y',
        endpoints: [
          {tag: 'a', context_length: '128000', uptime_last_30m: 'abc'},
          {tag: 'b', context_length: NaN, uptime_last_30m: -1},
          {tag: 'c', context_length: 0, uptime_last_30m: 0},
        ],
      },
    })
    expect(providers[0].contextLength).toBeUndefined()
    expect(providers[0].uptimeLast30m).toBeUndefined()
    expect(providers[1].contextLength).toBeUndefined()
    expect(providers[1].uptimeLast30m).toBeUndefined()
    // 0 是合法数值（0 上下文/0 存活率虽罕见但非脏）
    expect(providers[2].contextLength).toBe(0)
    expect(providers[2].uptimeLast30m).toBe(0)
  })

  it('supports_implicit_caching 非布尔 → false', () => {
    const providers = parseModelEndpoints({
      data: {
        id: 'x/y',
        endpoints: [
          {tag: 'a', supports_implicit_caching: 'yes'},
          {tag: 'b', supports_implicit_caching: 1},
          {tag: 'c', supports_implicit_caching: true},
        ],
      },
    })
    expect(providers.map(p => p.supportsImplicitCaching)).toEqual([false, false, true])
  })

  it('endpoints 为空数组 / 缺失 / 非数组 → []', () => {
    expect(parseModelEndpoints({data: {id: 'x/y', endpoints: []}})).toEqual([])
    expect(parseModelEndpoints({data: {id: 'x/y'}})).toEqual([])
    expect(parseModelEndpoints({data: {id: 'x/y', endpoints: 'nope'}})).toEqual([])
    expect(parseModelEndpoints({data: {id: 'x/y', endpoints: {}}})).toEqual([])
  })

  it('顶层结构畸形 → []', () => {
    expect(parseModelEndpoints(null)).toEqual([])
    expect(parseModelEndpoints(undefined)).toEqual([])
    expect(parseModelEndpoints(42)).toEqual([])
    expect(parseModelEndpoints('not json')).toEqual([])
    expect(parseModelEndpoints({})).toEqual([])
    expect(parseModelEndpoints({data: null})).toEqual([])
    expect(parseModelEndpoints({data: 'x'})).toEqual([])
    expect(parseModelEndpoints({data: {endpoints: [{tag: 'a'}]}})).toEqual([
      {slug: 'a', name: 'a', supportsImplicitCaching: false},
    ]) // data 存在但无 id 也可解析（契约只要求结构够用）
  })

  it('条目非对象（null / 字符串）被跳过', () => {
    const providers = parseModelEndpoints({
      data: {id: 'x/y', endpoints: [null, 'x', 1, {tag: 'ok'}]},
    })
    expect(providers).toHaveLength(1)
    expect(providers[0].slug).toBe('ok')
  })
})

describe('baseModelSlug', () => {
  it('普通 id 原样返回', () => {
    expect(baseModelSlug('openai/gpt-4o')).toBe('openai/gpt-4o')
    expect(baseModelSlug('deepseek/deepseek-r1')).toBe('deepseek/deepseek-r1')
  })

  it('剥掉变体后缀（:nitro / :floor / :free）', () => {
    expect(baseModelSlug('deepseek/deepseek-r1:nitro')).toBe('deepseek/deepseek-r1')
    expect(baseModelSlug('deepseek/deepseek-r1:floor')).toBe('deepseek/deepseek-r1')
    expect(baseModelSlug('meta-llama/llama-3.3-70b-instruct:free')).toBe('meta-llama/llama-3.3-70b-instruct')
  })

  it('只剥最后一个 ":" 之后的变体后缀', () => {
    expect(baseModelSlug('a:b:nitro')).toBe('a:b')
  })

  it('空 / 非字符串 / 仅 trim → 安全降级', () => {
    expect(baseModelSlug('')).toBe('')
    expect(baseModelSlug('   ')).toBe('')
    expect(baseModelSlug('  openai/gpt-4o  ')).toBe('openai/gpt-4o')
    expect(baseModelSlug(':nitro')).toBe('')
    expect(baseModelSlug(undefined as unknown as string)).toBe('')
    expect(baseModelSlug(null as unknown as string)).toBe('')
  })
})
