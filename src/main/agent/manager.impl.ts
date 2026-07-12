/**
 * AgentManager 实现
 */

import {Worker} from 'worker_threads'
import {BrowserWindow} from 'electron'
import * as path from 'path'
import {WORKER_MESSAGE_TYPES} from './constants'
import type {AgentStreamEvent} from './stream'
import type {AgentTemplate, LlmCallLog, SystemSettings} from '@shared/types'
import type {ChatMessage, ModelConfig} from './model/types'
import {permissionEngine} from './tools/permission'
import {addLlmCallLog} from '../utils/llmCallLogStore'
import {gracefulRestart} from '../utils/restart'
import {HookExecutor} from '../plugin/hooks'
import {capabilityManager} from './capabilityManager'
import type {SerializableCapabilities} from '../common/capabilitySerializer'
import {logger} from './logger'
import {mcpWorkerManager, setAgentManagerRef} from './mcp/mcpWorkerManager'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {eventBus, MCPThemeEvents} from '../common/eventBus'

// 导入拆分模块
import type {
  AgentStartParams,
  PendingAssistantMsg,
  WorkerEntry,
} from './manager.types'
import {
  WORKER_GRACEFUL_SHUTDOWN_MS,
  SKIP_LOG_EVENT_TYPES,
} from './manager.constants'
import {createPendingMsg, normalizeToolResult} from './manager.accumulator'
import {doMergeAndPersist} from './manager.persister'
import {backupOldMessagesToDisk} from './manager.backup'
import {loadPluginAgents} from './manager.pluginAgents'

// ─── AgentManager ──────────────────────────────────────

export class AgentManager {
  /** conversationId → WorkerEntry */
  private workers: Map<string, WorkerEntry> = new Map()
  private mainWindow: BrowserWindow | null = null

  /** 外部模块注册的流事件监听器 */
  private streamListeners: Map<string, Set<(event: AgentStreamEvent) => void>> = new Map()

  /** 当前正在流式构建的 assistant 消息（每个会话最多一条） */
  private pendingAssistantMsg: Map<string, PendingAssistantMsg | null> = new Map()

  /** 跨轮追踪：tool_result 完成后，下一次 text 事件需重置 pending，开启新回合 */
  private pendingNeedsTurnReset: Set<string> = new Set()

  constructor() {
    eventBus.on(MCPThemeEvents.TOOLS_REFRESHED, () => {
      this.broadcastMcpToolsRefresh()
    })
  }

  /** 设置主窗口引用 */
  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
    // 延迟设置避免循环依赖
    setAgentManagerRef({
      workers: this.workers as Map<string, { worker: Worker }>,
    } as Parameters<typeof setAgentManagerRef>[0])

