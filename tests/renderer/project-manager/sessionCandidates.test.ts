import {describe, expect, it} from 'vitest'
import {pickSessionCandidates} from '../../../src/renderer/project-manager/lib/sessionCandidates'
import type {ConversationMeta} from '../../../src/shared/types/infra'

function conv(id: string, over: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id,
    title: id,
    workspacePath: '/ws',
    createdAt: 0,
    updatedAt: 0,
    preview: '',
    status: 'active',
    ...over,
  }
}

describe('pickSessionCandidates', () => {
  it('排除子会话（parentConvId 或 isChildSession）', () => {
    const out = pickSessionCandidates([
      conv('a'),
      conv('b', {parentConvId: 'a'}),
      conv('c', {isChildSession: true}),
    ])
    expect(out.map(c => c.id)).toEqual(['a'])
  })

  it('排除 scheduler 会话', () => {
    const out = pickSessionCandidates([conv('a'), conv('b', {sessionType: 'scheduler'})])
    expect(out.map(c => c.id)).toEqual(['a'])
  })

  it('交接链只保留链尾（排除被集合内其它会话引用的会话）', () => {
    // A ← B ← C：B.handoffFrom=A，C.handoffFrom=B → 只留 C
    const out = pickSessionCandidates([
      conv('a'),
      conv('b', {handoffFromConvId: 'a'}),
      conv('c', {handoffFromConvId: 'b'}),
    ])
    expect(out.map(c => c.id)).toEqual(['c'])
  })

  it('按 updatedAt 降序排列', () => {
    const out = pickSessionCandidates([
      conv('a', {updatedAt: 100}),
      conv('b', {updatedAt: 300}),
      conv('c', {updatedAt: 200}),
    ])
    expect(out.map(c => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('最多返回 20 条', () => {
    const many = Array.from({length: 25}, (_, i) => conv(`c${i}`, {updatedAt: i}))
    expect(pickSessionCandidates(many)).toHaveLength(20)
  })

  it('handoffFromConvId 指向集合外的会话不影响结果', () => {
    const out = pickSessionCandidates([conv('a'), conv('b', {handoffFromConvId: '外部id'})])
    expect(out.map(c => c.id).sort()).toEqual(['a', 'b'])
  })
})
