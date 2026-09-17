// src/renderer/services/openConversation.ts
import {useConversationStore} from '../stores/conversationStore'
import type {OpenConversationPayload, OpenConversationResult} from '@shared/types/openConversation'

/**
 * 主窗口渲染进程侧的「打开会话」执行器（配置窗口 → 主进程 → 主窗口）。
 *
 * 为什么必须跨窗口：定时任务等对话框跑在**独立窗口**（ConfigDialogWindow，dialogType='schedules'）。
 * 那个窗口从不调用 `conversationStore.loadConversations()`（只有 App.tsx 主窗口、
 * ConversationsDialog、LlmLogsWindow 调），其 store 里 `currentWorkspacePath` 恒为 null、
 * 会话列表为空——在它内部调 `setActiveConversation` 只改到**它自己进程**的 store，
 * 主窗口完全不知情：用户看到的「跳转」从未生效，还会因为 workspacePath 与 null 不等
 * 而每次都弹「不在当前工作目录」的误报。
 * 故由配置窗口投递、主进程转发、**主窗口**执行「切工作区 + 激活会话」，再回执结果。
 *
 * 回执语义：ack.ok 表示主窗口已切到目标工作区并激活目标会话。
 */
export async function handleOpenConversation(
  payload: OpenConversationPayload,
  ack: (r: OpenConversationResult) => void,
): Promise<void> {
  try {
    // 只有普通主窗口执行；配置窗口自身不处理（防御性，正常不会走到：主进程只投递给主窗口）
    if (window.electronAPI?.dialogType) {
      ack({ok: false, error: '本窗口不处理该操作'})
      return
    }
    await useConversationStore.getState().openConversationInWorkspace(payload.conversationId, payload.workspacePath)
    ack({ok: true})
  } catch (err) {
    ack({ok: false, error: err instanceof Error ? err.message : String(err)})
  }
}

/**
 * 注册主进程投递的订阅（App.tsx 在挂载时调用一次）。
 * 返回 cleanup；`electronAPI.receive` 缺失时返回空 cleanup（测试/降级环境）。
 */
export function registerOpenConversationListener(): () => void {
  const cleanup = window.electronAPI?.receive?.(
    'app:open-conversation:deliver',
    // `receive` 的回调签名为 (...args: unknown[])（env.d.ts），
    // 故此处收 unknown 后在入口收窄一次（类型层面，无运行时行为差异）。
    (raw: unknown) => {
      const payload = raw as OpenConversationPayload
      const ack = (r: OpenConversationResult) =>
        window.electronAPI?.app?.ackOpenConversation?.({requestId: payload?.requestId, ...r})
      void handleOpenConversation(payload, ack)
    },
  )
  return () => { cleanup?.() }
}
