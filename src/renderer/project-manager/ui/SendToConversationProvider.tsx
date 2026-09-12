import React, {createContext, useCallback, useContext, useMemo, useState} from 'react'
import {SendToConversationDialog} from './SendToConversationDialog'
import {buildContext, type SendToConversationContext} from '../lib/sendContext'
import {useWorkspaceStore} from '../stores/workspaceStore'

interface SendToConversationApi {
  /** 由 5 个入口调用：传入上下文形态，弹窗自动拼接指令 */
  request: (ctx: SendToConversationContext) => void
}

const SendToConversationCtx = createContext<SendToConversationApi | null>(null)

/**
 * 取得「发送到会话」入口。**无 Provider 时返回 null 而非抛错**——
 * 5 个入口（文件树/变更列表/编辑器/commit 列表/详情）的既有单测均独立渲染这些组件，
 * 抛错会让它们整体失败；调用方一律写 `sendToConversation?.request(ctx)`。
 */
export function useSendToConversation(): SendToConversationApi | null {
  return useContext(SendToConversationCtx)
}

export function SendToConversationProvider({children}: {children: React.ReactNode}) {
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const [state, setState] = useState<{open: boolean; context: string}>({open: false, context: ''})

  const request = useCallback((ctx: SendToConversationContext) => {
    setState({open: true, context: buildContext(ctx, workspacePath)})
  }, [workspacePath])

  const close = useCallback(() => setState(s => ({...s, open: false})), [])
  const api = useMemo(() => ({request}), [request])

  return (
    <SendToConversationCtx.Provider value={api}>
      {children}
      <SendToConversationDialog
        open={state.open}
        context={state.context}
        workspacePath={workspacePath}
        onClose={close}
      />
    </SendToConversationCtx.Provider>
  )
}
