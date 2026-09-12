import {describe, it, expect, vi, beforeEach} from 'vitest'
const mockGit = vi.fn()
const mockGitResult = vi.fn()
vi.mock('../../../src/main/project-manager/git/gitExec', () => ({
  gitExec: (...a: unknown[]) => mockGit(...a),
  gitExecResult: (...a: unknown[]) => mockGitResult(...a),
}))
vi.mock('../../../src/main/project-manager/git/status', () => ({
  invalidateStatusCache: vi.fn(),
  getGitStatusCached: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 0})),
}))
import {gitAdd, gitRmCached, gitCommit, gitPush} from '../../../src/main/project-manager/git/operations'
import {invalidateStatusCache} from '../../../src/main/project-manager/git/status'

describe('gitAdd', () => {
  beforeEach(() => { mockGit.mockReset(); (invalidateStatusCache as ReturnType<typeof vi.fn>).mockClear() })
  it('单文件调用 git add 并失效缓存', async () => {
    mockGit.mockResolvedValue('')
    await gitAdd('/ws', 'a.ts')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['add', '--', 'a.ts'])
    expect(invalidateStatusCache).toHaveBeenCalledWith('/ws')
  })
  it('批量数组一次调用', async () => {
    mockGit.mockResolvedValue('')
    await gitAdd('/ws', ['a.ts', 'b.ts'])
    expect(mockGit).toHaveBeenCalledWith('/ws', ['add', '--', 'a.ts', 'b.ts'])
  })
})

describe('gitRmCached', () => {
  beforeEach(() => { mockGit.mockReset(); (invalidateStatusCache as ReturnType<typeof vi.fn>).mockClear() })
  it('调用 git rm --cached 并失效缓存', async () => {
    mockGit.mockResolvedValue('')
    await gitRmCached('/ws', 'a.ts')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['rm', '--cached', '--', 'a.ts'])
    expect(invalidateStatusCache).toHaveBeenCalledWith('/ws')
  })
})

describe('gitCommit', () => {
  beforeEach(() => {
    mockGit.mockReset(); mockGitResult.mockReset()
    mockGitResult.mockResolvedValue({code: 0, stdout: 'main\n', stderr: ''})
    ;(invalidateStatusCache as ReturnType<typeof vi.fn>).mockClear()
  })

  it('提交已跟踪变更并失效缓存（走 gitExec + 120s 超时）', async () => {
    mockGit.mockResolvedValue('')
    await gitCommit('/ws', 'feat: x')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['commit', '-a', '--message=feat: x'], 120_000)
    expect(invalidateStatusCache).toHaveBeenCalledWith('/ws')
  })

  it('空消息 / 纯空白 → 抛错且不调 git', async () => {
    await expect(gitCommit('/ws', '   ')).rejects.toThrow('提交消息不能为空')
    expect(mockGit).not.toHaveBeenCalled()
  })

  it('以 - 开头的消息走 --message= 等号形式（不被当成选项）', async () => {
    mockGit.mockResolvedValue('')
    await gitCommit('/ws', '--amend')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['commit', '-a', '--message=--amend'], 120_000)
  })

  it('多行消息整体作为一个 argv 元素（argv 不被拆分）', async () => {
    mockGit.mockResolvedValue('')
    await gitCommit('/ws', 'line1\nline2')
    const args = mockGit.mock.calls[0][1] as string[]
    expect(args).toHaveLength(3)
    expect(args[2]).toBe('--message=line1\nline2')
  })

  it('detached HEAD → 抛错且不调 commit', async () => {
    mockGitResult.mockResolvedValue({code: 128, stdout: 'HEAD\n', stderr: 'fatal: ref HEAD is not a symbolic ref'})
    await expect(gitCommit('/ws', 'x')).rejects.toThrow('detached HEAD')
    expect(mockGit).not.toHaveBeenCalled()
  })

  it('未出生分支（symbolic-ref 返回 master）→ 允许首次提交 [rev3]', async () => {
    mockGitResult.mockResolvedValue({code: 0, stdout: 'master\n', stderr: ''})
    mockGit.mockResolvedValue('')
    await gitCommit('/ws', 'init')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['commit', '-a', '--message=init'], 120_000)
  })

  it('失败时净化错误：不含完整命令行，含 stderr 摘要', async () => {
    mockGit.mockRejectedValue(new Error('git commit -a --message=secret: nothing to commit, working tree clean'))
    const err = (await gitCommit('/ws', 'secret').catch(e => e as Error)) as Error
    expect(err.message).toContain('nothing to commit')
    expect(err.message).not.toContain('--message=secret')
  })

  it('错误净化不泄漏含 ": " 的提交消息（spec §6.3）', async () => {
    mockGit.mockRejectedValueOnce(new Error('git commit -a --message=feat: x: fatal: nothing to commit'))
    const err = (await gitCommit('/ws', 'feat: x').catch(e => e as Error)) as Error
    expect(err.message).not.toContain('feat')
    expect(err.message).not.toContain(' x')
    expect(err.message).toBe('fatal: nothing to commit')
  })

  it('stderr 超 2000 字符 → 截断且不崩', async () => {
    mockGit.mockRejectedValue(new Error('git commit: ' + 'x'.repeat(5000)))
    const err = (await gitCommit('/ws', 'm').catch(e => e as Error)) as Error
    expect(err.message.length).toBe(2000)
  })

  it('失败路径不失效缓存', async () => {
    mockGit.mockRejectedValue(new Error('git commit: boom'))
    await gitCommit('/ws', 'm').catch(() => {})
    expect(invalidateStatusCache).not.toHaveBeenCalled()
  })
})

