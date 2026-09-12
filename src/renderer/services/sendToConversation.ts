// src/renderer/services/sendToConversation.ts
import {useConversationStore} from '../stores/conversationStore'
import {useAgentStore} from '../stores/agentStore'
import type {SendToConversationPayload} from '@shared/types/project-manager'

/**
 * 主窗口渲染进程侧的「发送到会话」执行器（spec §5.3）。
 * 只有主窗口渲染进程能创建会话 / 生成 user 气泡 / 启动 loop，
 * 故本函数由 App.tsx 订阅 `pm:send-to-conversation:deliver` 后调用。
 * 回执语义：ack.ok 表示「user 消息已插入主窗口渲染端」；额外的 started 表示
 * agent loop 是否已启动/正在处理（true = 已启动或注入成功，false = 仅插入未启动）。
 */
export async function handleSendToConversation(
  payload: SendToConversationPayload,
  ack: (r: {ok: boolean; error?: string; started?: boolean}) => void,
): Promise<void> {
  try {
    // ① 工作区对齐：PM 窗口项目 ≠ 主窗口项目时切过去
    if (useConversationStore.getState().currentWorkspacePath !== payload.workspacePath) {
      await useConversationStore.getState().setWorkspace(payload.workspacePath)
    }

    // ② 建/激活会话
    let convId: string
    if (payload.target.kind === 'new') {
      convId = await useConversationStore.getState().createConversation(payload.title)
    } else {
      convId = payload.target.conversationId
      await useConversationStore.getState().setActiveConversation(convId)
    }

    // ③ 竞态修复：先确保目标会话消息已从磁盘水合。
    //    setWorkspace 对首个根会话是 fire-and-forget loadMessages（conversationStore.ts:467），
    //    若在它落地前写入 user 气泡，会被随后的整体替换（loadMessages）覆盖。
    await useConversationStore.getState().loadMessagesInitial(convId)

    // ④ 运行态以主进程 agent-status 为权威（渲染端 convAgentStates 可能滞后）
    const st = await window.electronAPI?.agentStatus?.(convId)
    const isRunning = Boolean(st?.running)

    // ⑤ 写 user 气泡（主进程 startAgentCore 刷盘但不向渲染端回放 user 消息）
    useConversationStore.getState().addMessageToConv(convId, {role: 'user', content: payload.content})

    // ⑥ 运行中 → 注入；否则 → 启动 loop
    let started: boolean
    if (isRunning) {
      const injected = await window.electronAPI?.agentInjectMessage?.({conversationId: convId, content: payload.content})
      if (injected?.success) {
        started = true
      } else {
        // 注入失败兜底：不能再依赖 pendingMessages（它只在收到 agent `done` 时被续跑；
        // 若主进程实际无活跃 loop，消息会永不被消费 → 静默丢失）。
        // 改为直接启动 loop（startAgent 对重复启动安全：agentManager.start 会 abort+重建）。
        useAgentStore.getState().startAgent({conversationId: convId, message: payload.content, force: true})
        started = false
      }
    } else {
      // force: true —— 已用主进程 agentStatus 确认非运行，绕过渲染端残留态守卫
      // （paused/thinking/running 残留会静默 no-op，导致 agent 永不启动）
      useAgentStore.getState().startAgent({conversationId: convId, message: payload.content, force: true})
      started = true
    }

    ack({ok: true, started})
  } catch (err) {
    ack({ok: false, error: err instanceof Error ? err.message : String(err)})
  }
}

/**
 * 注册主进程投递的订阅（App.tsx 在挂载时调用一次）。
 * 返回 cleanup；`electronAPI.receive` 缺失时返回空 cleanup（测试/降级环境）。
 */
export function registerSendToConversationListener(): () => void {
  const cleanup = window.electronAPI?.receive?.(
    'pm:send-to-conversation:deliver',
    // `receive` 的回调签名为 (...args: unknown[])（env.d.ts:725），
    // 故此处收 unknown 后在入口收窄一次（类型层面，无运行时行为差异）。
    (raw: unknown) => {
      const payload = raw as SendToConversationPayload
      const ack = (r: {ok: boolean; error?: string; started?: boolean}) =>
        window.electronAPI?.projectManager?.ackSendToConversation?.({requestId: payload?.requestId, ...r})
      void handleSendToConversation(payload, ack)
    },
  )
  return () => { cleanup?.() }
}
