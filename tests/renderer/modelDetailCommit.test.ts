import {describe, it, expect} from 'vitest'
import {commitModelDetail, mergeOrTypesOnEdit} from '../../src/renderer/lib/modelDetailCommit'

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

describe('mergeOrTypesOnEdit · OR 预勾选转自定义（spec §2.2 placeholder 永不落库）', () => {
  it('并入 OR 命中集作为自定义编辑起点（去重）', () => {
    expect(mergeOrTypesOnEdit(['text'], ['text', 'image'])).toEqual(['text', 'image'])
    expect(mergeOrTypesOnEdit([], ['text', 'voice'])).toEqual(['text', 'voice'])
  })
  it('OR 命中集不直接落库：commit 仅写 draft.modelTypes（未手动编辑时保持初始化值）', () => {
    // 初始化为 model.modelTypes ?? []；OR 派生值只用于视觉预展示，未并入 draft
    const model = {...base, modelTypes: undefined}
    const next = commitModelDetail(model, {maxContextTokens: '', temperature: '', maxOutputTokens: '', modelTypes: []})
    expect(next.modelTypes).toBeUndefined()
  })
})
