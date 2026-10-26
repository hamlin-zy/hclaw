import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {...actual, execFile: vi.fn()}
})

const {envMock, simpleGitMock} = vi.hoisted(() => ({
  envMock: vi.fn(),
  simpleGitMock: vi.fn(),
}))

vi.mock('simple-git', () => ({simpleGit: simpleGitMock}))

import {execFile} from 'child_process'
import {
  GIT_NOT_INSTALLED_MESSAGE,
  GIT_TIMEOUT_MESSAGE,
  GIT_UNAVAILABLE_MESSAGE,
  checkGitAvailable,
  createGit,
  formatGitError,
  gitUnavailableMessage,
} from '@/main/common/gitAvailability'

const execFileMock = vi.mocked(execFile)

/** 让 execFile 桩通过回调返回错误 */
function mockExecFileError(err: Error): void {
  execFileMock.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    cb(err)
  }) as unknown as typeof execFile)
}

describe('formatGitError', () => {
  const samples = {
    notInstalled: 'Error: spawn git ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:1)\n    at onErrorNT (node:internal/child_process:2)',
    auth: "Cloning into '<path>'...\nfatal: could not read Username for 'https://github.com/x/y': terminal prompts disabled\n",
    notFound: "Cloning into '<path>'...\nremote: Repository not found.\nfatal: repository 'https://github.com/x/y' not found\n",
    ssl: "Cloning into '<path>'...\nfatal: SSL certificate problem: unable to get local issuer certificate\n",
    network: "Cloning into '<path>'...\nfatal: unable to access 'https://github.com/x/y/': Could not resolve host: no-such-host-hclaw.invalid\n",
    other: 'fatal: something weird happened',
  }

  it('未安装 → 完整等于 GIT_NOT_INSTALLED_MESSAGE', () => {
    expect(formatGitError(new Error(samples.notInstalled))).toBe(GIT_NOT_INSTALLED_MESSAGE)
    expect(GIT_NOT_INSTALLED_MESSAGE).toContain('未检测到 Git')
    expect(GIT_NOT_INSTALLED_MESSAGE).toContain('https://git-scm.com/downloads')
  })

  it('认证失败 → 提示完成 Git 登录/令牌', () => {
    const out = formatGitError(new Error(samples.auth))
    expect(out).toContain('仓库需要认证，但当前 Git 凭据不可用')
    expect(out).toContain('详情：could not read Username')
  })

  it('仓库不存在 → 提示检查地址/私有仓库凭据', () => {
    const out = formatGitError(new Error(samples.notFound))
    expect(out).toContain('仓库不存在或无权访问')
    expect(out).toContain('详情：Repository not found.')
  })

  it('SSL 失败 → 提示证书/代理', () => {
    const out = formatGitError(new Error(samples.ssl))
    expect(out).toContain('HTTPS 证书校验失败')
    expect(out).toContain('详情：SSL certificate problem')
  })

  it('网络失败 → 提示网络/代理', () => {
    const out = formatGitError(new Error(samples.network))
    expect(out).toContain('无法连接仓库服务器')
    expect(out).toContain('详情：unable to access')
  })

  it('其他错误 → 仓库操作失败 + 清洗后的首行', () => {
    const out = formatGitError(new Error(samples.other))
    expect(out).toBe('仓库操作失败：something weird happened')
  })

  it('任何分支输出都不含堆栈行或 Cloning into', () => {
    for (const sample of Object.values(samples)) {
      const out = formatGitError(new Error(sample))
      expect(out).not.toContain('    at ')
      expect(out).not.toContain('Cloning into')
    }
  })

  it('仅含缩进堆栈行 → 全部被过滤，回落未知错误', () => {
    const out = formatGitError(new Error('    at foo (bar:1)\n    at baz (qux:2)'))
    expect(out).toBe('仓库操作失败：未知错误')
  })

  it('字符串入参同样清洗，空内容回落未知错误', () => {
    expect(formatGitError('fatal: boom')).toBe('仓库操作失败：boom')
    expect(formatGitError('')).toBe('仓库操作失败：未知错误')
  })

  it('detail 按码点截断到 200 字符并追加省略号', () => {
    const long = 'fatal: ' + 'x'.repeat(500)
    const out = formatGitError(new Error(long))
    expect(out).toBe('仓库操作失败：' + 'x'.repeat(200) + '…')
  })

  // ── HTTP 状态码分类 ────────────────────────────────

  it('HTTP 401 → 访问被拒绝，而非网络错误', () => {
    const raw = "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 401"
    const out = formatGitError(new Error(raw))
    expect(out).toContain('访问被拒绝（HTTP 401）')
    expect(out).toContain('访问令牌')
    expect(out).not.toContain('无法连接仓库服务器')
  })

  it('HTTP 403 → 访问被拒绝，而非网络错误', () => {
    const raw = "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 403"
    const out = formatGitError(new Error(raw))
    expect(out).toContain('访问被拒绝（HTTP 403）')
    expect(out).not.toContain('无法连接仓库服务器')
  })

  it('HTTP 404 → 复用仓库不存在文案', () => {
    const raw = "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 404"
    const out = formatGitError(new Error(raw))
    expect(out).toContain('仓库不存在或无权访问')
    expect(out).not.toContain('无法连接仓库服务器')
  })

  it('HTTP 407 → 代理认证文案', () => {
    const raw = "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 407"
    const out = formatGitError(new Error(raw))
    expect(out).toContain('代理需要认证（HTTP 407）')
    expect(out).toContain('请检查系统代理设置后重试')
  })

  it('仓库不存在 + 认证双信号 → 双信号文案', () => {
    const raw = "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/x/y/'"
    const out = formatGitError(new Error(raw))
    expect(out).toContain('仓库不存在，或当前凭据无权访问')
    expect(out).toContain('确认当前账号有访问权限')
    expect(out).toContain('详情：Repository not found.')
    expect(out).not.toContain('仓库需要认证，但当前 Git 凭据不可用')
  })

  // ── detail 抽取 ────────────────────────────────────

  it('warning 在前、fatal 在后时详情取 fatal 行', () => {
    const raw = [
      'warning: redirecting to https://github.com/x/y.git/',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ].join('\n')
    const out = formatGitError(new Error(raw))
    expect(out).toContain('详情：could not read Username')
    expect(out).not.toContain('warning: redirecting')
  })

  it('中文克隆进度行被过滤', () => {
    const raw = ["正克隆到 'x'...", 'something bad'].join('\n')
    const out = formatGitError(new Error(raw))
    expect(out).toBe('仓库操作失败：something bad')
  })
})

