import {describe, it, expect, vi, beforeEach} from 'vitest'

const mockWin = {
  isDestroyed: () => false,
  focus: vi.fn(),
  on: vi.fn(),
  webContents: {send: vi.fn()},
}
const ipcHandles = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const ipcOns = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(() => mockWin), {getAllWindows: () => []}),
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandles.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcOns.set(channel, handler)
    }),
    listenerCount: vi.fn(() => 0),
  },
}))
vi.mock('../../../src/main/utils/windowFactory', () => ({createAppWindow: vi.fn(() => mockWin)}))
// 部分 mock：保留 assertInWorkspace 等真实实现（路径校验用例依赖），只替换缓存回收入口以便断言
vi.mock('../../../src/main/project-manager/fileSystem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/project-manager/fileSystem')>()),
  deleteGitRepoCache: vi.fn(),
}))
vi.mock('../../../src/main/project-manager/watcher', () => ({
  startWatcher: vi.fn(),
  stopWatcher: vi.fn(async () => {}),
}))
// 静默 git/fileSystem 依赖（window.ts 仅传递引用，不在测试路径中触发）
vi.mock('../../../src/main/project-manager/git/status', () => ({
  getGitStatusCached: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 0})),
  invalidateStatusCache: vi.fn(),
}))

vi.mock('../../../src/main/project-manager/git/operations', () => ({
  gitAdd: vi.fn(async () => {}),
  gitRmCached: vi.fn(async () => {}),
  gitCommit: vi.fn(async () => {}),
  gitPush: vi.fn(async () => {}),
}))
vi.mock('../../../src/main/project-manager/git/gitExec', () => ({
  gitExec: vi.fn(async () => ''),
}))
vi.mock('../../../src/main/project-manager/git/diff', () => ({
  getDiff: vi.fn(async () => ({})),
}))
vi.mock('../../../src/main/project-manager/git/log', () => ({
  getGitLog: vi.fn(async () => []),
}))
// 部分 mock：保留真实 assertValidAuthorRef（校验用例依赖），只替换 git 调用入口
vi.mock('../../../src/main/project-manager/git/authors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/project-manager/git/authors')>()),
  getGitAuthors: vi.fn(async () => []),
}))
vi.mock('../../../src/main/project-manager/git/showCommit', () => ({
  getShowCommit: vi.fn(async () => ({hash: '', message: '', files: []})),
}))
vi.mock('../../../src/main/window', () => ({getMainWindow: vi.fn(() => null)}))
vi.mock('../../../src/main/project-manager/sendToConversation', () => ({
  handleSendToConversation: vi.fn(async () => ({ok: true})),
  resolveSendToConversationAck: vi.fn(),
}))

// window.ts 中 projectWindows Map 为模块级状态 → resetModules + 动态 import 隔离各用例
async function loadModule() {
  vi.resetModules()
  return await import('../../../src/main/project-manager/window')
}

