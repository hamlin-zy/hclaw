import {describe, it, expect, vi, beforeEach} from 'vitest'
import {parseLog, getGitLog} from '../../../src/main/project-manager/git/log'
import {gitExec} from '../../../src/main/project-manager/git/gitExec'

vi.mock('../../../src/main/project-manager/git/gitExec', () => ({
  gitExec: vi.fn(async () => ''),
}))

// %D 真实形态：同一字段承载 HEAD -> / 远端 / tag: 前缀
const RAW = [
  '<abc123def|def456abc|Alice|alice@x.com|1700000000|1700000000|HEAD -> main, origin/main, tag: v1.0, tag: v0.9|subject line|body text',
  '<bbb222|ccc333|Bob|bob@x.com|1699000000|1699000000|||merge subject|',
].join('\n') + '\n'

describe('parseLog', () => {
  it('解析字段与 HEAD/branches/tags（tag: 剥离与 HEAD -> 映射共存）', () => {
    const entries = parseLog(RAW)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.hash).toBe('abc123def')
    expect(entries[0]!.parents).toEqual(['def456abc'])
    expect(entries[0]!.isHead).toBe(true)
    expect(entries[0]!.branches).toEqual(['main', 'origin/main'])
    expect(entries[0]!.tags).toEqual(['v1.0', 'v0.9'])
    expect(entries[0]!.abbreviatedHash).toBe(entries[0]!.hash.slice(0, 9))
  })
  it('无 refs 时 branches/tags 为空数组', () => {
    const entries = parseLog(RAW)
    expect(entries[1]!.branches).toEqual([])
    expect(entries[1]!.tags).toEqual([])
  })
  it('空输入返回空数组', () => {
    expect(parseLog('')).toEqual([])
  })
})

describe('getGitLog filterText', () => {
  beforeEach(() => {
    vi.mocked(gitExec).mockClear()
  })

  it('fixed-strings 模式：grep 原样传递，不加转义', async () => {
    await getGitLog('E:\\repo', {limit: 10, filterText: 'a.b(c)', filterFlags: {}})
    const args = vi.mocked(gitExec).mock.calls[0]![1]
    expect(args).toContain('--grep=a.b(c)')
    expect(args).toContain('--fixed-strings')
    expect(args).not.toContain('--grep=a\\.b\\(c\\)')
  })

  it('regex 模式：grep 原样传递，不传 --fixed-strings', async () => {
    await getGitLog('E:\\repo', {limit: 10, filterText: 'fix:\\s+.+', filterFlags: {regex: true}})
    const args = vi.mocked(gitExec).mock.calls[0]![1]
    expect(args).toContain('--grep=fix:\\s+.+')
    expect(args).not.toContain('--fixed-strings')
  })
})
