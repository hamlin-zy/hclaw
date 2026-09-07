import {describe, it, expect} from 'vitest'
import {commitModelDetail} from '../../src/renderer/lib/modelDetailCommit'
import {hasCustomParams} from '../../src/shared/modelParams'

const base = {id: 'm1', name: 'gpt-x', enabled: true} as any

describe('commitModelDetail · 保存过滤（spec §2.2）', () => {
  it('留空字段不落库（undefined，非 0 非 NaN）', () => {
    const next = commitModelDetail(base, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: []})
    expect(next.maxContextTokens).toBeUndefined()
    expect(next.temperature).toBeUndefined()
    expect(next.maxOutputTokens).toBeUndefined()
  })
  it('仅填写的字段落库（部分填写）', () => {
    const next = commitModelDetail(base, {maxContextTokens: '', temperature: '0.6', maxOutputTokens: '', modelTypes: []})
    expect(next.temperature).toBe(0.6)
    expect(next.maxContextTokens).toBeUndefined()
  })
  it('填写 0 为合法自定义值（温度下界）', () => {
    const next = commitModelDetail(base, {maxContextTokens: '', temperature: '0', maxOutputTokens: '', modelTypes: []})
    expect(next.temperature).toBe(0)
  })
  it('modelTypes 空数组 → undefined；非空 → 数组落库', () => {
    expect(commitModelDetail(base, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: []}).modelTypes).toBeUndefined()
    expect(commitModelDetail(base, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: ['text']}).modelTypes).toEqual(['text'])
  })
  it('非法值（负数/超范围）由 validate 拒绝，commit 不静默钳制', () => {
    expect(() => commitModelDetail(base, {maxContextTokens: '-1', temperature: '', maxOutputTokens: '', modelTypes: []})).toThrow()
  })
  it('name/其他既有字段原样保留', () => {
    const next = commitModelDetail({...base, pricing: {input: 1}}, {maxContextTokens: '100', temperature: '', maxOutputTokens: '', modelTypes: []})
    expect(next.name).toBe('gpt-x')
    expect(next.pricing).toEqual({input: 1})
    expect(next.maxContextTokens).toBe(100)
  })
  it('温度超过 2 位小数抛错（不静默钳制）', () => {
    expect(() => commitModelDetail(base, {maxContextTokens: '', temperature: '0.123', maxOutputTokens: '', modelTypes: []})).toThrow(/2 位小数/)
  })
  it('温度恰好 2 位小数合法', () => {
    expect(commitModelDetail(base, {maxContextTokens: '', temperature: '0.12', maxOutputTokens: '', modelTypes: []}).temperature).toBe(0.12)
  })
  it('温度超出上界（3 > 2）被 validate/commit 拒绝', () => {
    expect(() => commitModelDetail(base, {maxContextTokens: '', temperature: '3', maxOutputTokens: '', modelTypes: []})).toThrow(/0-2/)
  })
})

describe('OR 预展示不落库（spec §2.2 placeholder 永不落库）', () => {
  it('未手动编辑时 draft.modelTypes 保持初始化值（[]），commit → undefined', () => {
    // 模拟：modelTypes 为空 + OR 命中 ['text','image']，用户未点任何 chip 即确定
    const model = {...base, modelTypes: undefined}
    const next = commitModelDetail(model, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: []})
    expect(next.modelTypes).toBeUndefined()
    expect(hasCustomParams(next)).toBe(false)
  })
  it('仅手动勾选的类类型落库（OR 建议不自动并入）', () => {
    // 模拟：modelTypes 为空 + OR 命中 ['text','image']，用户仅点击 'multimodal'
    // 修复后：draft = ['multimodal']（不并入 OR 的 text/image）
    const next = commitModelDetail({...base, modelTypes: undefined}, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: ['multimodal']})
    expect(next.modelTypes).toEqual(['multimodal'])
    expect(hasCustomParams(next)).toBe(true)
  })
  it('复原：清空 modelTypes 后 hasCustomParams 返回 false（红点消失）', () => {
    // 模拟：modelTypes=['multimodal'] → 用户取消勾选 → draft=[] → commit → undefined
    const next = commitModelDetail({...base, modelTypes: ['multimodal']}, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: []})
    expect(next.modelTypes).toBeUndefined()
    expect(hasCustomParams(next)).toBe(false)
  })
})
