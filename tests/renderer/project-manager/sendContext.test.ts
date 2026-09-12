import {describe, expect, it} from 'vitest'
import {buildContext, composeContent, type SendToConversationContext} from '../../../src/renderer/project-manager/lib/sendContext'

const WS = '/home/me/proj'

describe('buildContext', () => {
  it('files：每行一个绝对路径，顺序即传入顺序', () => {
    const ctx: SendToConversationContext = {kind: 'files', paths: ['src/a.ts', 'src/b.ts']}
    expect(buildContext(ctx, WS)).toBe('/home/me/proj/src/a.ts\n/home/me/proj/src/b.ts')
  })

  it('files：空数组 → 空串', () => {
    expect(buildContext({kind: 'files', paths: []}, WS)).toBe('')
  })

  it('lines：绝对路径 + 行号范围（无 revision）', () => {
    const ctx: SendToConversationContext = {kind: 'lines', filePath: 'src/a.ts', lineNumbers: [12, 13, 14, 18]}
    expect(buildContext(ctx, WS)).toBe('/home/me/proj/src/a.ts:12-14,18')
  })

  it('lines：带 revision 时插在路径与行号之间', () => {
    const ctx: SendToConversationContext = {kind: 'lines', filePath: 'src/a.ts', lineNumbers: [12], revision: 'abc1234'}
    expect(buildContext(ctx, WS)).toBe('/home/me/proj/src/a.ts@abc1234:12')
  })

  it('commits：固定前缀「commit：」+ 逗号分隔 hash（全角冒号）', () => {
    const ctx: SendToConversationContext = {kind: 'commits', hashes: ['abc1234', 'def5678']}
    expect(buildContext(ctx, WS)).toBe('commit：abc1234,def5678')
  })
})

describe('composeContent', () => {
  it('上下文与指令之间用单个换行分隔', () => {
    expect(composeContent('/home/me/proj/src/a.ts:12', '帮我重构这一段')).toBe(
      '/home/me/proj/src/a.ts:12\n帮我重构这一段',
    )
  })
})
