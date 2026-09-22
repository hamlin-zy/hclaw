// src/main/project-manager/window.ts
import {ipcMain} from 'electron'
import {safeHandle} from '../lib/safeHandle'
import {basename, resolve} from 'path'
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
import {
  deleteFileListCache,
  disposeSearchSessions,
  getFindInFilesPage,
  readLines,
  searchFiles,
  startFindInFiles,
  stopFindInFiles,
} from './search'
import {startWatcher, stopWatcher} from './watcher'
import {getMainWindow} from '../window'
import {handleSendToConversation, resolveSendToConversationAck} from './sendToConversation'

interface ProjectWindowEntry {
  win: BrowserWindow
  /** 创建窗口时的**原始** workspace 字符串：对外传递（IPC 载荷 / watcher / 缓存回收）一律用它 */
  workspacePath: string
}

// 注册表：key 为归一化后的 workspace 路径（见 wsKey），对标 configWindow 的单例模式
const projectWindows = new Map<string, ProjectWindowEntry>()

/**
 * 注册表键归一化（与 watcher.ts 的 watchers / fileSystem.ts 的 gitRepoCache /
 * git/status.ts 的 statusCache 同一约定，windowFactory 明写「单例由调用方维护」）。
 *
 * 产品契约：**一个工作目录只允许一个 PM 窗口**。同一目录的不同写法（尾斜杠、`.`/`..`、
 * 相对路径、混合分隔符）必须落到同一个键，否则会绕过单例开出第二个窗口 —— 而
 * startWatcher 内部按同一 key 去重，第二次调用的 sendToWindow 回调被直接丢弃
 * （watcher.ts 的 `existing.refs += 1; return`），第二个窗口从此收不到任何 pm:* 推送。
 *
 * Windows 文件系统大小写不敏感（`E:\ws` 与 `E:\WS` 是同一目录），故额外折叠大小写；
 * 不同磁盘目录不可能仅大小写不同，折叠不会误合并。POSIX 大小写敏感，不折叠。
 *
 * ★ 只归一化 Map 键：对外传递的值一律保持原始串 —— `--hclaw-workspace`（渲染端回传、
 *   与 DB 精确匹配）、`basename` 标题、`startWatcher`/`deleteGitRepoCache`/
 *   `invalidateStatusCache`（三者自身归一化）、`handleSendToConversation` 的
 *   workspacePath 与 listByWorkspace（DB 用 `WHERE workspace_path = ?` 精确匹配）。
 */
