import {isAbsolute} from 'path'
import type {SendToConversationPayload, SendToConversationResult} from '@shared/types/project-manager'

/** 等待主窗口渲染进程回执的超时（spec §5.2） */
export const ACK_TIMEOUT_MS = 3000

interface PendingEntry {
  resolve: (r: SendToConversationResult) => void
  timer: ReturnType<typeof setTimeout>
}

/** requestId → 挂起的 invoke resolver；ack 或超时后移除 */
const pending = new Map<string, PendingEntry>()

/** 清空所有挂起项（仅测试用） */
export function resetSendToConversationPending(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

type ValidateResult =
  | {ok: true; value: SendToConversationPayload}
  | {ok: false; error: string}

/** 载荷词法校验（主进程边界，不信任渲染端） */
export function validateSendToConversationPayload(payload: unknown): ValidateResult {
  if (!payload || typeof payload !== 'object') return {ok: false, error: '载荷非法'}
  const p = payload as Record<string, unknown>
  if (typeof p.requestId !== 'string' || p.requestId.trim() === '') return {ok: false, error: 'requestId 非法'}
  if (typeof p.workspacePath !== 'string' || p.workspacePath.trim() === '' || !isAbsolute(p.workspacePath))
    return {ok: false, error: 'workspacePath 非法'}
  if (typeof p.content !== 'string' || p.content.trim() === '') return {ok: false, error: 'content 非法'}
  if (p.title !== undefined && typeof p.title !== 'string') return {ok: false, error: 'title 非法'}
  if (!p.target || typeof p.target !== 'object') return {ok: false, error: 'target 非法'}
  const t = p.target as Record<string, unknown>
  let target: SendToConversationPayload['target']
  if (t.kind === 'new') {
    target = {kind: 'new'}
  } else if (t.kind === 'existing') {
    if (typeof t.conversationId !== 'string' || !/^conv-/.test(t.conversationId))
      return {ok: false, error: 'conversationId 非法'}
    target = {kind: 'existing', conversationId: t.conversationId}
  } else {
    return {ok: false, error: 'target.kind 非法'}
  }
  return {
    ok: true,
    value: {
      requestId: p.requestId,
      workspacePath: p.workspacePath,
      content: p.content,
      title: p.title as string | undefined,
      target,
    },
  }
}

/** 主窗口渲染进程回执到达：resolve 对应挂起项（不匹配则忽略） */
export function resolveSendToConversationAck(payload: {requestId: string; ok: boolean; error?: string; started?: boolean}): void {
  if (!payload || typeof payload.requestId !== 'string') return
  const entry = pending.get(payload.requestId)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(payload.requestId)
  entry.resolve({ok: Boolean(payload.ok), error: payload.error, started: payload.started})
}

export interface SendToConversationDeps {
  /** 校验 event.sender 是否为该 workspace 的 PM 窗口的 webContents（且窗口仍打开） */
  isPmSender: (ws: string, sender: Electron.WebContents) => boolean
  /** 列出该 workspace 的会话 id（existing 目标归属校验用） */
  listConvIds: (ws: string) => Promise<string[]>
  getMainWindow: () => Electron.BrowserWindow | null
}

/**
 * 主进程 handler：只做「校验 → 聚焦主窗口 → 转发 → 等待回执」。
 * 真正的会话/消息/loop 逻辑在主窗口渲染进程执行（见 src/renderer/services/sendToConversation.ts）。
 */
export async function handleSendToConversation(
  payload: unknown,
  sender: Electron.WebContents,
  deps: SendToConversationDeps,
): Promise<SendToConversationResult> {
  const v = validateSendToConversationPayload(payload)
  if (!v.ok) return {ok: false, error: v.error}
  const value = v.value

  if (!deps.isPmSender(value.workspacePath, sender)) return {ok: false, error: '非法发送方'}

  if (value.target.kind === 'existing') {
    const ids = await deps.listConvIds(value.workspacePath)
    if (!ids.includes(value.target.conversationId)) return {ok: false, error: '目标会话不属于该项目'}
  }

  const win = deps.getMainWindow()
  if (!win || win.isDestroyed()) return {ok: false, error: '主窗口不可用'}
  if (win.webContents.isLoadingMainFrame()) return {ok: false, error: '主窗口未就绪'}
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()

  return await new Promise<SendToConversationResult>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(value.requestId)
      resolve({ok: false, error: '主窗口未响应'})
    }, ACK_TIMEOUT_MS)
    pending.set(value.requestId, {resolve, timer})
    try {
      win.webContents.send('pm:send-to-conversation:deliver', value)
    } catch {
      clearTimeout(timer)
      pending.delete(value.requestId)
      resolve({ok: false, error: '主窗口未响应'})
    }
  })
}
