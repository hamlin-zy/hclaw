// src/main/project-manager/window.ts
import {ipcMain} from 'electron'
import {basename} from 'path'
import {createAppWindow} from '../utils/windowFactory'
import type {BrowserWindow} from 'electron'
import {getGitStatusCached, invalidateStatusCache} from './git/status'
import {getDiff, type DiffMode} from './git/diff'
import {getGitLog} from './git/log'
import {getBranches} from './git/branches'
import {getGitAuthors, assertValidAuthorRef} from './git/authors'
import {getShowCommit} from './git/showCommit'
import {gitExec} from './git/gitExec'
import {gitAdd, gitRmCached, gitCommit, gitPush, gitDiscardChanges, gitDeleteBranch} from './git/operations'
import {assertValidHash, assertValidRef} from './git/validation'
import {assertInWorkspace, deleteGitRepoCache, deletePath, listDirectory, readFileForViewer} from './fileSystem'
import {startWatcher, stopWatcher} from './watcher'
import {getMainWindow} from '../window'
import {handleSendToConversation, resolveSendToConversationAck} from './sendToConversation'

// 注册表：key 为 workspace 绝对路径，对标 configWindow 的单例模式
const projectWindows = new Map<string, BrowserWindow>()

function sendToWindow(channel: string, workspace: string, data: unknown): void {
  const win = projectWindows.get(workspace)
  if (win && !win.isDestroyed()) win.webContents.send(channel, workspace, data)
}

export function openProjectManagerWindow(workspacePath: string): BrowserWindow {
  const existing = projectWindows.get(workspacePath)
  if (existing) {
    if (!existing.isDestroyed()) {
      existing.focus()
      return existing
    }
    projectWindows.delete(workspacePath) // 清理死条目（crash 后 closed 未触发的兜底）
  }
  const win = createAppWindow({
    id: 'project-manager',
    title: `项目管理 - ${basename(workspacePath)}`,
    // 注：html 位于 src/renderer/main_window/ 下，产物会保留目录层级（.vite/.../main_window/main_window/），
    // 且 dev server root 为 src/renderer，故 entryHtml 需带 main_window/ 前缀
    entryHtml: 'main_window/projectManager.html',
    width: 1280, height: 800,
    minWidth: 960, minHeight: 600,
    additionalArguments: [`--hclaw-workspace=${workspacePath}`],
    devTools: false,
  })
  projectWindows.set(workspacePath, win)
  win.on('closed', () => {
    projectWindows.delete(workspacePath)
    void stopWatcher(workspacePath)
    // 模块级缓存按 workspace 键控，窗口关闭是唯一的生产侧回收时机：
    // 不做兜底清理的话，每个打开过的工作区会永久占一个 Map key（见 watcher 的 refcount 范式）。
    deleteGitRepoCache(workspacePath)
    invalidateStatusCache(workspacePath)
  })
  startWatcher(workspacePath, sendToWindow)
  return win
}

export function getProjectWindowCount(workspacePath: string): number {
  const win = projectWindows.get(workspacePath)
  return win && !win.isDestroyed() ? 1 : 0
}

/** 主进程 before-quit 时全量停止 watcher（防 closed 未触发的泄露） */
export function stopAllWatchers(): void {
  for (const ws of [...projectWindows.keys()]) void stopWatcher(ws)
}

// 幂等注册：同 channel 已有 listener 时跳过（避免窗口重开 / 重复 init 覆盖）
function safeHandle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  if (!ipcMain.listenerCount(channel)) ipcMain.handle(channel, handler)
}