describe('gitPush', () => {
  beforeEach(() => {
    mockGit.mockReset(); mockGitResult.mockReset()
    ;(invalidateStatusCache as ReturnType<typeof vi.fn>).mockClear()
  })

  it('有 upstream → git push（120s 超时）', async () => {
    mockGitResult
      .mockResolvedValueOnce({code: 0, stdout: 'main\n', stderr: ''})           // symbolic-ref
      .mockResolvedValueOnce({code: 0, stdout: 'origin/main\n', stderr: ''})    // @{u}
    mockGit.mockResolvedValue('')
    await gitPush('/ws')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['push'], 120_000)
    expect(invalidateStatusCache).toHaveBeenCalledWith('/ws')
  })

  it('无 upstream 且有 origin → push -u origin <branch>（branch 含 / 原样传入）', async () => {
    mockGitResult
      .mockResolvedValueOnce({code: 0, stdout: 'feature/x\n', stderr: ''})
      .mockResolvedValueOnce({code: 128, stdout: '', stderr: 'fatal: no upstream'})
    mockGit.mockImplementation(async (_ws: string, args: string[]) => (args[0] === 'remote' ? 'origin\n' : ''))
    await gitPush('/ws')
    expect(mockGit).toHaveBeenCalledWith('/ws', ['push', '-u', 'origin', 'feature/x'], 120_000)
  })

  it('无 upstream 且无 origin → 抛错且不 push', async () => {
    mockGitResult
      .mockResolvedValueOnce({code: 0, stdout: 'main\n', stderr: ''})
      .mockResolvedValueOnce({code: 128, stdout: '', stderr: ''})
    mockGit.mockResolvedValue('')
    await expect(gitPush('/ws')).rejects.toThrow('未配置 origin')
    expect(mockGit.mock.calls.filter(c => (c[1] as string[])[0] === 'push')).toHaveLength(0)
  })

  it('@{u} 探测 code === -1（git 不可用）→ 抛「git 不可用」且不 push', async () => {
    mockGitResult
      .mockResolvedValueOnce({code: 0, stdout: 'main\n', stderr: ''})
      .mockResolvedValueOnce({code: -1, stdout: '', stderr: ''})
    await expect(gitPush('/ws')).rejects.toThrow('git 不可用')
    expect(mockGit).not.toHaveBeenCalled()
  })

  it('detached HEAD → 先抛错：gitExec 零调用，gitExecResult 仅 1 次（symbolic-ref）', async () => {
    mockGitResult.mockResolvedValue({code: 128, stdout: 'HEAD\n', stderr: ''})
    await expect(gitPush('/ws')).rejects.toThrow('detached HEAD')
    expect(mockGit).not.toHaveBeenCalled()
    expect(mockGitResult).toHaveBeenCalledTimes(1)
    expect(mockGitResult.mock.calls[0][1]).toEqual(['symbolic-ref', '--short', 'HEAD'])
  })

  it('失败路径不失效缓存', async () => {
    mockGitResult.mockResolvedValue({code: 128, stdout: '', stderr: ''})
    await gitPush('/ws').catch(() => {})
    expect(invalidateStatusCache).not.toHaveBeenCalled()
  })
})