describe('openProjectManagerWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('同 workspace 重复打开聚焦已有窗口', async () => {
    const {openProjectManagerWindow, getProjectWindowCount} = await loadModule()
    openProjectManagerWindow('/ws/a')
    openProjectManagerWindow('/ws/a')
    expect(mockWin.focus).toHaveBeenCalledTimes(1)
    expect(getProjectWindowCount('/ws/a')).toBe(1)
  })

  it('不同 workspace 各开各的', async () => {
    const {openProjectManagerWindow, getProjectWindowCount} = await loadModule()
    openProjectManagerWindow('/ws/a')
    openProjectManagerWindow('/ws/b')
    expect(getProjectWindowCount('/ws/b')).toBe(1)
  })

  it('窗口打开时启动 watcher，closed 时停止 watcher 并清理注册表', async () => {
    const watcher = await import('../../../src/main/project-manager/watcher')
    const {openProjectManagerWindow, getProjectWindowCount} = await loadModule()
    openProjectManagerWindow('/ws/a')
    expect(watcher.startWatcher).toHaveBeenCalledWith('/ws/a', expect.any(Function))

    // 捕获 closed 回调并触发
    expect(mockWin.on).toHaveBeenCalledWith('closed', expect.any(Function))
    const closedCb = mockWin.on.mock.calls.find(c => c[0] === 'closed')![1] as () => void
    closedCb()
    await Promise.resolve()
    expect(watcher.stopWatcher).toHaveBeenCalledWith('/ws/a')
    expect(getProjectWindowCount('/ws/a')).toBe(0)
  })

  it('窗口 closed 兜底清理该 workspace 的模块级缓存（git 仓库探测 + git 状态）', async () => {
    const fileSystem = await import('../../../src/main/project-manager/fileSystem')
    const status = await import('../../../src/main/project-manager/git/status')
    const {openProjectManagerWindow} = await loadModule()
    openProjectManagerWindow('/ws/a')
    const closedCb = mockWin.on.mock.calls.find(c => c[0] === 'closed')![1] as () => void
    closedCb()
    expect(fileSystem.deleteGitRepoCache).toHaveBeenCalledWith('/ws/a')
    expect(status.invalidateStatusCache).toHaveBeenCalledWith('/ws/a')
  })
})

describe('pm:git-add / pm:git-rm-cached 路径校验', () => {
  let invokeHandler: (channel: string) => (...args: unknown[]) => unknown

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await loadModule()
    mod.initProjectManagerIPC()
    invokeHandler = (channel: string) => {
      const handler = ipcHandles.get(channel)
      if (!handler) throw new Error(`handler 未注册: ${channel}`)
      return handler
    }
  })

  it('pm:git-add 拒绝 ../ 越界路径', async () => {
    const handler = invokeHandler('pm:git-add')
    await expect(handler({}, '/ws/a', ['../x'])).rejects.toThrow('路径超出工作目录')
    const ops = await import('../../../src/main/project-manager/git/operations')
    expect(ops.gitAdd).not.toHaveBeenCalled()
  })

  it('pm:git-add 拒绝数组中的部分越界路径', async () => {
    const handler = invokeHandler('pm:git-add')
    await expect(handler({}, '/ws/a', ['a.txt', '/etc/passwd'])).rejects.toThrow('路径超出工作目录')
    const ops = await import('../../../src/main/project-manager/git/operations')
    expect(ops.gitAdd).not.toHaveBeenCalled()
  })

  it('pm:git-rm-cached 拒绝绝对路径外部路径', async () => {
    const handler = invokeHandler('pm:git-rm-cached')
    await expect(handler({}, '/ws/a', '/etc/passwd')).rejects.toThrow('路径超出工作目录')
    const ops = await import('../../../src/main/project-manager/git/operations')
    expect(ops.gitRmCached).not.toHaveBeenCalled()
  })

  it('合法路径正常通过并触发 git 操作', async () => {
    const handler = invokeHandler('pm:git-add')
    await expect(handler({}, '/ws/a', 'src/a.ts')).resolves.toBeUndefined()
    const ops = await import('../../../src/main/project-manager/git/operations')
    expect(ops.gitAdd).toHaveBeenCalledWith('/ws/a', 'src/a.ts')
  })
})