export function initProjectManagerIPC(): void {
  // 注：pm:list-directory / pm:read-file 的路径校验在 listDirectory / readFileForViewer
  // 内部通过 assertInWorkspace 完成；pm:git-diff-file / pm:git-add / pm:git-rm-cached
  // 在 handler 入口对路径参数显式 assertInWorkspace 校验（词法校验，不依赖文件存在）
  safeHandle('pm:list-directory', (_e, ws: string, dirPath: string) =>
    getGitStatusCached(ws).then(s => listDirectory(ws, dirPath, s.statusMap)))
  safeHandle('pm:read-file', (_e, ws: string, filePath: string) => readFileForViewer(ws, filePath))
  safeHandle('pm:git-status', (_e, ws: string) => getGitStatusCached(ws))
  safeHandle('pm:git-diff-file', async (_e, ws: string, filePath: string, mode?: DiffMode) => {
    assertInWorkspace(ws, filePath)
    // C3: IPC 边界 ref/hash 校验
    if (mode?.ref) assertValidRef(mode.ref)
    if (mode?.from) assertValidRef(mode.from)
    if (mode?.to) assertValidRef(mode.to)
    return getDiff(ws, filePath, mode ?? {})
  })
  safeHandle('pm:git-log', async (_e, ws: string, opts: Parameters<typeof getGitLog>[1]) => {
    // C3: filterBranch 入口校验
    for (const b of opts?.filterBranch ?? []) assertValidRef(b)
    return getGitLog(ws, opts)
  })
  safeHandle('pm:git-show-commit', async (_e, ws: string, hash: string) => {
    assertValidHash(hash)
    return getShowCommit(ws, hash)
  })
  safeHandle('pm:git-show-detail', async (_e, ws: string, hash: string) => {
    assertValidHash(hash)
    return gitExec(ws, ['show', '--no-color', hash])
  })
  safeHandle('pm:git-branches', (_e, ws: string) => getBranches(ws))
  safeHandle('pm:git-authors', async (_e, ws: string, opts?: {branch?: string}) => {
    // C3: branch 入口校验（防 git 选项注入 / revision range；authors.ts 内部亦再次校验）
    if (opts?.branch) assertValidAuthorRef(opts.branch)
    return getGitAuthors(ws, opts)
  })
  safeHandle('pm:git-add', async (_e, ws: string, filePaths: string | string[]) => {
    const list = Array.isArray(filePaths) ? filePaths : [filePaths]
    for (const p of list) assertInWorkspace(ws, p)
    await gitAdd(ws, filePaths)
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
  })
  safeHandle('pm:git-rm-cached', async (_e, ws: string, filePath: string) => {
    assertInWorkspace(ws, filePath)
    await gitRmCached(ws, filePath)
    invalidateStatusCache(ws)
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
  })
  safeHandle('pm:git-commit', async (_e, ws: string, message: string) => {
    // 只接受 ws 与 message，无用户可控的路径参数；失败时不推 pm:status-changed（本地状态未变）
    await gitCommit(ws, message)
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
  })
  safeHandle('pm:git-push', async (_e, ws: string) => {
    await gitPush(ws)
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
  })
  safeHandle('pm:delete-path', async (_e, ws: string, relPath: string) => {
    // 路径校验在 deletePath 内部经 assertInWorkspace 完成（词法校验，不依赖文件存在）
    await deletePath(ws, relPath)
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
  })
  safeHandle('pm:git-discard', async (_e, ws: string, filePath: string, status: string) => {
    await gitDiscardChanges(ws, filePath, status)
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
  })
  safeHandle('pm:git-delete-branch', async (_e, ws: string, opts: {name: string; isRemote: boolean; remoteName?: string; force?: boolean}) => {
    await gitDeleteBranch(ws, opts)
    // 分支删除同时影响工作区状态与 refs（commit 列表 / 分支树），两个事件都要广播
    sendToWindow('pm:status-changed', ws, await getGitStatusCached(ws))
    sendToWindow('pm:refs-changed', ws, undefined)
  })
  safeHandle('open-project-manager', (_e, workspacePath: string) => {
    openProjectManagerWindow(workspacePath)
  })
  safeHandle('pm:send-to-conversation', (event, payload: unknown) =>
    handleSendToConversation(payload, event.sender, {
      // 权限面：sender 必须是该 workspace 对应 PM 窗口的 webContents，且窗口仍打开（spec §5.2）
      isPmSender: (ws, sender) => {
        const w = projectWindows.get(ws)
        return !!w && !w.isDestroyed() && w.webContents === sender
      },
      // existing 目标归属校验：动态 import 避免 sqlite 仓库在模块加载期被拉起
      listConvIds: async (ws) => {
        const {createConversationRepository} = await import('../repositories')
        return createConversationRepository().listByWorkspace(ws).map(c => c.id)
      },
      getMainWindow,
    }))
  if (!ipcMain.listenerCount('pm:send-to-conversation:ack')) {
    ipcMain.on('pm:send-to-conversation:ack', (e, p: {requestId: string; ok: boolean; error?: string; started?: boolean}) => {
      const mw = getMainWindow()
      if (!mw || mw.isDestroyed() || mw.webContents !== e.sender) return
      resolveSendToConversationAck(p)
    })
  }
}
