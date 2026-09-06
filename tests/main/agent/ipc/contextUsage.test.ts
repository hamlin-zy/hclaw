import {describe, it, expect} from 'vitest'
import {computeContextUsage, resolvePrimaryModelName, resolvePrimaryModelParams} from '@/main/agent/ipc/contextUsage'

describe('computeContextUsage', () => {
  it('空历史 + 无缓存 prompt：跳过发送前引导（ratio 0，无法估算真实 prompt）', () => {
    const r = computeContextUsage({history: [], cachedSystemPromptJson: null})
    expect(r.windowTokens).toBe(1000000)
    expect(r.estimatedTokens).toBe(0)
    expect(r.ratio).toBe(0)
  })
  it('无 modelMetaContextLength → 默认 1M', () => {
    expect(computeContextUsage({history: []}).windowTokens).toBe(1000000)
  })
  it('modelMetaContextLength > 0 覆盖默认 1M（or-models.json 权威）', () => {
    expect(computeContextUsage({history: [], modelMetaContextLength: 200000}).windowTokens).toBe(200000)
  })
  it('modelMetaContextLength = 0（or-models.json 未命中）→ 回退默认 1M', () => {
    expect(computeContextUsage({history: [], modelMetaContextLength: 0}).windowTokens).toBe(1000000)
  })
  it('缓存 JSON 解析出 core 计入占比', () => {
    const r = computeContextUsage({
      history: [{role: 'user', content: 'x'.repeat(4000)}],
      cachedSystemPromptJson: JSON.stringify({core: 'y'.repeat(4000), commandTemplate: '', buildDate: '2026-08-18'}),
    })
    expect(r.estimatedTokens).toBe(2000) // 4000/4 + 4000/4
    expect(r.ratio).toBeCloseTo(2000 / 1000000, 5)
  })
  it('缓存 JSON 解析失败 → 跳过引导（ratio 0），不抛错', () => {
    const r = computeContextUsage({history: [], cachedSystemPromptJson: '{bad json'})
    expect(r.estimatedTokens).toBe(0)
    expect(r.ratio).toBe(0)
  })

  // ── 分子校准：历史携带 llmStats 时优先真实 usage（与 UI 徽章同口径） ──
  it('assistant 消息携带 llmStats → 分子 = 末次请求 inputTokens + cacheReadTokens（真实 usage 优先于字符估算）', () => {
    const r = computeContextUsage({
      history: [
        {role: 'user', content: 'x'.repeat(40000)}, // 字符估算会算 10000，若误用估算则暴露
        {role: 'assistant', content: 'ok', llmStats: [{inputTokens: 300000, outputTokens: 100, provider: 'or', model: 'm', duration: 1, cacheReadTokens: 4600}]},
      ],
      cachedSystemPromptJson: JSON.stringify({core: 'y'.repeat(4000)}),
    })
    expect(r.estimatedTokens).toBe(304600) // 300000 + 4600，而非字符估算值
  })

  it('多条 llmStats → 取最后一条（最近一次请求口径）', () => {
    const r = computeContextUsage({
      history: [
        {role: 'assistant', content: 'a', llmStats: [{inputTokens: 1000, outputTokens: 1, provider: 'or', model: 'm', duration: 1}]},
        {role: 'assistant', content: 'b', llmStats: [{inputTokens: 5000, outputTokens: 1, provider: 'or', model: 'm', duration: 1, cacheReadTokens: 600}]},
      ],
      cachedSystemPromptJson: JSON.stringify({core: 'y'.repeat(4000)}),
    })
    expect(r.estimatedTokens).toBe(5600)
  })

  it('llmStats 缺失（旧数据/新会话）→ 回退字符估算', () => {
    const r = computeContextUsage({
      history: [{role: 'user', content: 'x'.repeat(4000)}],
      cachedSystemPromptJson: JSON.stringify({core: 'y'.repeat(4000)}),
    })
    expect(r.estimatedTokens).toBe(2000) // 4000/4 + 4000/4
  })

  // ── 分母修复：primary role 需解析为模型名再查 registry（UUID 查不到） ──
  it('resolvePrimaryModelName：endpointId+modelId → 模型名；未命中 → 空串', () => {
    const scheme = {roles: [{role: 'primary', endpointId: 'ep1', modelId: 'm1', enabled: true}]} as never
    const providers = [
      {id: 'ep1', models: [{id: 'm0', name: 'wrong-model'}, {id: 'm1', name: 'z-ai/glm-4.7'}]},
    ] as never
    expect(resolvePrimaryModelName(scheme, providers)).toBe('z-ai/glm-4.7')
    expect(resolvePrimaryModelName(null, providers)).toBe('')
    expect(resolvePrimaryModelName(scheme, [])).toBe('')
  })

  // ── spec §6.3 口径统一：primary 模型 per-model 参数 → 分母与 execute.ts handoff gate 一致 ──
  describe('resolvePrimaryModelParams', () => {
    const scheme = {roles: [{role: 'primary', endpointId: 'ep1', modelId: 'm1', enabled: true}]} as never

    it('primary 模型配置自定义 maxContextTokens → 返回 modelParams', () => {
      const providers = [
        {id: 'ep1', enabled: true, models: [{id: 'm1', name: 'm', maxContextTokens: 128000}]},
      ] as never
      expect(resolvePrimaryModelParams(scheme, providers)).toEqual({maxContextTokens: 128000, temperature: undefined, maxOutputTokens: undefined})
    })
    it('三项参数均未配置 → undefined（走 OpenRouter/兜底）', () => {
      const providers = [{id: 'ep1', enabled: true, models: [{id: 'm1', name: 'm'}]}] as never
      expect(resolvePrimaryModelParams(scheme, providers)).toBeUndefined()
    })
    it('provider 未启用 / 模型未命中 → undefined', () => {
      const disabled = [{id: 'ep1', enabled: false, models: [{id: 'm1', name: 'm', maxContextTokens: 128000}]}] as never
      const missing = [{id: 'ep1', enabled: true, models: [{id: 'm0', name: 'm', maxContextTokens: 128000}]}] as never
      expect(resolvePrimaryModelParams(scheme, disabled)).toBeUndefined()
      expect(resolvePrimaryModelParams(scheme, missing)).toBeUndefined()
    })
  })

  it('modelParams 自定义 128k → windowTokens=128000（custom 优先于 modelMeta）', () => {
    const r = computeContextUsage({
      history: [],
      modelMetaContextLength: 200000,
      modelParams: {maxContextTokens: 128000},
    })
    expect(r.windowTokens).toBe(128000)
  })
  it('无 modelParams → OpenRouter（modelMeta）→ 兜底 1M 口径不变', () => {
    expect(computeContextUsage({history: [], modelMetaContextLength: 200000}).windowTokens).toBe(200000)
    expect(computeContextUsage({history: []}).windowTokens).toBe(1000000)
  })
})
