import {describe, it, expect} from 'vitest'
import {resolveModelParams, resolveModelModalities, hasCustomParams, DEFAULT_MAX_CONTEXT_TOKENS} from '../../src/shared/modelParams'

const settings = (temperature = 0.7, maxTokens = 50_000) =>
  ({model: {defaultTemperature: temperature, defaultMaxTokens: maxTokens}}) as any

describe('resolveModelParams · 最大上下文', () => {
  it('自定义最高优先级（覆盖 OpenRouter 有值）', () => {
    const r = resolveModelParams({maxContextTokens: 128_000}, settings(), 200_000)
    expect(r.maxContextTokens).toEqual({value: 128_000, source: 'custom'})
  })
  it('未自定义 → OpenRouter 命中', () => {
    const r = resolveModelParams(undefined, settings(), 200_000)
    expect(r.maxContextTokens).toEqual({value: 200_000, source: 'openrouter'})
  })
  it('OpenRouter 0（未命中）→ 1M 兜底', () => {
    const r = resolveModelParams({}, settings(), 0)
    expect(r.maxContextTokens).toEqual({value: DEFAULT_MAX_CONTEXT_TOKENS, source: 'fallback'})
  })
  it('负值视为未配置（同 0）', () => {
    expect(resolveModelParams({}, settings(), -5).maxContextTokens.source).toBe('fallback')
  })
})

describe('resolveModelParams · 温度', () => {
  it('自定义最高优先级', () => {
    expect(resolveModelParams({temperature: 0.6}, settings(0.7), 0).temperature)
      .toEqual({value: 0.6, source: 'custom'})
  })
  it('未自定义 → 系统设置（无兜底层）', () => {
    expect(resolveModelParams(undefined, settings(0.7), 0).temperature)
      .toEqual({value: 0.7, source: 'settings'})
  })
  it('settings 缺失 → defaultTemperature 默认 0，source=settings', () => {
    expect(resolveModelParams(undefined, undefined, 0).temperature)
      .toEqual({value: 0, source: 'settings'})
  })
})

describe('resolveModelParams · 最大输出', () => {
  it('自定义最高优先级', () => {
    expect(resolveModelParams({maxOutputTokens: 8192}, settings(0.7, 50_000), 0).maxOutputTokens)
      .toEqual({value: 8192, source: 'custom'})
  })
  it('未自定义 → 系统设置', () => {
    expect(resolveModelParams(undefined, settings(0.7, 50_000), 0).maxOutputTokens)
      .toEqual({value: 50_000, source: 'settings'})
  })
})

describe('resolveModelModalities', () => {
  it('自定义 modelTypes 含 image → supportsImage（source=custom）', () => {
    expect(resolveModelModalities(['text', 'image'], ['text'], 'gpt-x'))
      .toEqual({supportsImage: true, source: 'custom'})
  })
  it('自定义排除 image（registry 有）→ false（source=custom）', () => {
    expect(resolveModelModalities(['text'], ['text', 'image'], 'gpt-x').supportsImage).toBe(false)
  })
  it('自定义含 multimodal → 视同支持图片（source=custom）', () => {
    expect(resolveModelModalities(['multimodal'], null, 'gpt-x'))
      .toEqual({supportsImage: true, source: 'custom'})
  })
  it('自定义 text+multimodal 组合 → 视同支持图片（source=custom）', () => {
    expect(resolveModelModalities(['text', 'multimodal'], null, 'gpt-x'))
      .toEqual({supportsImage: true, source: 'custom'})
  })
  it('无自定义 → OpenRouter modalities 判定（source=openrouter）', () => {
    expect(resolveModelModalities(undefined, ['text', 'image'], 'gpt-x'))
      .toEqual({supportsImage: true, source: 'openrouter'})
  })
  it('两者皆无 → 命名模式推断（source=fallback）', () => {
    expect(resolveModelModalities(undefined, null, 'gpt-4o').supportsImage).toBe(true)
    expect(resolveModelModalities(undefined, null, 'deepseek-chat').supportsImage).toBe(false)
  })
})

describe('hasCustomParams · 齿轮橙点判定', () => {
  it('全部为空 → false', () => {
    expect(hasCustomParams({} as any)).toBe(false)
  })
  it('有运行时参数 → true', () => {
    expect(hasCustomParams({temperature: 0.6} as any)).toBe(true)
    expect(hasCustomParams({maxContextTokens: 128000} as any)).toBe(true)
  })
  it('有自定义价格（正值）→ true', () => {
    expect(hasCustomParams({pricing: {input: 1}} as any)).toBe(true)
    expect(hasCustomParams({pricing: {output: 5, cacheRead: 1}} as any)).toBe(true)
  })
  it('价格全填 0（用户手动输入）→ true', () => {
    // fix #1 后 lookupMeta 缺失价格返回 undefined（非 0），fillSingleRow 用 >0 守卫永不设 0，
    // pricing 中的 0 值仅来自用户手动输入，应算自定义（免费语义）
    expect(hasCustomParams({pricing: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}} as any)).toBe(true)
    expect(hasCustomParams({pricing: {input: 0}} as any)).toBe(true)
  })
  it('pricing 为 undefined（无价格）→ false', () => {
    expect(hasCustomParams({pricing: undefined} as any)).toBe(false)
  })
  it('pricing 为空对象（无字段）→ false', () => {
    expect(hasCustomParams({pricing: {}} as any)).toBe(false)
  })
  it('有自定义 modelTypes → true', () => {
    expect(hasCustomParams({modelTypes: ['text']} as any)).toBe(true)
    expect(hasCustomParams({modelTypes: ['text', 'image']} as any)).toBe(true)
  })
  it('modelTypes 空数组 → false', () => {
    expect(hasCustomParams({modelTypes: []} as any)).toBe(false)
  })
  it('组合：任意一项为 true 即 true', () => {
    expect(hasCustomParams({temperature: 0.5, pricing: {input: 0}, modelTypes: ['text']} as any)).toBe(true)
    expect(hasCustomParams({maxContextTokens: 100, modelTypes: []} as any)).toBe(true)
  })
})