describe('checkGitAvailable', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('git --version 成功 → available + version', async () => {
    execFileMock.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, 'git version 2.47.1\n')
    }) as unknown as typeof execFile)

    await expect(checkGitAvailable()).resolves.toEqual({available: true, version: 'git version 2.47.1'})
    expect(execFileMock).toHaveBeenCalledWith('git', ['--version'], expect.objectContaining({timeout: 2000, windowsHide: true}), expect.any(Function))
  })

  it('ENOENT 失败 → reason:not-found，且不抛异常', async () => {
    const err = Object.assign(new Error('spawn git ENOENT'), {code: 'ENOENT'})
    mockExecFileError(err)

    await expect(checkGitAvailable()).resolves.toEqual({available: false, reason: 'not-found'})
  })

  it('进程被杀（超时）→ reason:timeout，而非未安装', async () => {
    const err = Object.assign(new Error('Command failed: git --version'), {killed: true})
    mockExecFileError(err)

    await expect(checkGitAvailable()).resolves.toEqual({available: false, reason: 'timeout'})
  })

  it('ETIMEDOUT → reason:timeout', async () => {
    const err = Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})
    mockExecFileError(err)

    await expect(checkGitAvailable()).resolves.toEqual({available: false, reason: 'timeout'})
  })

  it('其它执行错误 → reason:error', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'})
    mockExecFileError(err)

    await expect(checkGitAvailable()).resolves.toEqual({available: false, reason: 'error'})
  })

  it('同步抛错 → reason:error', async () => {
    execFileMock.mockImplementation((() => {
      throw new Error('boom')
    }) as unknown as typeof execFile)

    await expect(checkGitAvailable()).resolves.toEqual({available: false, reason: 'error'})
  })
})

describe('gitUnavailableMessage', () => {
  it('timeout → GIT_TIMEOUT_MESSAGE', () => {
    expect(gitUnavailableMessage('timeout')).toBe(GIT_TIMEOUT_MESSAGE)
    expect(GIT_TIMEOUT_MESSAGE).toContain('Git 响应超时')
  })

  it('error → GIT_UNAVAILABLE_MESSAGE', () => {
    expect(gitUnavailableMessage('error')).toBe(GIT_UNAVAILABLE_MESSAGE)
    expect(GIT_UNAVAILABLE_MESSAGE).toContain('Git 不可用（无法执行 git --version）')
  })

  it('not-found / 未传 → GIT_NOT_INSTALLED_MESSAGE', () => {
    expect(gitUnavailableMessage('not-found')).toBe(GIT_NOT_INSTALLED_MESSAGE)
    expect(gitUnavailableMessage()).toBe(GIT_NOT_INSTALLED_MESSAGE)
  })
})

describe('createGit', () => {
  /** 全部显式放行的 env 类别；用字面量钉死，防止实现里键名写错或漏项 */
  const expectedUnsafe = {
    allowUnsafeEditor: true,
    allowUnsafeAskPass: true,
    allowUnsafeConfigPaths: true,
    allowUnsafeConfigEnvCount: true,
    allowUnsafeDiffExternal: true,
    allowUnsafePager: true,
    allowUnsafeGitProxy: true,
    allowUnsafeTemplateDir: true,
    allowUnsafeSshCommand: true,
  }

  beforeEach(() => {
    envMock.mockReset()
    simpleGitMock.mockReset()
    const gitStub = {env: envMock}
    simpleGitMock.mockReturnValue(gitStub)
    envMock.mockReturnValue(gitStub)
  })

  it('不传 baseDir → 以 options 对象调用 simpleGit，并放行继承环境中的不安全键', () => {
    createGit()

    expect(simpleGitMock).toHaveBeenCalledTimes(1)
    expect(simpleGitMock).toHaveBeenCalledWith({unsafe: expectedUnsafe})
    expect(simpleGitMock.mock.calls[0][0]).not.toBe('GIT_TERMINAL_PROMPT')
    expect(envMock).toHaveBeenCalledTimes(1)
  })

  it('以对象形式传入完整环境，保留父进程 PATH 并禁用交互式提示', () => {
    createGit()

    const envArg = envMock.mock.calls[0][0]
    expect(typeof envArg).toBe('object')
    expect(Array.isArray(envArg)).toBe(false)
    expect(envArg).not.toBe('GIT_TERMINAL_PROMPT')
    expect(envArg.PATH).toBe(process.env.PATH)
    expect(envArg.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('传入 baseDir 时作为第一个参数，options 作为第二个参数', () => {
    createGit('/some/dir')

    expect(simpleGitMock).toHaveBeenCalledTimes(1)
    expect(simpleGitMock).toHaveBeenCalledWith('/some/dir', {unsafe: expectedUnsafe})
    expect(envMock).toHaveBeenCalledTimes(1)
  })
})
