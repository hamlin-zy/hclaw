import {describe, expect, it} from 'vitest'
import {resolveCommandTemplate} from '../../../../src/main/agent/loop/controller'

/** R2：命令模板不得从 DB 缓存回退——仅当轮有新命令时才传模板，否则普通轮永久残留模板 */
describe('resolveCommandTemplate（R2 残留修复）', () => {
  it('本轮有新命令 → 使用新命令模板', () => {
    expect(resolveCommandTemplate({commandTemplate: 'NEW'}, {core: 'x', commandTemplate: 'OLD'})).toBe('NEW')
  })

  it('本轮无命令但缓存有旧模板 → 空串（不回退缓存值）', () => {
    expect(resolveCommandTemplate(null, {core: 'x', commandTemplate: 'OLD'})).toBe('')
  })

  it('本轮无命令且无缓存 → 空串', () => {
    expect(resolveCommandTemplate(null, undefined)).toBe('')
  })

  it('新命令模板为空串 → 空串（?? 不会落到缓存）', () => {
    expect(resolveCommandTemplate({commandTemplate: ''}, {core: 'x', commandTemplate: 'OLD'})).toBe('')
  })
})