describe('C3: IPC 边界 ref/hash 校验（负路径）', () => {
  let invokeHandler: (channel: string) => (...args: unknown[]) => unknown

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await loadModule()
    mod.initProjectManagerIPC()
    invokeHandler = (channel: string) => {
      const handler = ipcHandles.get(channel)
      if (!handler) throw new Error(`handler 未注册: ${channel}`)
      return handler
    }
  })

  it('pm:git-show-detail 拒绝非 hash 字符', async () => {
    const handler = invokeHandler('pm:git-show-detail')
    await expect(handler({}, '/ws', 'evil-command')).rejects.toThrow('无效的 commit hash')
    await expect(handler({}, '/ws', '--inject')).rejects.toThrow('无效的 commit hash')
    await expect(handler({}, '/ws', 'abc')).rejects.toThrow('无效的 commit hash') // <4 字符
  })

  it('pm:git-show-detail 接受合法 hash', async () => {
    const handler = invokeHandler('pm:git-show-detail')
    // gitExec 被 mock 为返回空（不触发实际 git）
    await expect(handler({}, '/ws', 'abcdef12')).resolves.toBe('')
  })

  it('pm:git-diff-file 拒绝前导 - 的 ref', async () => {
    const handler = invokeHandler('pm:git-diff-file')
    await expect(handler({}, '/ws/a', 'a.ts', {ref: '--output=evil'})).rejects.toThrow('无效的 git ref')
  })

  it('pm:git-diff-file 拒绝含空白的 ref', async () => {
    const handler = invokeHandler('pm:git-diff-file')
    await expect(handler({}, '/ws/a', 'a.ts', {from: 'main ; rm -rf /'})).rejects.toThrow('无效的 git ref')
  })

  it('pm:git-diff-file 接受合法 ref（分支名 / hash / HEAD）', async () => {
    const handler = invokeHandler('pm:git-diff-file')
    // getDiff 被 mock 为返回空对象（不触发实际 git）
    await expect(handler({}, '/ws/a', 'a.ts', {ref: 'abc123'})).resolves.toBeDefined()
    await expect(handler({}, '/ws/a', 'a.ts', {from: 'HEAD', to: 'main'})).resolves.toBeDefined()
  })

  it('pm:git-log 拒绝非法 filterBranch', async () => {
    const handler = invokeHandler('pm:git-log')
    await expect(handler({}, '/ws/a', {limit: 10, filterBranch: ['--inject']})).rejects.toThrow('无效的 git ref')
    await expect(handler({}, '/ws/a', {limit: 10, filterBranch: ['main', 'evil ; rm']})).rejects.toThrow('无效的 git ref')
  })

  it('pm:git-authors 已注册', () => {
    expect(ipcHandles.has('pm:git-authors')).toBe(true)
  })

  it('pm:git-authors 拒绝非法 branch（前导 - / 空格 / ; / ..）', async () => {
    const handler = invokeHandler('pm:git-authors')
    for (const bad of ['--inject', 'a b', 'main ; rm -rf /', '..']) {
      await expect(handler({}, '/ws/a', {branch: bad})).rejects.toThrow('无效的 git ref')
    }
    const authors = await import('../../../src/main/project-manager/git/authors')
    expect(authors.getGitAuthors).not.toHaveBeenCalled()
  })

  it('pm:git-authors 合法 branch 透传，未传 opts 亦可', async () => {
    const handler = invokeHandler('pm:git-authors')
    await expect(handler({}, '/ws/a', {branch: 'feature/x'})).resolves.toEqual([])
    await expect(handler({}, '/ws/a')).resolves.toEqual([])
    const authors = await import('../../../src/main/project-manager/git/authors')
    expect(authors.getGitAuthors).toHaveBeenCalledWith('/ws/a', {branch: 'feature/x'})
    expect(authors.getGitAuthors).toHaveBeenCalledWith('/ws/a', undefined)
  })
})

