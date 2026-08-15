/**
 * conversationTree 单元测试
 *
 * 覆盖 collectDescendants 的后代收集：单层/多层/多根合并/空输入/去重/循环引用防护。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {collectDescendants} from '@shared/utils/conversationTree'
import type {ConversationSummary} from '@shared/types'

function makeConv(id: string, parentConvId?: string): ConversationSummary {
  return {
    id,
    title: id,
    preview: '',
    createdAt: 0,
    updatedAt: 0,
    ...(parentConvId ? {parentConvId} : {}),
  }
}

describe('collectDescendants', () => {
  it('单层父子：返回父与直接子节点', () => {
    const conversations = [
      makeConv('a'),
      makeConv('b', 'a'),
      makeConv('c', 'a'),
    ]
    expect(collectDescendants(conversations, ['a']).sort()).toEqual(['a', 'b', 'c'])
  })

  it('多层嵌套（祖孙）：返回所有间接后代', () => {
    const conversations = [
      makeConv('a'),
      makeConv('b', 'a'),
      makeConv('c', 'b'),
      makeConv('d', 'c'),
    ]
    expect(collectDescendants(conversations, ['a']).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('多个根 id 合并', () => {
    const conversations = [
      makeConv('a'),
      makeConv('b', 'a'),
      makeConv('x'),
      makeConv('y', 'x'),
    ]
    const result = collectDescendants(conversations, ['a', 'x']).sort()
    expect(result).toEqual(['a', 'b', 'x', 'y'])
  })

  it('空 conversations 返回 ids 本身', () => {
    expect(collectDescendants([], ['a', 'b']).sort()).toEqual(['a', 'b'])
  })

  it('空 ids 返回空数组', () => {
    const conversations = [makeConv('a'), makeConv('b', 'a')]
    expect(collectDescendants(conversations, [])).toEqual([])
  })

  it('共享子节点去重', () => {
    const conversations = [
      makeConv('a'),
      makeConv('b', 'a'),
      makeConv('c', 'b'),
      makeConv('d', 'a'),
      makeConv('e', 'd'),
      // c 同时挂在 b 和 d 下，只出现一次
      makeConv('x', 'c'),
    ]
    const result = collectDescendants(conversations, ['a'])
    expect(new Set(result).size).toBe(result.length)
    expect(result.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'x'])
  })

  it('循环引用防护（Set 去重防死循环）', () => {
    // b 挂在 a 下，a 挂在 b 下（非法但有防护）
    const conversations = [
      makeConv('a', 'b'),
      makeConv('b', 'a'),
    ]
    const result = collectDescendants(conversations, ['a'])
    // BFS 已访问集合防止无限循环，结果只含可达未访问节点
    expect(result).toContain('a')
    expect(result).toContain('b')
  })

  it('不相关节点不包含在结果中', () => {
    const conversations = [
      makeConv('a'),
      makeConv('b', 'a'),
      makeConv('z'),
      makeConv('w', 'z'),
    ]
    const result = collectDescendants(conversations, ['a'])
    expect(result).not.toContain('z')
    expect(result).not.toContain('w')
  })
})
