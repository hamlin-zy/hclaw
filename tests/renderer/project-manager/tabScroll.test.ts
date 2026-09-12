// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {computeTabScrollLeft} from '../../../src/renderer/project-manager/utils/tabScroll'

/**
 * 纯函数单测：直接喂数值几何，比在 jsdom 里伪造元素布局更可靠
 * （jsdom 无布局引擎，rect 全零，在组件里造几何等于自证）。
 */
describe('computeTabScrollLeft（tab 条最小滚动）', () => {
  const container = {left: 0, right: 100}

  it('tab 右边缘超出容器右侧 → 向右滚动到右边缘贴齐', () => {
    expect(computeTabScrollLeft(container, {left: 110, right: 160}, 0)).toBe(60)
  })

  it('tab 左边缘超出容器左侧 → 向左滚动到左边缘贴齐', () => {
    expect(computeTabScrollLeft(container, {left: -30, right: 20}, 0)).toBe(-30)
  })

  it('已有滚动量时增量叠加（向右）', () => {
    expect(computeTabScrollLeft(container, {left: 130, right: 180}, 80)).toBe(160)
  })

  it('tab 完全可见 → scrollLeft 不变（最小滚动，不居中）', () => {
    expect(computeTabScrollLeft(container, {left: 10, right: 50}, 0)).toBe(0)
    expect(computeTabScrollLeft(container, {left: 40, right: 100}, 33)).toBe(33)
  })

  it('两侧都恰好贴边 → 不变', () => {
    expect(computeTabScrollLeft(container, {left: 0, right: 100}, 0)).toBe(0)
  })

  it('jsdom 全零几何（不可滚动/无布局）→ no-op 且不抛错', () => {
    expect(computeTabScrollLeft({left: 0, right: 0}, {left: 0, right: 0}, 0)).toBe(0)
  })

  it('左越界优先于右越界（tab 比容器宽时），保证左边缘可见', () => {
    expect(computeTabScrollLeft({left: 0, right: 100}, {left: -10, right: 200}, 0)).toBe(-10)
  })
})
