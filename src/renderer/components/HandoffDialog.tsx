import {useState} from 'react'
import {useConversationStore} from '../stores/conversationStore'

export type HandoffChoice = 'handoff' | 'continue' | 'cancel'

export interface HandoffDialogProps {
  conversationId: string
  /** 上下文占用比例（0-1） */
  ratio: number
  windowTokens: number
  estimatedTokens: number
  onChoice: (choice: HandoffChoice) => void
}

/**
 * 发送前交接引导弹窗（spec 3.2）：
 * 三按钮（交接并新建会话 / 继续在当前会话执行 / 取消发送）+ "本会话不再提醒"复选框。
 * 样式参照现有 Dialog 组件（如 ConfirmDialog/MCPErrorHelper）的类名约定；
 * CSS 变量沿用项目 token（--surface / --surface-muted / --border / --text-*）。
 */
export function HandoffDialog({conversationId, ratio, windowTokens, estimatedTokens, onChoice}: HandoffDialogProps) {
  const [dismissSession, setDismissSession] = useState(false)
  const dismissHandoffPrompt = useConversationStore((s) => s.dismissHandoffPrompt)
  const pct = Math.round(ratio * 100)
  const hK = Math.round(estimatedTokens / 1000)
  const wK = Math.round(windowTokens / 1000)

  const choose = (choice: HandoffChoice) => {
    if (dismissSession) dismissHandoffPrompt(conversationId)
    onChoice(choice)
  }

  return (
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title">
        <h3 id="handoff-dialog-title" className="mb-2 text-lg font-semibold">上下文接近有效容量</h3>
        <div className="mb-4 space-y-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          <p>
            当前会话已使用约 <strong className="text-[var(--text-primary)]">{pct}%</strong>
            （约 {hK}K / {wK}K token）。
          </p>
          <p>继续在本会话执行：工具结果持续累积，可能接近模型有效容量，响应质量下降，甚至触发窗口超限报错。</p>
          <p>交接：自动总结本会话历史并在新会话继续，关键上下文随总结保留。</p>
          <p className="text-xs">（可在 设置 → Agent → 交接引导阈值 调整此提醒的触发线）</p>
        </div>
        <label className="mb-4 flex items-center justify-end gap-2 text-xs text-[var(--text-secondary)]">
          <span>本会话不再提醒</span>
          <input
            type="checkbox"
            checked={dismissSession}
            onChange={(e) => setDismissSession(e.target.checked)}
            className="w-4 h-4"
          />
        </label>
        <div className="flex justify-end gap-3">
          <button className="rounded-lg px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" onClick={() => choose('cancel')}>
            取消发送
          </button>
          <button className="rounded-lg px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" onClick={() => choose('continue')}>
            继续在当前会话执行
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500"
            onClick={() => choose('handoff')}
          >
            交接并新建会话
          </button>
        </div>
      </div>
    </div>
  )
}
