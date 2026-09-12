import {describe, it, expect, vi, beforeEach} from 'vitest'
const mockGit = vi.fn()
vi.mock('../../../src/main/project-manager/git/gitExec', () => ({gitExec: (...a: unknown[]) => mockGit(...a)}))
import {getBranches} from '../../../src/main/project-manager/git/branches'

describe('getBranches', () => {
  beforeEach(() => {
    mockGit.mockReset()
  })
  it('解析 local/remote/tag 并标记当前分支', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'rev-parse') return 'develop\n'
      if (args.includes('branch')) {
        // `branch -a --format=%(refname) %(refname:short) %(objectname)` 每行 = `<full refname> <short refname> <40 位 objectname>`
        // `git branch --format` 不输出 `* ` 前缀，当前分支由 rev-parse --abbrev-ref HEAD 判定。
        return [
          'refs/heads/develop develop abcdef1234567890abcdef1234567890abcdef12',
          'refs/heads/main main fedcba0987654321fedcba0987654321fedcba09',
          'refs/remotes/origin/main origin/main 1234567890abcdef1234567890abcdef12345678',
          'refs/remotes/origin/develop origin/develop 87654321abcdef1234567890abcdef12345678',
        ].join('\n') + '\n'
      }
      return 'v0.5.12 9999888877776666555544443333222211110000\n'
    })
    const nodes = await getBranches('/ws')
    const localDevelop = nodes.find(n => n.name === 'develop' && n.type === 'local')!
    expect(localDevelop.isCurrent).toBe(true)
    expect(localDevelop.hash).toBe('abcdef1234567890abcdef1234567890abcdef12')
    const localMain = nodes.find(n => n.name === 'main' && n.type === 'local')!
    expect(localMain.isCurrent).toBe(false)
    expect(localMain.hash).toBe('fedcba0987654321fedcba0987654321fedcba09')
    const remoteMain = nodes.find(n => n.name === 'origin/main')!
    expect(remoteMain.isRemote).toBe(true)
    expect(remoteMain.type).toBe('remote')
    expect(remoteMain.remoteName).toBe('origin')
    expect(remoteMain.hash).toBe('1234567890abcdef1234567890abcdef12345678')
    const tag = nodes.find(n => n.name === 'v0.5.12')!
    expect(tag.type).toBe('tag')
    expect(tag.hash).toBe('9999888877776666555544443333222211110000')
  })

  it('name 字段不夹带 objectname（40 位 hash 归 hash 字段）', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'rev-parse') return ''
      if (args.includes('branch')) return 'refs/heads/main main abcdef1234567890abcdef1234567890abcdef12\n'
      return ''
    })
    const nodes = await getBranches('/ws')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.name).toBe('main')
    expect(nodes[0]!.name).not.toMatch(/[0-9a-f]{40}/)
    expect(nodes[0]!.hash).toBe('abcdef1234567890abcdef1234567890abcdef12')
  })

  it('含 `/` 的本地分支仍归为 local，且可作为 current', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'rev-parse') return 'feat/project-manager-window\n'
      if (args.includes('branch')) {
        return [
          'refs/heads/feat/project-manager-window feat/project-manager-window f7564bdf4bf219616f7e613cf4d61d99df186840',
          'refs/heads/main main d8d6536cb3901b1dcd2d50941f1fd6e102ec8b77',
        ].join('\n') + '\n'
      }
      return ''
    })
    const nodes = await getBranches('/ws')
    const feat = nodes.find(n => n.name === 'feat/project-manager-window')!
    expect(feat.type).toBe('local')
    expect(feat.isRemote).toBe(false)
    expect(feat.remoteName).toBeUndefined()
    expect(feat.isCurrent).toBe(true)
    expect(feat.hash).toBe('f7564bdf4bf219616f7e613cf4d61d99df186840')
  })

  it('跳 refs/remotes/*/HEAD（符号引用不产生幽灵分支）', async () => {
    mockGit.mockImplementation(async (_ws, args) => {
      if (args[0] === 'rev-parse') return 'main\n'
      if (args.includes('branch')) {
        return [
          'refs/heads/main main d8d6536cb3901b1dcd2d50941f1fd6e102ec8b77',
          'refs/remotes/origin/HEAD origin d8d6536cb3901b1dcd2d50941f1fd6e102ec8b77',
          'refs/remotes/origin/main origin/main d8d6536cb3901b1dcd2d50941f1fd6e102ec8b77',
        ].join('\n') + '\n'
      }
      return ''
    })
    const nodes = await getBranches('/ws')
    // 不存在名为 origin 的 local 幽灵节点
    expect(nodes.find(n => n.name === 'origin')).toBeUndefined()
    // 真实远端分支仍解析
    const remoteMain = nodes.find(n => n.name === 'origin/main')!
    expect(remoteMain.type).toBe('remote')
    expect(remoteMain.remoteName).toBe('origin')
  })

  it('非 git 仓库（抛错）时返回空数组', async () => {
    mockGit.mockRejectedValue(new Error('fatal: not a git repository'))
    const nodes = await getBranches('/ws')
    expect(nodes).toEqual([])
  })
})