function wsKey(ws: string): string {
  const resolved = resolve(ws)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sendToWindow(channel: string, workspace: string, data: unknown): void {
  const entry = projectWindows.get(wsKey(workspace))
  if (entry && !entry.win.isDestroyed()) entry.win.webContents.send(channel, workspace, data)
}

export function openProjectManagerWindow(workspacePath: string): BrowserWindow {
  const key = wsKey(workspacePath)
  const existing = projectWindows.get(key)
  if (existing) {
    if (!existing.win.isDestroyed()) {
      existing.win.focus()
      return existing.win
    }
    projectWindows.delete(key) // 清理死条目（crash 后 closed 未触发的兜底）
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
  projectWindows.set(key, {win, workspacePath})
  win.on('closed', () => {
    // 用创建时捕获的 key 删除（不重算），保证与 set 严格配对
    projectWindows.delete(key)
    void stopWatcher(workspacePath)
    // 模块级缓存按 workspace 键控，窗口关闭是唯一的生产侧回收时机：
    // 不做兜底清理的话，每个打开过的工作区会永久占一个 Map key（见 watcher 的 refcount 范式）。
    deleteGitRepoCache(workspacePath)
    invalidateStatusCache(workspacePath)
    // QuickOpen 检索服务：文件清单缓存与 Find in Files 会话（含长驻 rg 子进程）同属窗口级资源，
    // 一并回收——否则关窗后 rg 进程仍在扫描，缓存条目也永久占位。
    deleteFileListCache(workspacePath)
    disposeSearchSessions(workspacePath)
    // 注：不在此处停止 git 分支监听。该 watch 的唯一属主是主窗口（conversationStore 的
    // workspace:getGitBranch / setCurrent 驱动），项目管理窗口从不调用它；在此停止只会在
    // 「本窗口工作区恰等于主窗口当前工作区」时误停主窗口的监听。生命周期收口在 before-quit。
  })
  startWatcher(workspacePath, sendToWindow)
  return win
}

export function getProjectWindowCount(workspacePath: string): number {
  const entry = projectWindows.get(wsKey(workspacePath))
  return entry && !entry.win.isDestroyed() ? 1 : 0
}

/** 主进程 before-quit 时全量停止 watcher（防 closed 未触发的泄露） */
export function stopAllWatchers(): void {
  // ★ 用条目内保存的**原始** workspacePath：watcher 的 key 是 resolve(原始串)，
  //   传归一化后的 key（win32 下已折叠大小写）会与条目对不上而静默漏停。
  for (const {workspacePath} of projectWindows.values()) void stopWatcher(workspacePath)
}

/** pm:send-to-conversation:ack 当前注册的 handler（重复 init 时用同一引用先 removeListener） */
let sendToConversationAckHandler: ((event: Electron.IpcMainEvent, payload: {requestId: string; ok: boolean; error?: string; started?: boolean}) => void) | null = null

export function initProjectManagerIPC(): void {
  // 注：pm:list-directory / pm:read-file 的路径校验在 listDirectory / readFileForViewer
  // 内部通过 assertInWorkspace 完成；pm:git-diff-file / pm:git-add / pm:git-rm-cached
  // 在 handler 入口对路径参数显式 assertInWorkspace 校验（词法校验，不依赖文件存在）
  // 首开性能（spec 2026-09-21）：不再等待 getGitStatusCached 的全量 git status 扫描，
  // 列表立即返回（gitStatus 恒 'none'）；文件行徽章由渲染层从 gitStatusStore.statusMap 派生
  safeHandle('pm:list-directory', (_e, ws: string, dirPath: string) => listDirectory(ws, dirPath))
  safeHandle('pm:read-file', (_e, ws: string, filePath: string) => readFileForViewer(ws, filePath))
  // ── QuickOpen 检索服务（薄壳：规则全在 search.ts，此处只做入口校验）──
  // 空查询直接返回空结果，不进扫描（对齐 spec「空输入不发请求」）
  safeHandle('pm:search-files', (_e, ws: string, query: string, limit?: number) => {
    if (typeof query !== 'string' || query.trim() === '') return []
    return searchFiles(ws, query, limit)
  })
  // 路径入口校验（词法校验，不依赖文件存在）；readLines 内部亦自校验，二者互不替代
  safeHandle('pm:read-lines', (_e, ws: string, relPath: string, startLine: number, endLine: number) => {
    assertInWorkspace(ws, relPath)
    return readLines(ws, relPath, startLine, endLine)
  })
  safeHandle('pm:find-in-files-start', (_e, ws: string, query: string) => startFindInFiles(ws, query))
  // sessionId 已隐含 workspace 归属，故 page / stop 不再带 ws 参数（契约冻结）
  safeHandle('pm:find-in-files-page', (_e, sessionId: string, offset: number, limit: number) =>
    getFindInFilesPage(sessionId, offset, limit))
  safeHandle('pm:find-in-files-stop', (_e, sessionId: string) => stopFindInFiles(sessionId))
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
        const entry = projectWindows.get(wsKey(ws))
        return !!entry && !entry.win.isDestroyed() && entry.win.webContents === sender
      },
      // existing 目标归属校验：动态 import 避免 sqlite 仓库在模块加载期被拉起
      listConvIds: async (ws) => {
        const {createConversationRepository} = await import('../repositories')
        return createConversationRepository().listByWorkspace(ws).map(c => c.id)
      },
      getMainWindow,
    }))
  // ★ ipcMain.on 走 EventEmitter，listenerCount 判定确实有效，但其语义是「跳过重复注册」
  //   而非「替换」：重复 init 时旧 handler 会随守卫一起被保留（旧的闭包残留）。对齐
  //   safeHandle 的既有正确实现——用同一引用先 removeListener，再注册新 handler。
  if (sendToConversationAckHandler) {
    ipcMain.removeListener('pm:send-to-conversation:ack', sendToConversationAckHandler)
  }
  sendToConversationAckHandler = (e, p) => {
    const mw = getMainWindow()
    if (!mw || mw.isDestroyed() || mw.webContents !== e.sender) return
    resolveSendToConversationAck(p)
  }
  ipcMain.on('pm:send-to-conversation:ack', sendToConversationAckHandler)
}
