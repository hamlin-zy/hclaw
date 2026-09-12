import {describe, it, expect} from 'vitest'
import {STATUS_SPEC, dominantStatus} from '../../../src/renderer/project-manager/lib/statusColor'

describe('STATUS_SPEC §3.1 三重编码', () => {
  it('六种状态的字母与颜色令牌逐项正确', () => {
    expect(STATUS_SPEC.none.letter).toBe('')
    expect(STATUS_SPEC.none.color).toBe('var(--text-primary)')

    expect(STATUS_SPEC.M).toMatchObject({letter: 'M', color: 'var(--vcs-modified)', fontWeight: 'bold'})
    expect(STATUS_SPEC.A).toMatchObject({letter: 'A', color: 'var(--vcs-added)'})
    expect(STATUS_SPEC.D).toMatchObject({letter: 'D', color: 'var(--vcs-deleted)', textDecoration: 'line-through'})
    expect(STATUS_SPEC.R).toMatchObject({letter: 'R', color: 'var(--vcs-renamed)'})
    expect(STATUS_SPEC['??']).toMatchObject({letter: '??', color: 'var(--vcs-untracked)', fontStyle: 'italic'})
  })

  it('五种有状态项各带非空 aria-label（色盲可辨，§13.7）', () => {
    for (const key of ['M', 'A', 'D', 'R', '??'] as const) {
      expect(STATUS_SPEC[key].ariaLabel, key).toBeTruthy()
    }
    expect(STATUS_SPEC.none.ariaLabel).toBe('')
  })

  it('颜色一律为令牌（不得出现 hex）', () => {
    for (const spec of Object.values(STATUS_SPEC)) {
      expect(spec.color).toMatch(/^var\(--[a-z-]+\)$/)
    }
  })

  it('M 的颜色与 none 不同（回归：旧 STATUS_STYLE 的 #BBBBBB 在浅色主题下不可见）', () => {
    expect(STATUS_SPEC.M.color).not.toBe(STATUS_SPEC.none.color)
  })
})

describe('dominantStatus §6.2 目录染色优先级 D > M > R > A > ??', () => {
  it('单状态直接返回', () => {
    expect(dominantStatus(['M'])).toBe('M')
    expect(dominantStatus(['??'])).toBe('??')
  })

  it('多状态取优先级最高者', () => {
    expect(dominantStatus(['??', 'A', 'M'])).toBe('M')
    expect(dominantStatus(['A', '??'])).toBe('A')
    expect(dominantStatus(['M', 'D'])).toBe('D')
    expect(dominantStatus(['A', 'R', 'M'])).toBe('M')
    expect(dominantStatus(['A', 'R'])).toBe('R')
  })

  it('全为 none 或空数组返回 null', () => {
    expect(dominantStatus(['none'])).toBeNull()
    expect(dominantStatus([])).toBeNull()
    expect(dominantStatus(['none', 'none'])).toBeNull()
  })
})