describe('pm:git-commit / pm:git-push', () => {
  let invoke: (channel: string) => (...args: unknown[]) => unknown

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await loadModule()
    mod.openProjectManagerWindow('/ws/a')   // sendToWindow 需要已注册的窗口
    mod.initProjectManagerIPC()
    invoke = (channel) => {
      const handler = ipcHandles.get(channel)
      if (!handler) throw new Error(`handler 未注册: ${channel}`)
      return handler
    }
  })

  it('两个新 channel 已注册', () => {
    expect(ipcHandles.has('pm:git-commit')).toBe(true)
    expect(ipcHandles.has('pm:git-push')).toBe(true)
  })

  it('提交成功 → 推送 pm:status-changed', async () => {
    const ops = await import('../../../src/main/project-manager/git/operations')
    await expect(invoke('pm:git-commit')({}, '/ws/a', 'feat: x')).resolves.toBeUndefined()
    expect(ops.gitCommit).toHaveBeenCalledWith('/ws/a', 'feat: x')
    expect(mockWin.webContents.send).toHaveBeenCalledWith('pm:status-changed', '/ws/a', expect.anything())
  })

  it('提交失败 → handler reject 且不推送（不推陈旧状态）', async () => {
    const ops = await import('../../../src/main/project-manager/git/operations')
    ;(ops.gitCommit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    await expect(invoke('pm:git-commit')({}, '/ws/a', 'x')).rejects.toThrow('boom')
    expect(mockWin.webContents.send).not.toHaveBeenCalled()
  })

  it('推送成功 → 推送 pm:status-changed', async () => {
    const ops = await import('../../../src/main/project-manager/git/operations')
    await expect(invoke('pm:git-push')({}, '/ws/a')).resolves.toBeUndefined()
    expect(ops.gitPush).toHaveBeenCalledWith('/ws/a')
    expect(mockWin.webContents.send).toHaveBeenCalledWith('pm:status-changed', '/ws/a', expect.anything())
  })

  it('推送失败 → handler reject 且不推送', async () => {
    const ops = await import('../../../src/main/project-manager/git/operations')
    ;(ops.gitPush as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rejected'))
    await expect(invoke('pm:git-push')({}, '/ws/a')).rejects.toThrow('rejected')
    expect(mockWin.webContents.send).not.toHaveBeenCalled()
  })
})

describe('pm:send-to-conversation 通道注册', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await loadModule()
    mod.initProjectManagerIPC()
  })

  it('注册 invoke 通道与 ack 监听', () => {
    expect(ipcHandles.has('pm:send-to-conversation')).toBe(true)
    expect(ipcOns.has('pm:send-to-conversation:ack')).toBe(true)
  })

  it('invoke 把 event.sender 与三个 deps 转给 handleSendToConversation', async () => {
    const sc = await import('../../../src/main/project-manager/sendToConversation')
    const sender = {id: 1}
    const payload = {requestId: 'r', workspacePath: '/ws', content: 'x', target: {kind: 'new'}}
    await ipcHandles.get('pm:send-to-conversation')!({sender}, payload)
    expect(sc.handleSendToConversation).toHaveBeenCalledWith(payload, sender, expect.objectContaining({
      isPmSender: expect.any(Function),
      listConvIds: expect.any(Function),
      getMainWindow: expect.any(Function),
    }))
  })

  it('ack 监听：发送方为主窗口 webContents 时转给 resolveSendToConversationAck', async () => {
    const sc = await import('../../../src/main/project-manager/sendToConversation')
    const {getMainWindow} = await import('../../../src/main/window')
    vi.mocked(getMainWindow).mockReturnValue(mockWin as never)
    ipcOns.get('pm:send-to-conversation:ack')!({sender: mockWin.webContents}, {requestId: 'r', ok: true})
    expect(sc.resolveSendToConversationAck).toHaveBeenCalledWith({requestId: 'r', ok: true})
  })

  it('ack 监听：非主窗口发送方被忽略（F3 校验）', async () => {
    const sc = await import('../../../src/main/project-manager/sendToConversation')
    const {getMainWindow} = await import('../../../src/main/window')
    vi.mocked(getMainWindow).mockReturnValue(mockWin as never)
    vi.mocked(sc.resolveSendToConversationAck).mockClear()
    ipcOns.get('pm:send-to-conversation:ack')!({id: 99}, {requestId: 'r', ok: true})
    expect(sc.resolveSendToConversationAck).not.toHaveBeenCalled()
  })
})
