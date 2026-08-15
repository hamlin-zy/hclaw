/**
 * search 单元测试
 *
 * 覆盖模糊子序列匹配、搜索评分、通用过滤、评分排序过滤。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {
  fuzzyMatch,
  calcSearchScore,
  fuzzyFilter,
  fuzzyFilterWithRank,
} from '@/renderer/lib/search'

describe('fuzzyMatch', () => {
  it('任务描述中的 4 个示例', () => {
    expect(fuzzyMatch('codesim', 'code-simplifier')).toBe(true)
    expect(fuzzyMatch('csim', 'code-simplifier')).toBe(true)
    expect(fuzzyMatch('cxsim', 'code-simplifier')).toBe(false)
    expect(fuzzyMatch('sim', 'code-simplifier')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(fuzzyMatch('GIT', 'GitHub')).toBe(true)
    expect(fuzzyMatch('git', 'GITHUB')).toBe(true)
  })

  it('空 query 返回 true，空 target 返回 false', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true)
    expect(fuzzyMatch('a', '')).toBe(false)
    expect(fuzzyMatch('', '')).toBe(true)
  })
})

describe('calcSearchScore', () => {
  it('前缀匹配分数最高', () => {
    expect(calcSearchScore('code-simplifier', 'code')).toBe(100)
    expect(calcSearchScore('git status', 'git')).toBe(100)
  })

  it('包含匹配其次', () => {
    expect(calcSearchScore('my-code-simplifier', 'code')).toBe(80)
  })

  it('模糊匹配最低', () => {
    // 前缀命中优先于模糊：'csimplifier' 以 'csim' 开头 → 100
    expect(calcSearchScore('csimplifier', 'csim')).toBe(100)
    // 真正仅模糊命中的案例：字符按序但非前缀/非连续子串 → 60
    expect(calcSearchScore('code-simplifier', 'csim')).toBe(60)
  })

  it('不匹配返回 0', () => {
    expect(calcSearchScore('hello', 'xyz')).toBe(0)
  })

  it('空 query 或空文本返回 0', () => {
    expect(calcSearchScore('', 'git')).toBe(0)
    expect(calcSearchScore('text', '')).toBe(0)
    expect(calcSearchScore('text', '   ')).toBe(0)
    expect(calcSearchScore('', '')).toBe(0)
  })
})

describe('fuzzyFilter', () => {
  const items = [
    {id: 1, name: 'git-commit', description: 'create a commit', tags: ['git', 'vcs']},
    {id: 2, name: 'npm-install', description: 'install packages', tags: ['node', 'npm']},
    {id: 3, name: null as unknown as string, description: 'null name item', tags: []},
  ]

  it('多字段匹配', () => {
    const result = fuzzyFilter(items, 'commit', ['name', 'description'])
    expect(result.map(i => i.id)).toEqual([1])
  })

  it('数组字段（tags）展开匹配', () => {
    const result = fuzzyFilter(items, 'npm', ['name', 'tags'])
    expect(result.map(i => i.id)).toEqual([2])
  })

  it('null 安全：null 字段跳过不报错', () => {
    const result = fuzzyFilter(items, 'null', ['name', 'description'])
    expect(result.map(i => i.id)).toEqual([3])
  })

  it('空 query 返回原数组', () => {
    expect(fuzzyFilter(items, '', ['name'])).toBe(items)
    expect(fuzzyFilter(items, '   ', ['name'])).toBe(items)
  })

  it('无匹配返回空数组', () => {
    expect(fuzzyFilter(items, 'zzzz', ['name', 'description', 'tags'])).toEqual([])
  })
})

describe('fuzzyFilterWithRank', () => {
  const items = [
    {id: 1, name: 'code-simplifier', description: 'simplify code'},
    {id: 2, name: 'my-code-tool', description: 'code utilities'},
    {id: 3, name: 'other', description: 'unrelated stuff'},
  ]

  it('评分降序排列', () => {
    const result = fuzzyFilterWithRank(items, 'code', ['name', 'description'])
    expect(result.length).toBe(2)
    // name 前缀(100) > description 前缀(50)
    expect(result[0]!.item.id).toBe(1)
    expect(result[1]!.item.id).toBe(2)
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score)
  })

  it('name 倍率 1 vs 其他 0.5', () => {
    const result = fuzzyFilterWithRank(items, 'code', ['name', 'description'])
    const nameItem = result.find(r => r.item.id === 1)!
    // name 前缀 100 * 1 = 100
    expect(nameItem.score).toBe(100)
  })

  it('description 命中按 0.5 倍率', () => {
    const result = fuzzyFilterWithRank(items, 'simplify', ['name', 'description'])
    expect(result).toHaveLength(1)
    expect(result[0]!.item.id).toBe(1)
    // calcSearchScore 固定返回 NAME_* 分数（前缀=100），desc 经 0.5 倍率 → 50
    expect(result[0]!.score).toBe(100 * 0.5)
  })

  it('指定倍率 [["name",2]]', () => {
    const result = fuzzyFilterWithRank(items, 'code', [['name', 2]])
    expect(result).toHaveLength(2)
    expect(result[0]!.score).toBe(100 * 2)
  })

  it('空 query 返回所有 item 且 score 0', () => {
    const result = fuzzyFilterWithRank(items, '', ['name'])
    expect(result).toHaveLength(3)
    expect(result.every(r => r.score === 0)).toBe(true)
  })

  it('无匹配返回空数组', () => {
    expect(fuzzyFilterWithRank(items, 'zzzz', ['name', 'description'])).toEqual([])
  })
})
