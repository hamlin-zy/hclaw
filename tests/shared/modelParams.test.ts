import {describe, it, expect} from 'vitest'
import {resolveModelParams, resolveModelModalities, DEFAULT_MAX_CONTEXT_TOKENS} from '../../src/shared/modelParams'

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
