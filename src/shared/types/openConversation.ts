/** 跨窗口「打开会话」载荷（配置窗口 → 主进程 → 主窗口） */
export interface OpenConversationPayload {
  requestId: string
  conversationId: string
  workspacePath: string
}

/** 跨窗口「打开会话」结果（主窗口回执 / 主进程校验失败均用此结构） */
export interface OpenConversationResult {
  ok: boolean
  error?: string
}
