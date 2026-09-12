/**
 * F1：appendAuthorToken 语义锁定
 *
 * 下拉候选是按「最后一个逗号片段」过滤的，因此该片段必然是半截输入，
 * 选中后必须整体替换为选中值（而不是 split→去重→push 把半截输入也留下）。
 * 末尾保留 ", " 以便继续输入下一位作者。
 */
import {describe, it, expect} from 'vitest'
import {appendAuthorToken} from '../../../src/renderer/project-manager/ui/AuthorFilterSelect'

describe('appendAuthorToken：整体替换最后一段半截输入', () => {
  it('空输入 → 选中值 + 尾随 ", "', () => {
    expect(appendAuthorToken('', 'Bob')).toBe('Bob, ')
  })

  it('半截输入被整体替换（不留 "bo, Bob"）', () => {
    expect(appendAuthorToken('bo', 'Bob')).toBe('Bob, ')
  })

  it('保留已确认的前缀片段，仅替换最后一段', () => {
    expect(appendAuthorToken('alice, bob', 'bobby')).toBe('alice, bobby, ')
  })

  it('选中值已是完整片段时不重复，仅丢掉半截片段', () => {
    expect(appendAuthorToken('alice, ', 'alice')).toBe('alice, ')
  })
})