    if (win) {
      const hookExecutor = HookExecutor.getInstance()
      hookExecutor.onResult((event: string, hookName: string, result: {allowed: boolean; error?: string}) => {
        this.forwardToRenderer('__hooks__', {
          type: 'hook_result',
          event,
          hookName,
          success: result.allowed && !result.error,
          error: result.error || undefined,
        })
      })
    }
  }

  /**
   * 注册流事件监听器
   * @returns 取消监听的清理函数
   */
  addStreamListener(conversationId: string, listener: (event: AgentStreamEvent) => void): () => void {
    if (!this.streamListeners.has(conversationId)) {
      this.streamListeners.set(conversationId, new Set())
    }
    this.streamListeners.get(conversationId)!.add(listener)
    return () => {
      this.streamListeners.get(conversationId)?.delete(listener)
    }
  }

  /** 通知指定会话的流事件监听器 */
  private notifyStreamListeners(conversationId: string, event: AgentStreamEvent): void {
    const listeners = this.streamListeners.get(conversationId)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (err) {
          logger.error('[AgentManager] stream listener error:', {error: err as Error})
        }
      }
    }
  }

  // ─── Worker 生命周期管理 ───────────────────────────────

  /** 启动 Agent Worker Thread */
  async start(params: AgentStartParams): Promise<void> {
    if (this.workers.has(params.conversationId)) {
      await this.abort(params.conversationId, false)
    }

    const abortController = new AbortController()
    const workerPath = path.join(__dirname, 'worker.js')

    // 加载配置
    const defaultSettings: SystemSettings = {
      agent: {maxTurns: 500, retryCount: 10, initialRetryDelay: 5000, maxRetryDelay: 120000, llmTimeout: 600000},
      model: {defaultMaxTokens: 8000, defaultTemperature: 0},
      mcp: {mcpTestTimeout: 15000},
      ui: {language: 'zh-CN', theme: 'system'},
      subagent: {maxConcurrency: 3, defaultTimeout: 15 * 60 * 1000, retryAttempts: 0, priorityEnabled: false},
    }
    let initialSettings: SystemSettings | null = null
    try {
      initialSettings = systemSettingsRepo.getJson<SystemSettings>('settings') || defaultSettings
    } catch (err) {
      logger.warn('[AgentManager] loadSettingsFailed', {error: err})
      initialSettings = defaultSettings
    }

    // 获取序列化的能力列表
    let capabilities = params.capabilities
    if (!capabilities) {
      try {
        capabilities = await capabilityManager.serializeForWorker()
      } catch (err) {
        logger.warn('[AgentManager] serializeCapabilitiesFailed', {error: err})
      }
    }

    // 初始化 pending
    this.pendingAssistantMsg.set(params.conversationId, null)

    const workerParams = {...params, settings: initialSettings, capabilities}

    const worker = new Worker(workerPath, {
      type: 'module' as const,
      workerData: {type: 'start', params: workerParams},
    } as unknown as ConstructorParameters<typeof Worker>[1])

    const entry: WorkerEntry = {
      worker,
      conversationId: params.conversationId,
      abortController,
    }

    // 通知渲染进程该会话的 Agent 已启动
    this.forwardToRenderer(params.conversationId, {type: 'begin'})

    // 监听 Worker 消息
    worker.on('message', this.createMessageHandler(params.conversationId, worker))
    worker.on('error', (err: unknown) => this.onWorkerError(params.conversationId, err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', (code) => this.onWorkerExit(params.conversationId, worker, code))

    this.workers.set(params.conversationId, entry)
  }

  /** 创建 Worker 消息处理器 */
  private createMessageHandler(conversationId: string, worker: Worker) {
    return async (msg: {
      type: string
      conversationId: string
      event?: AgentStreamEvent
      error?: string
      requestId?: string
      message?: string
    }) => {
      try {
        // 权限确认请求
        if (msg.type === WORKER_MESSAGE_TYPES.PERMISSION_CONFIRM) {
          this.forwardToRenderer(msg.conversationId, {
            type: 'permission_confirm',
            question: msg.message || '',
            requestId: msg.requestId,
          })
          return
        }

        // 用户提问请求
        if (msg.type === WORKER_MESSAGE_TYPES.ASK_USER_QUESTION) {
          const askUserMsg = msg as {requestId: string; question?: string; options?: string[]; multiSelect?: boolean}
          this.forwardToRenderer(msg.conversationId, {
            type: 'ask_user',
            question: askUserMsg.question || '',
            options: askUserMsg.options,
            multiSelect: askUserMsg.multiSelect,
            requestId: askUserMsg.requestId,
          })
          return
        }

        // MCP MessagePort 请求
        if (msg.type === 'request_mcp_port') {
          const {agentPort} = mcpWorkerManager.createAgentPort()
          worker.postMessage({type: 'mcp_port', port: agentPort}, [agentPort])
          return
        }

        // 渠道消息发送请求
        if (msg.type === WORKER_MESSAGE_TYPES.CHANNEL_SEND) {
          await this.handleChannelSend(worker, msg as unknown as {
            channelId: string; toUser: string; text: string; contextToken?: string; conversationId: string; requestId: string
          })
          return
        }

        // 渠道媒体文件发送请求
        if (msg.type === WORKER_MESSAGE_TYPES.CHANNEL_SEND_MEDIA) {
          await this.handleChannelSendMedia(worker, msg as unknown as {
            channelId: string; toUser: string; filePath: string; fileType: string; contextToken?: string; conversationId: string; requestId: string
          })
          return
        }

        // 同步权限规则
        if (msg.type === WORKER_MESSAGE_TYPES.SYNC_PERMISSION_RULES) {
          await permissionEngine.reloadRules()
          this.forwardToRenderer(msg.conversationId, {type: 'permission-rules-updated'})
          return
        }

        // Agent 结束后残留的注入消息：保存到会话历史并通知渲染层
        if (msg.type === WORKER_MESSAGE_TYPES.PENDING_MESSAGES_AFTER_EXIT) {
          const exitMsg = (msg as unknown) as { conversationId: string; messages: Array<{ content: string; id: string }> }
          await this.handlePendingMessagesAfterExit(exitMsg.conversationId, exitMsg.messages || [])
          return
        }

        // 流事件处理
        if (msg.type === 'stream' && msg.event) {
          await this.handleStreamEvent(conversationId, worker, msg.event)
        } else if (msg.type === 'error') {
          this.forwardToRenderer(msg.conversationId, {
            type: 'error',
            error: msg.error || 'Worker error',
          })
          HookExecutor.getInstance().execute('StopFailure', {
            sessionId: msg.conversationId,
            error: msg.error || 'Unknown error',
          }).catch((err) => logger.warn('[AgentManager] StopFailure hook failed', {error: err}))
        }
      } catch (err: unknown) {
        logger.error('[AgentManager] messageHandlerFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** 处理流事件 */
  private async handleStreamEvent(conversationId: string, _worker: Worker, event: AgentStreamEvent): Promise<void> {
    // ── 用户注入消息：持久化当前 assistant 消息并重置，开启新消息 ──
    if (event.type === 'user_message_injected') {
      const oldPending = this.pendingAssistantMsg.get(conversationId)
      if (oldPending) {
        await doMergeAndPersist(conversationId, oldPending, true)
      }
      this.pendingAssistantMsg.set(conversationId, null)
      // 将旧 messageId 附带在事件上，让渲染进程知道哪个消息已完成
      if (oldPending?.id) {
        ;(event as Record<string, unknown>).messageId = oldPending.id
      }
      this.forwardToRenderer(conversationId, event)
      return
    }

    // 通知外部流事件监听器
    this.notifyStreamListeners(conversationId, event)

    // 累积消息
    this.pendingAssistantMsg.set(
      conversationId,
      this.accumulateEvent(conversationId, event),
    )

    // ★ 修复重复 assistant 消息：将主进程 pending.id 注入事件，
    // 使渲染进程复用同一 ID，避免两个路径使用不同 ID 写入 DB 导致重复
    const pending = this.pendingAssistantMsg.get(conversationId)
    if (pending?.id) {
      ;(event as Record<string, unknown>).messageId = pending.id
    }

    // settings-updated 事件：直接发送到渲染进程
    if (event.type === 'settings-updated') {
      this.sendToMainWindow('settings-updated', (event as {type: 'settings-updated'; settings: SystemSettings}).settings)
      return
    }

    // schedules-changed 事件：通知渲染进程刷新定时任务列表
    if (event.type === 'schedules-changed') {
      this.sendToMainWindow('schedules-changed')
      return
    }

    // app-restart 事件
    if (event.type === 'app-restart') {
      await gracefulRestart()
      return
    }

    // llm_call_done 事件
    if (event.type === 'llm_call_done') {
      this.logLlmCall(event as Extract<AgentStreamEvent, {type: 'llm_call_done'}>)
    } else if (event.type === 'subagent_progress' && (event as {subAgentStreamEvent?: AgentStreamEvent}).subAgentStreamEvent?.type === 'llm_call_done') {
      this.logLlmCall((event as {subAgentStreamEvent: AgentStreamEvent}).subAgentStreamEvent as Extract<AgentStreamEvent, {type: 'llm_call_done'}>)
    }

    // compact_persist 事件
    if (event.type === 'compact_persist') {
      await this.handleCompactPersist(conversationId, event as {
        messages: ChatMessage[]
        beforeTokens: number
        afterTokens: number
        savedTokens: number
        message: string
      })
      return
    }

    // done 事件
    if (event.type === 'done') {
      const doneEvent = event as {type: 'done'; reason: 'completed' | 'aborted' | 'error'}
      await this.handleDoneEvent(conversationId, doneEvent)
      return
    }

    // error 事件
    if (event.type === 'error') {
      await this.handleErrorEvent(conversationId, (event as {type: 'error'; error: string}).error || 'Unknown error')
      return
    }

    this.forwardToRenderer(conversationId, event)
  }

  /** 向 Worker 回传渠道发送结果 */
  private postChannelResult(conversationId: string, requestId: string, result: {success: boolean; error?: string}): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({
        type: WORKER_MESSAGE_TYPES.CHANNEL_SEND_RESULT,
        requestId,
        success: result.success,
        error: result.error,
      })
    }
  }

  /** 处理渠道消息发送 */
  private async handleChannelSend(
    _worker: Worker,
    msg: {channelId: string; toUser: string; text: string; contextToken?: string; conversationId: string; requestId: string},
  ): Promise<void> {
    try {
      const {channelManager} = await import('../channel/ChannelManager')
      const result = await channelManager.sendViaWorker(msg.channelId, msg.toUser, msg.text, msg.contextToken)
      this.postChannelResult(msg.conversationId, msg.requestId, result)
    } catch (err: unknown) {
      this.postChannelResult(msg.conversationId, msg.requestId, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 处理渠道媒体文件发送 */
  private async handleChannelSendMedia(
    _worker: Worker,
    msg: {channelId: string; toUser: string; filePath: string; fileType: string; contextToken?: string; conversationId: string; requestId: string},
  ): Promise<void> {
    try {
      const {channelManager} = await import('../channel/ChannelManager')
      const result = await channelManager.sendMediaViaWorker(msg.channelId, msg.toUser, msg.filePath, msg.fileType, msg.contextToken)
      this.postChannelResult(msg.conversationId, msg.requestId, result)
    } catch (err: unknown) {
      this.postChannelResult(msg.conversationId, msg.requestId, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 处理 compact_persist 事件 */
  private async handleCompactPersist(
    conversationId: string,
    event: {
      messages: ChatMessage[]
      beforeTokens: number
      afterTokens: number
      savedTokens: number
      message: string
    },
  ): Promise<void> {
    const {persistCompactedMessages} = await import('./manager.persister')
    const persisted = await persistCompactedMessages(conversationId, event)
    if (persisted) {
      this.forwardToRenderer(conversationId, {
        type: 'compact_persisted',
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        savedTokens: event.savedTokens,
        compactedMessages: event.messages.length, // 类型按 stream.ts 定义
        message: event.message,
      })
    } else {
      logger.error('[TRACE-compact_persist] 持久化失败')
      this.forwardToRenderer(conversationId, {
        type: 'error',
        error: '压缩结果持久化失败，历史消息未变更',
      })
    }
  }

  /** 处理 done 事件 */
  private async handleDoneEvent(
    conversationId: string,
    event: {type: 'done'; reason: 'completed' | 'aborted' | 'error'},
  ): Promise<void> {
    try {
      await doMergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
    } catch (err) {
      logger.error('[AgentManager] 持久化异常', {error: err})
    }

    this.forwardToRenderer(conversationId, event)

    if (event.reason === 'completed') {
      const lastMsgs = this.extractLastLoopMessages(conversationId)
      HookExecutor.getInstance().execute('Stop', {
        sessionId: conversationId,
        lastMessages: lastMsgs,
        reason: 'completed',
      }).catch((err) => logger.warn('[AgentManager] Stop hook failed', {error: err}))
    } else if (event.reason === 'error') {
      HookExecutor.getInstance().execute('StopFailure', {
        sessionId: conversationId,
        error: 'Agent loop ended with error',
        reason: 'error',
      }).catch((err) => logger.warn('[AgentManager] StopFailure hook failed', {error: err}))
    }
  }

  /** 处理 error 事件 */
  private async handleErrorEvent(conversationId: string, errorMsg: string): Promise<void> {
    try {
      await doMergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
    } catch (err) {
      logger.error('[AgentManager] 持久化异常', {error: err})
    }

    this.forwardToRenderer(conversationId, {type: 'error', error: errorMsg})

    HookExecutor.getInstance().execute('StopFailure', {
      sessionId: conversationId,
      error: errorMsg,
      reason: 'error',
    }).catch((err) => logger.warn('[AgentManager] StopFailure hook failed', {error: err}))
  }

  /** 处理 Agent 结束后残留的注入消息 */
  private async handlePendingMessagesAfterExit(conversationId: string, messages: Array<{ content: string; id: string }>): Promise<void> {
    if (!messages.length) return

    try {
      // 1. 持久化当前 pending assistant 消息（如果有）
      await doMergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
      this.pendingAssistantMsg.set(conversationId, null)

      // 2. 将残留消息写入会话历史
      const {createConversationRepository} = await import('../repositories')
      const repo = createConversationRepository()
      const now = Date.now()
      const messageRecords = messages.map((msg, idx) => ({
        id: msg.id,
        role: 'user' as const,
        content: msg.content || '',
        timestamp: now + idx,  // 同一批次内按 idx 微调排序
      }))
      const written = repo.writeMessages(conversationId, messageRecords)
      if (!written) {
        logger.warn('[AgentManager] handlePendingMessagesAfterExit: writeMessages 返回 false', {conversationId})
      }

      // 3. 通知渲染层，触发新 Agent 处理这些消息
      this.forwardToRenderer(conversationId, {
        type: 'user_message_injected_after_exit',
        messages,
      })

      logger.info(`[AgentManager] 已处理 ${messages.length} 条残留的注入消息到会话 ${conversationId}`)
    } catch (err) {
      logger.error('[AgentManager] handlePendingMessagesAfterExit 失败', {error: err})
    }
  }

  /** Worker 错误处理 */
  private onWorkerError(conversationId: string, err: Error): void {
    this.forwardToRenderer(conversationId, {type: 'error', error: err.message})
    // 通知外部流监听器，让使用方的 Promise 能 resolve/reject
    this.notifyStreamListeners(conversationId, {type: 'done', reason: 'error'} as unknown as AgentStreamEvent)
    this.cleanup(conversationId)
  }

  /** Worker 退出处理 */
  private onWorkerExit(conversationId: string, worker: Worker, _code: number): void {
    const currentEntry = this.workers.get(conversationId)
    if (currentEntry && currentEntry.worker !== worker) {
      return
    }

    this.notifyStreamListeners(conversationId, {type: 'done', reason: 'aborted'} as unknown as AgentStreamEvent)
    this.streamListeners.delete(conversationId)
    this.cleanup(conversationId)
  }

  // ─── 流事件累积 ─────────────────────────────────────

  /** 累积流事件 */
  private accumulateEvent(conversationId: string, event: AgentStreamEvent): PendingAssistantMsg | null {
    let pending = this.pendingAssistantMsg.get(conversationId) ?? null
    const hasTurnReset = this.pendingNeedsTurnReset.has(conversationId)

    switch (event.type) {
      case 'agent_start': {
        // 新 LLM 调用轮次开始，清理上一轮的 turn reset 标志
        // 避免残留标志导致 text 事件丢弃已累积的 think/tool_call 信息
        this.pendingNeedsTurnReset.delete(conversationId)
        break
      }
      case 'text': {
        const content = (event as {type: 'text'; content?: string}).content || ''
        if (hasTurnReset) {
          pending = null
        }
        if (!content && !pending) break
        if (!pending) pending = createPendingMsg()
        pending.content += content
        if (pending.content.length > 100 * 1024) {
          pending.content = pending.content.slice(0, 100 * 1024)
        }
        break
      }
      case 'thinking': {
        const thinkChunk = (event as {type: 'thinking'; content?: string}).content || ''
        if (!pending) pending = createPendingMsg()
        pending.thinkContent = (pending.thinkContent || '') + thinkChunk
        break
      }
      case 'tool_use':
      case 'tool_start': {
        const tc = (event as {toolCall?: unknown}).toolCall as {
          id: string; name: string; arguments: Record<string, unknown>; reason?: string; terminal?: {name: string; platform: string}
        } | undefined
        if (!tc) break
        if (!pending) pending = createPendingMsg()
        if (!pending.toolCalls.find(t => t.id === tc.id)) {
          pending.toolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: 'running',
            textOffset: pending.content.length,
            reason: tc.reason,
            terminal: tc.terminal,
          })
        }
        break
      }
      case 'tool_result': {
        const toolResult = event as {toolCallId?: string; result?: unknown}
        if (!pending || !toolResult.toolCallId) break
        const idx = pending.toolCalls.findIndex(t => t.id === toolResult.toolCallId)
        if (idx === -1) break
        const normalized = normalizeToolResult(toolResult.result)
        pending.toolCalls[idx] = {
          ...pending.toolCalls[idx],
          status: normalized.output && !normalized.error ? 'success' : 'error',
          result: normalized,
        }
        this.pendingNeedsTurnReset.add(conversationId)
        break
      }
      case 'tool_denied': {
        const denied = event as {toolCallId?: string; reason?: string}
        if (!pending || !denied.toolCallId) break
        const idx = pending.toolCalls.findIndex(t => t.id === denied.toolCallId)
        if (idx === -1) break
        pending.toolCalls[idx] = {
          ...pending.toolCalls[idx],
          status: 'error',
          result: {output: '', error: denied.reason || '权限被拒绝'},
        }
        break
      }
      default:
    }

    return pending
  }

  // ─── 公开 API ────────────────────────────────────────

  /** 中止指定会话的 Agent */
  async abort(conversationId: string, sendFallbackDone: boolean = true): Promise<void> {
    const entry = this.workers.get(conversationId)
    if (!entry) return

    entry.abortController.abort()
    entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.ABORT})

    if (sendFallbackDone) {
      this.notifyStreamListeners(conversationId, {type: 'done', reason: 'aborted'} as unknown as AgentStreamEvent)
    }

    setTimeout(() => {
      const currentEntry = this.workers.get(conversationId)
      if (currentEntry && currentEntry.worker === entry.worker) {
        entry.worker.terminate()
        this.cleanup(conversationId)
      }
    }, WORKER_GRACEFUL_SHUTDOWN_MS)
  }

  /** 中止所有 Agent */
  async abortAll(): Promise<void> {
    const ids = Array.from(this.workers.keys())
    await Promise.all(ids.map((id) => this.abort(id)))
  }

  /** 检查指定会话是否有 Agent 运行中 */
  isRunning(conversationId: string): boolean {
    return this.workers.has(conversationId)
  }

  /** 响应用户确认结果 */
  respondConfirmation(conversationId: string, requestId: string, result: 'allow' | 'always' | 'deny'): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.USER_CONFIRMATION_RESULT, requestId, result})
    }
  }

  /** 响应用户提问的回答 */
  respondAskUser(conversationId: string, requestId: string, answer: string): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.USER_ANSWER_RESULT, requestId, answer})
    }
  }

  /** 更新运行中 Agent 的配置 */
  updateConfig(conversationId: string, modelConfig: ModelConfig): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_CONFIG, modelConfig})
    }
  }

  /** 广播全局设置到运行中的 Agent */
  broadcastSettings(conversationId: string, settings: SystemSettings): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_SETTINGS, settings})
    }
  }

  /** 广播模型方案更新到所有运行中的 Agent */
  broadcastSchemeUpdate(schemeConfig: {
    scheme: import('@shared/types').ModelScheme
    providers: Array<{
      id: string; name: string; type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
      apiKey?: string; baseUrl?: string; enabled: boolean
      models: Array<{id: string; name: string; enabled: boolean}>
    }>
  }): void {
    for (const id of this.getRunningConversations()) {
      const entry = this.workers.get(id)
      if (entry) {
        entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_SCHEME, schemeConfig})
      }
    }
  }

  /** 广播权限模式更新到所有运行中的 Agent */
  broadcastPermissionModeUpdate(permissionMode: import('@shared/types').RunMode): void {
    for (const id of this.getRunningConversations()) {
      const entry = this.workers.get(id)
      if (entry) {
        entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_PERMISSION_MODE, permissionMode})
      }
    }
  }

  /** 广播工作模式更新到所有运行中的 Agent */
  broadcastWorkModeUpdate(workMode: string): void {
    for (const id of this.getRunningConversations()) {
      const entry = this.workers.get(id)
      if (entry) {
        entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_WORK_MODE, workMode})
      }
    }
  }

  /** 广播 MCP 工具刷新到所有运行中的 Agent */
  broadcastMcpToolsRefresh(): void {
    for (const id of this.getRunningConversations()) {
      const entry = this.workers.get(id)
      if (entry) {
        entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.REFRESH_MCP_TOOLS})
      }
    }
  }

  /** 向运行中的 Agent 注入用户消息 */
  injectMessage(conversationId: string, content: string, messageId?: string): boolean {
    const entry = this.workers.get(conversationId)
    if (!entry) {
      logger.warn('[AgentManager] injectMessage: 会话未在运行中', {conversationId})
      return false
    }
    entry.worker.postMessage({
      type: WORKER_MESSAGE_TYPES.INJECT_USER_MESSAGE,
      message: {
        content,
        id: messageId || `inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    })
    logger.info('[AgentManager] 已向 Worker 转发注入消息', {conversationId, contentPreview: (content || '').slice(0, 80)})
    return true
  }

  /** 获取所有运行中的会话 ID */
  getRunningConversations(): string[] {
    return Array.from(this.workers.keys())
  }

  // ─── Agent 模板加载 ──────────────────────────────────

  /** 从插件加载 Agent 模板 */
  loadPluginAgents(): AgentTemplate[] {
    return loadPluginAgents()
  }

  // ─── 内部工具方法 ───────────────────────────────────

  /** 记录 LLM 调用日志 */
  private logLlmCall(event: Extract<AgentStreamEvent, {type: 'llm_call_done'}>): void {
    addLlmCallLog({
      conversationTitle: event.conversationTitle,
      provider: event.provider,
      model: event.model,
      duration: event.duration,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      reasoningTokens: event.reasoningTokens,
      inputContent: event.inputContent,
      outputContent: event.outputContent,
      toolCalls: event.toolCalls as LlmCallLog['toolCalls'],
      messages: event.messages as LlmCallLog['messages'],
      systemPrompt: event.systemPrompt,
    })
  }

  /** 提取本次 loop 的最后一条用户/助手消息（供 Stop hook 使用） */
  private extractLastLoopMessages(conversationId: string): Array<{role: string; content: string}> {
    const result: Array<{role: string; content: string}> = []

    try {
      const {createConversationRepository} = require('../repositories') as typeof import('../repositories')
      const repo = createConversationRepository()
      const {messages: convMsgs} = repo.readMessagesTail(conversationId, 10)
      const lastUserMsg = [...convMsgs].reverse().find(m => m.role === 'user')

      if (lastUserMsg) {
        result.push({role: 'user', content: typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''})
      }

      // 从 pendingAssistantMsg 读取当前循环的 assistant 响应
      const pending = this.pendingAssistantMsg.get(conversationId)
      if (pending && pending.content) {
        result.push({role: 'assistant', content: pending.content})
      }
    } catch (err) {
      logger.warn('[AgentManager] extractLastLoopMessages failed', {error: err})
    }

    return result
  }

  /** 向主窗口发送消息（自动检查窗口有效性） */
  private sendToMainWindow(channel: string, ...args: any[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }

  /** 转发事件到渲染进程 */
  private forwardToRenderer(conversationId: string, event: AgentStreamEvent): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      if (!SKIP_LOG_EVENT_TYPES.has(event.type)) {
        logger.info('forwardToRenderer', {skipType: event.type})
      }
      return
    }

    try {
      this.mainWindow.webContents.send('agent-stream', {conversationId, event})
    } catch (err: unknown) {
      logger.error('forwardToRenderer', {error: err instanceof Error ? err.message : String(err)})
    }
  }

  /** 清理会话资源 */
  private cleanup(conversationId: string): void {
    this.workers.delete(conversationId)
    this.pendingAssistantMsg.delete(conversationId)
    this.pendingNeedsTurnReset.delete(conversationId)
    this.streamListeners.delete(conversationId)
  }
}

// 导出 singleton
export const agentManager = new AgentManager()