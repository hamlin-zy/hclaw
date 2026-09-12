import React, {useCallback, useEffect, useState} from 'react'
import type {ConversationMeta} from '@shared/types/infra'
import {SessionPicker} from '../components/SessionPicker'
import {pickSessionCandidates} from '../lib/sessionCandidates'
import {composeContent} from '../lib/sendContext'
import {deriveConversationTitle} from '../../utils/conversationTitle'

/**
 * 「发送到会话」弹窗（spec §4.4）：
 * 上方只读上下文预览 + 下方指令输入框 + 目标二选一（新会话 / 指定会话）。
 * 提交后 invoke 主进程；失败（含主进程 3s 超时返回的 ok:false）在此内联报错。
 */
export function SendToConversationDialog({open, context, workspacePath, onClose}: {
  open: boolean
  context: string
  workspacePath: string
  onClose: () => void
}) {
  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [candidates, setCandidates] = useState<ConversationMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  // 每次打开重置全部状态
  useEffect(() => {
    if (!open) return
    setInstruction('')
    setMode('new')
    setSelectedId(null)
    setError(null)
    setWarning(null)
    setSending(false)
  }, [open])

  // 拉取候选会话（父级传入项目路径）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const all = await window.electronAPI?.conversationListByWorkspace?.(workspacePath) || []
      if (cancelled) return
      setCandidates(pickSessionCandidates(all as ConversationMeta[]))
    })()
    return () => { cancelled = true }
  }, [open, workspacePath])

  // warning 存在 → 禁发（避免重复插入同一条消息）；用户可点「取消」关闭
  const canConfirm = instruction.trim() !== '' && (mode === 'new' || !!selectedId) && !sending && !warning

  const confirm = useCallback(async () => {
    if (!canConfirm) return
    setSending(true)
    setError(null)
    setWarning(null)
    const target = mode === 'new'
      ? {kind: 'new' as const}
      : {kind: 'existing' as const, conversationId: selectedId!}
    try {
      const res = await window.electronAPI?.projectManager?.sendToConversation?.({
        requestId: crypto.randomUUID(),
        workspacePath,
        content: composeContent(context, instruction),
        title: mode === 'new' ? deriveConversationTitle(instruction) : undefined,
        target,
      })
      if (res && res.ok) {
        // started === false：user 消息已插入，但 agent loop 未确认启动 → 保持弹窗打开，提示手动重试
        if (res.started === false) {
          setWarning('消息已插入会话，但 agent 未启动；请打开该会话手动重试。')
          return
        }
        onClose(); return
      }
      setError(res?.error || '发送失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [canConfirm, context, instruction, mode, onClose, selectedId, workspacePath])

  if (!open) return null

  return (
    <div className="pm-send-dialog-backdrop" data-testid="pm-send-dialog">
      <div role="dialog" aria-modal="true" aria-label="发送到会话" className="pm-send-dialog">
        <div className="pm-send-dialog-title">发送到会话</div>
        <pre className="pm-send-dialog-preview" data-testid="pm-send-dialog-preview">{context}</pre>
        <textarea
          className="pm-send-dialog-input"
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          placeholder="输入指令…"
          aria-label="指令"
          data-testid="pm-send-dialog-instruction"
        />
        <div className="pm-send-dialog-targets">
          <label>
            <input
              type="radio"
              name="pm-send-target"
              checked={mode === 'new'}
              onChange={() => setMode('new')}
            />
            使用新会话处理
          </label>
          <label>
            <input
              type="radio"
              name="pm-send-target"
              checked={mode === 'existing'}
              disabled={candidates.length === 0}
              onChange={() => setMode('existing')}
            />
            发送到指定会话处理
          </label>
        </div>
        {mode === 'existing' && (
          <SessionPicker items={candidates} value={selectedId} onChange={setSelectedId} />
        )}
        {error && <div className="pm-send-dialog-error" role="alert">{error}</div>}
        {warning && <div className="pm-send-dialog-error" role="status">{warning}</div>}
        <div className="pm-send-dialog-actions">
          <button type="button" className="pm-send-dialog-btn" onClick={onClose}>取消</button>
          <button
            type="button"
            className="pm-send-dialog-btn pm-send-dialog-btn--primary"
            disabled={!canConfirm}
            onClick={() => { void confirm() }}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
