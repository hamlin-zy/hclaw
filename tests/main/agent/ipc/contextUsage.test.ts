import {describe, it, expect} from 'vitest'
import {computeContextUsage} from '@/main/agent/ipc/contextUsage'

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
})
