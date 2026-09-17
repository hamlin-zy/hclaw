import {isAbsolute} from 'path'
import type {OpenConversationPayload, OpenConversationResult} from '@shared/types/openConversation'

/** 等待主窗口渲染进程回执的超时（对齐 project-manager/sendToConversation.ts） */
export const OPEN_CONVERSATION_ACK_TIMEOUT_MS = 3000

interface PendingEntry {
  resolve: (r: OpenConversationResult) => void
  timer: ReturnType<typeof setTimeout>
}

/** requestId → 挂起的 invoke resolver；ack 或超时后移除 */
const pending = new Map<string, PendingEntry>()

/** 清空所有挂起项（仅测试用） */
export function resetOpenConversationPending(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

type ValidateResult =
  | {ok: true; value: OpenConversationPayload}
  | {ok: false; error: string}

/** 载荷词法校验（主进程边界，不信任渲染端） */
export function validateOpenConversationPayload(payload: unknown): ValidateResult {
  if (!payload || typeof payload !== 'object') return {ok: false, error: '载荷非法'}
  const p = payload as Record<string, unknown>
  if (typeof p.requestId !== 'string' || p.requestId.trim() === '') return {ok: false, error: 'requestId 非法'}
  if (typeof p.conversationId !== 'string' || p.conversationId.trim() === '') return {ok: false, error: 'conversationId 非法'}
  if (typeof p.workspacePath !== 'string' || p.workspacePath.trim() === '' || !isAbsolute(p.workspacePath))
    return {ok: false, error: 'workspacePath 非法'}
  return {
    ok: true,
    value: {
      requestId: p.requestId,
      conversationId: p.conversationId,
      workspacePath: p.workspacePath,
    },
  }
}

/** 主窗口渲染进程回执到达：resolve 对应挂起项（不匹配则忽略） */
export function resolveOpenConversationAck(payload: {requestId: string; ok: boolean; error?: string}): void {
  if (!payload || typeof payload.requestId !== 'string') return
  const entry = pending.get(payload.requestId)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(payload.requestId)
  entry.resolve({ok: Boolean(payload.ok), error: payload.error})
}

export interface OpenConversationDeps {
  /** 校验 event.sender 是否为某个配置窗口的 webContents（且窗口仍打开） */
  isAllowedSender: (sender: Electron.WebContents) => boolean
  /** 列出该工作目录下的会话 id（归属校验用） */
  listConvIdsInWorkspace: (workspacePath: string) => Promise<string[]>
  getMainWindow: () => Electron.BrowserWindow | null | Promise<Electron.BrowserWindow | null>
}

/**
 * 主进程 handler：只做「校验 → 聚焦主窗口 → 转发 → 等待回执」。
 * 真正的会话切换在主窗口渲染进程执行（切工作区 + setActiveConversation）。
 */
export async function handleOpenConversation(
  payload: unknown,
  sender: Electron.WebContents,
  deps: OpenConversationDeps,
): Promise<OpenConversationResult> {
  const v = validateOpenConversationPayload(payload)
  if (!v.ok) return {ok: false, error: v.error}
  const value = v.value

  if (!deps.isAllowedSender(sender)) return {ok: false, error: '非法发送方'}

  const ids = await deps.listConvIdsInWorkspace(value.workspacePath)
  if (!ids.includes(value.conversationId)) return {ok: false, error: '目标会话不属于该工作目录'}

  const win = await deps.getMainWindow()
  if (!win || win.isDestroyed()) return {ok: false, error: '主窗口不可用'}
  if (win.webContents.isLoadingMainFrame()) return {ok: false, error: '主窗口未就绪'}
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()

  return await new Promise<OpenConversationResult>(resolve => {
    // 同 requestId 覆盖：先结算旧项（取消态）——旧 Promise 不结算即永挂起（调用方 await 卡死），
    // 旧 timer 也会成为孤儿并在超时时误删新 entry。先 delete 再 resolve：resolve 回调
    // 若同步重入登记同键，旧项已不在表中，不会被后续删除误伤新项。
    const prev = pending.get(value.requestId)
    if (prev) {
      clearTimeout(prev.timer)
      pending.delete(value.requestId)
      prev.resolve({ok: false, error: '请求已被覆盖'})
    }
    const timer = setTimeout(() => {
      // 仅当仍是当前 entry 时才删除（双保险，防旧 timer 误删新 entry）
      if (pending.get(value.requestId)?.timer === timer) pending.delete(value.requestId)
      resolve({ok: false, error: '主窗口未响应'})
    }, OPEN_CONVERSATION_ACK_TIMEOUT_MS)
    pending.set(value.requestId, {resolve, timer})
    try {
      win.webContents.send('app:open-conversation:deliver', value)
    } catch {
      clearTimeout(timer)
      pending.delete(value.requestId)
      resolve({ok: false, error: '主窗口未响应'})
    }
  })
}
