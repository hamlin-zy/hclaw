import {describe, it, expect} from 'vitest'
import {computeContextUsage, resolvePrimaryModelName} from '@/main/agent/ipc/contextUsage'

describe('computeContextUsage', () => {
  it('空历史 + 无缓存 prompt：跳过发送前引导（ratio 0，无法估算真实 prompt）', () => {
    const r = computeContextUsage({history: [], cachedSystemPromptJson: null, scheme: {maxContextTokens: 128000}})
    expect(r.windowTokens).toBe(128000)
    expect(r.estimatedTokens).toBe(0)
    expect(r.ratio).toBe(0)
  })
  it('scheme 无窗口配置 → 默认 128K', () => {
    expect(computeContextUsage({history: [], scheme: null}).windowTokens).toBe(128000)
  })
  it('scheme.maxContextTokens 优先（1M）', () => {
    expect(computeContextUsage({history: [], scheme: {maxContextTokens: 1000000}}).windowTokens).toBe(1000000)
  })
  it('modelMetaContextLength > 0 覆盖默认 128K（or-models.json 权威）', () => {
    expect(computeContextUsage({history: [], scheme: null, modelMetaContextLength: 1000000}).windowTokens).toBe(1000000)
  })
  it('modelMetaContextLength > 0 且 scheme 有配置 → scheme 仍最优先', () => {
    expect(
      computeContextUsage({history: [], scheme: {maxContextTokens: 200000}, modelMetaContextLength: 1000000}).windowTokens,
    ).toBe(200000)
  })
  it('modelMetaContextLength = 0（or-models.json 未命中）→ 回退默认 128K', () => {
    expect(computeContextUsage({history: [], scheme: null, modelMetaContextLength: 0}).windowTokens).toBe(128000)
  })
  it('缓存 JSON 解析出 core 计入占比', () => {
    const r = computeContextUsage({
      history: [{role: 'user', content: 'x'.repeat(4000)}],
      cachedSystemPromptJson: JSON.stringify({core: 'y'.repeat(4000), commandTemplate: '', buildDate: '2026-08-18'}),
      scheme: {maxContextTokens: 128000},
    })
    expect(r.estimatedTokens).toBe(2000) // 4000/4 + 4000/4
    expect(r.ratio).toBeCloseTo(2000 / 128000, 5)
  })
  it('缓存 JSON 解析失败 → 跳过引导（ratio 0），不抛错', () => {
    const r = computeContextUsage({history: [], cachedSystemPromptJson: '{bad json', scheme: {maxContextTokens: 128000}})
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
      scheme: {maxContextTokens: 1000000},
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
      scheme: {maxContextTokens: 128000},
    })
    expect(r.estimatedTokens).toBe(5600)
  })

  it('llmStats 缺失（旧数据/新会话）→ 回退字符估算', () => {
    const r = computeContextUsage({
      history: [{role: 'user', content: 'x'.repeat(4000)}],
      cachedSystemPromptJson: JSON.stringify({core: 'y'.repeat(4000)}),
      scheme: {maxContextTokens: 128000},
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
})
