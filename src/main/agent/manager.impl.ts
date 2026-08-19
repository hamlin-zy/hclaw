/**
 * AgentManager 实现
 */

import {Worker} from 'worker_threads'
import {BrowserWindow} from 'electron'
import * as path from 'path'
import {WORKER_MESSAGE_TYPES} from './constants'
import type {AgentStreamEvent} from './stream'
import type {AgentTemplate, LlmCallLog, Message, SystemSettings} from '@shared/types'
import {DEFAULT_MAX_TOKENS} from '@shared/types'
import type {ChatMessage, ModelConfig} from './model/types'
import {permissionEngine} from './tools/permission'
import {addLlmCallLog} from '../utils/llmCallLogStore'
import {gracefulRestart} from '../utils/restart'
import {HookExecutor, type HookResult} from '../plugin/hooks'
import {capabilityManager} from './capabilityManager'
import {logger} from './logger'
import {mcpWorkerManager, setAgentManagerRef} from './mcp/mcpWorkerManager'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {runtimeConfigManager} from './runtimeConfigManager'
import {eventBus, MCPThemeEvents} from '../common/eventBus'
import {notifyUserAttention, stopUserAttention} from '../attention'

// 导入拆分模块
import type {
  AgentStartParams,
  AgentStreamGenerator,
  PendingAssistantMsg,
  WorkerEntry,
} from './manager.types'
import {
  WORKER_GRACEFUL_SHUTDOWN_MS,
  SKIP_LOG_EVENT_TYPES,
  PENDING_MSG_MAX_BYTES,
} from './manager.constants'
import {createPendingMsg, normalizeToolResult, finalizePending, appendCappedPart} from './manager.accumulator'
import {createForwardPayload, extractWorkerErrorMessage} from './manager.streamForward'
import {recordLlmUsageEvent} from '../usageWrite'

import {loadPluginAgents} from './manager.pluginAgents'
import {createConversationRepository} from '../repositories'

// ─── AgentManager ──────────────────────────────────────

export class AgentManager {
  /** conversationId → WorkerEntry */
  private workers: Map<string, WorkerEntry> = new Map()
  private mainWindow: BrowserWindow | null = null

  /** 父会话 → 子会话 ID 集合，父会话终止时级联清理子会话运行状态 */
  private parentToChildren: Map<string, Set<string>> = new Map()

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
      hookExecutor.onResult((event: string, hookName: string, result: HookResult) => {
        this.forwardToRenderer('__hooks__', {
          type: 'hook_result',
          event,
          hookName,
          success: (result.allowed ?? result.decision !== 'block') && !result.error,
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
      agent: {maxTurns: 500, retryCount: 10, initialRetryDelay: 5000, maxRetryDelay: 120000, llmTimeout: 600000, handoffThresholdRatio: 0.5, midLoopOverflowMode: 'auto-handoff'},
      model: {defaultMaxTokens: DEFAULT_MAX_TOKENS, defaultTemperature: 0},
      mcp: {mcpTestTimeout: 15000},
      ui: {theme: 'system'},
      subagent: {maxConcurrency: 3, defaultTimeout: 15 * 60 * 1000, retryAttempts: 0, priorityEnabled: false, maxDepth: 3},
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

    const workerParams = {
      ...params,
      modelOverride: runtimeConfigManager.getOverride(params.conversationId),
      settings: initialSettings,
      capabilities,
    }

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

    // 触发 SessionStart Hook
    HookExecutor.getInstance().execute('SessionStart', {
      sessionId: params.conversationId,
    }).catch(() => {})
  }

  /**
   * 以 AsyncGenerator 形式启动 Agent
   *
   * 将现有的回调式流监听器模式桥接为 AsyncGenerator，
   * 使调用方可通过 for await...of 消费流事件。
   *
   * 关键约束：在调用 this.start() 之前注册流监听器，避免事件丢失。
   */
  async *startAsGenerator(params: AgentStartParams): AgentStreamGenerator {
    const convId = params.conversationId
    let resolveNext: ((value: IteratorResult<AgentStreamEvent>) => void) | null = null
    let finished = false
    let startupTimer: NodeJS.Timeout | null = null
    const eventQueue: AgentStreamEvent[] = []

    const listener = (event: AgentStreamEvent) => {
      if (finished) return
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      if (resolveNext) {
        resolveNext({value: event, done: false})
        resolveNext = null
      } else {
        eventQueue.push(event)
      }
    }

    // 在 start() 之前注册，避免竞态
    const removeListener = this.addStreamListener(convId, listener)

    try {
      await this.start(params)

      // 防止 worker 启动后静默崩溃导致 resolveNext 永久阻塞
      startupTimer = setTimeout(() => {
        if (resolveNext) {
          resolveNext({value: {type: 'error', error: '子 Agent 启动超时'}, done: false})
          resolveNext = null
        }
      }, 30_000)

      while (true) {
        let event: AgentStreamEvent
        if (eventQueue.length > 0) {
          event = eventQueue.shift()!
        } else {
          const result = await new Promise<IteratorResult<AgentStreamEvent>>(resolve => {
            resolveNext = resolve
          })
          if (result.done) break
          event = result.value
        }

        yield event

        if (event.type === 'done' || event.type === 'error') {
          finished = true
          break
        }
      }
    } finally {
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      removeListener()
      if (!finished) {
        // 安全清理：若 Agent 仍在运行则中止
        try { await this.abort(convId, false) } catch { /* ignore */ }
      }
    }
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
          notifyUserAttention()
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
          notifyUserAttention()
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

        // Worker 线程的 hook 执行结果：转发到渲染进程
        if (msg.type === 'hook_result') {
          const hr = msg as unknown as { hookEvent: string; hookName: string; success: boolean; error?: string }
          this.forwardToRenderer('__hooks__', {
            type: 'hook_result',
            event: hr.hookEvent,
            hookName: hr.hookName,
            success: hr.success,
            error: hr.error,
          })
          return
        }

        // 流事件处理
        // ★ 使用 msg.conversationId（若存在）而非闭包固定的 Worker 主会话 ID：
        //   taskStore 发出的 tasks_update 事件携带任务归属会话 ID（子会话任务 → 子会话 ID，
        //   主会话任务 → 主会话 ID）。若固定用主会话 ID，子会话的待办更新会被错误路由到主会话。
        if (msg.type === 'stream' && msg.event) {
          await this.handleStreamEvent(msg.conversationId || conversationId, worker, msg.event)
        } else if (msg.type === 'child_conv_created') {
          // 子 Agent 独立会话创建事件 → 直接通知渲染进程刷新侧栏
          // （不走 agent-stream，因为流事件处理器不认识这个类型）
          const childMsg = msg as unknown as { childConvId: string; title?: string; parentConvId?: string }
          this.sendToMainWindow('child_conv_created', {
            id: childMsg.childConvId,
            title: childMsg.title || '子 Agent',
            parentConvId: childMsg.parentConvId || undefined,
          })
          // 注册父→子关系，父会话终止时级联清理子会话运行状态
          if (childMsg.parentConvId) {
            let children = this.parentToChildren.get(childMsg.parentConvId)
            if (!children) {
              children = new Set()
              this.parentToChildren.set(childMsg.parentConvId, children)
            }
            children.add(childMsg.childConvId)
          }
        } else if (msg.type === 'session_created') {
          // 独立会话创建事件 → 通知渲染进程刷新侧栏 + 自动切换
          const sessionMsg = msg as unknown as { convId: string; title?: string; workspacePath?: string }
          this.sendToMainWindow('session_created', {
            id: sessionMsg.convId,
            title: sessionMsg.title || '新会话',
            workspacePath: sessionMsg.workspacePath || '',
          })
        } else if (msg.type === 'session_handoff_start') {
          await this.startHandoffSession(msg as unknown as {
            convId: string
            title?: string
            messages: ChatMessage[]
            workingDir: string
          })
        } else if (msg.type === 'child_agent_event') {
          // ★ 子会话 agent 生命周期事件（begin / done）→ 转发到渲染进程
          //   使得侧边栏能展示子会话的运行状态动画（与父会话一致）
          const childEvent = msg as unknown as { conversationId: string; event: AgentStreamEvent }
          this.forwardToRenderer(childEvent.conversationId, childEvent.event)
        } else if (msg.type === 'error') {
          // ★ worker.ts 发送的错误结构为 { type:'error', conversationId, event:{type:'error', error: err.message} }
          //   错误信息在 msg.event.error；顶层 msg.error 是旧格式兜底。
          //   此前只读 msg.error → undefined → 回退 'Worker error'，真实错误被吞掉。
          const workerErr = extractWorkerErrorMessage(msg as { event?: { error?: string }; error?: string })
          this.forwardToRenderer(msg.conversationId, {
            type: 'error',
            error: workerErr,
          })
          HookExecutor.getInstance().execute('StopFailure', {
            sessionId: msg.conversationId,
            error: workerErr,
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
        await this.#mergeAndPersist(conversationId, oldPending, true)
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
      ;(event as {messageId?: string}).messageId = pending.id
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
      this.logLlmCall(event)
      recordLlmUsageEvent(conversationId, event)
    } else if (event.type === 'subagent_progress') {
      // 该分支仅 JSONL 日志（logLlmCall），不写 llm_usage：内联子 Agent 的用量由路径 2 在 worker 内记录
      const subEvent = event.subAgentStreamEvent
      if (subEvent?.type === 'llm_call_done') this.logLlmCall(subEvent)
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

  /**
   * 合并 pending assistant 消息并写入 SQLite（核心方法）
   *
   * 使用 UPSERT 只写入/更新该条 assistant 消息及其 blocks，
   * 不再做 DELETE ALL + REINSERT ALL，避免并发写入导致消息丢失。
   *
   * @param isFinal - 是否为最终写入（done/error），会影响 thinkBlock 状态和 endedAt
   */
  async #mergeAndPersist(
    conversationId: string,
    pending: PendingAssistantMsg | null | undefined,
    isFinal: boolean,
  ): Promise<void> {
    if (!pending) {
      return
    }
    // ★ 方案 C：读取 content/thinkContent 前 finalize（惰性 join）
    pending = finalizePending(pending)
    if (!pending.content && pending.toolCalls.length === 0 && !pending.thinkContent) {
      return
    }

    const {getDatabase, saveDatabase} = await import('../repositories/sqlite')
    const db = getDatabase()
    const now = Date.now()

    // ★ 块级增量模型保险丝：渲染端已在段边界精细落库（有 blocks）。
    //   此时只补 endedAt/缺失字段（setMessageEnded 原语），绝不 DELETE+全量 INSERT 覆盖精细块。
    const {createConversationRepository} = await import('../repositories')
    const convRepo = createConversationRepository()
    const existingBlocks = db.prepare('SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ?').get(pending.id) as {c: number}
    if ((existingBlocks?.c ?? 0) > 0) {
      if (isFinal) {
        convRepo.setMessageEnded(conversationId, pending.id, now)
      }
      return
    }
    // ↓ 以下为现状全量写路径（仅"无 blocks"消息——如渲染进程崩溃从未落库）

    const {messageToBlocks} = await import('../repositories/sqlite/messageBlockHelper')

    // 读取写入前的消息数
    const beforeUserRows = db.prepare(
      'SELECT id, role FROM messages WHERE conversation_id = ? AND role = ? ORDER BY timestamp ASC'
    ).all(conversationId, 'user') as Array<{id: string; role: string}>

    const msg: Message = {
      id: pending.id,
      role: 'assistant',
      content: pending.content,
      timestamp: pending.timestamp,
      endedAt: isFinal ? now : undefined,
      toolCalls: pending.toolCalls.length > 0 ? pending.toolCalls : undefined,
      thinkBlock: pending.thinkContent
        ? {
            id: `think-${pending.id}`,
            content: pending.thinkContent,
            status: isFinal ? 'complete' : 'thinking',
            timestamp: now,
          }
        : undefined,
    }

    const {messages: [msgRecord], blocks} = messageToBlocks(msg, conversationId)

    // ★ 修复重复消息：读取已有 llm_stats，避免 INSERT OR REPLACE 将其覆盖为 null
    // （渲染进程可能已通过 writeMessages 或 updateMessageLlmStats IPC 提前写入）
    const existingRow = db.prepare(
      'SELECT llm_stats FROM messages WHERE id = ?'
    ).get(pending.id) as { llm_stats: string | null } | undefined
    const existingLlmStats = existingRow?.llm_stats

    // 使用事务包裹：先重查块数（TOCTOU 防护）→ 再删旧 blocks → UPSERT message → 写入新 blocks
    let raced = false
    db.transaction(() => {
      // ★ TOCTOU 防护（review 修复）：上面的 await import(...) 让出的时间片内，
      //   渲染端可能已把精细块落库——若此时仍走"无 blocks"分支的 DELETE + 全量 INSERT，
      //   会删掉渲染端刚写的块并用主进程截断版覆盖（违反不变式"已落库块永不重写"）。
      //   故在事务内重查块数：一旦出现块 → 放弃全量写，退化为只补 endedAt。
      const recheck = db.prepare('SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ?').get(pending.id) as {c: number}
      if ((recheck?.c ?? 0) > 0) {
        raced = true
        if (isFinal) {
          convRepo.setMessageEnded(conversationId, pending.id, now)
        }
        return
      }
      db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(pending.id)
      db.prepare(
        'INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        msgRecord.id,
        conversationId,
        msgRecord.role,
        msgRecord.timestamp,
        msgRecord.endedAt ?? null,
        JSON.stringify(msgRecord.metadata),
        existingLlmStats ?? null,
        isFinal ? 0 : 1,
      )

      const blockStmt = db.prepare(
        'INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const block of blocks) {
        blockStmt.run(
          block.id,
          block.messageId,
          block.blockType,
          block.content,
          block.data,
          block.sequence,
          block.timestamp,
          block.endedAt ?? null,
          block.turnIndex ?? null,
        )
      }
    })()
    if (raced) return
    saveDatabase()

    // 检查 user 消息是否丢失
    const afterUserRows = db.prepare(
      'SELECT id, role FROM messages WHERE conversation_id = ? AND role = ? ORDER BY timestamp ASC'
    ).all(conversationId, 'user') as Array<{id: string; role: string}>
    if (afterUserRows.length < beforeUserRows.length) {
      const missing = beforeUserRows.filter(b => !afterUserRows.find(a => a.id === b.id))
      logger.error('[AgentManager] user消息减少', {
        before: beforeUserRows.length,
        after: afterUserRows.length,
        missingIds: missing.map(r => r.id?.slice(0, 8)).join(','),
        conversationId,
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

  /** 处理 done 事件 */
  private async handleDoneEvent(
    conversationId: string,
    event: {type: 'done'; reason: 'completed' | 'aborted' | 'error'},
  ): Promise<void> {
    try {
      await this.#mergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
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
      await this.#mergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
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
      await this.#mergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
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
    // Always release attention ref for the exiting worker, even if it was
    // already replaced. stopUserAttention is idempotent at count=0, so this
    // is safe regardless of which worker is current. If we defer this after
    // the sentinel guard below, a worker-replace race (crash → cleanup →
    // new start → old exit) would leak the refcount permanently.
    stopUserAttention()

    const currentEntry = this.workers.get(conversationId)
    if (currentEntry && currentEntry.worker !== worker) {
      return
    }

    // ★ forwardToRenderer 确保渲染进程收到 done 事件，
    //   将 convAgentStates 状态从 'running' 切回 'idle'。
    //   正常路径下 handleDoneEvent 已转发过 done，此处为安全网：
    //   当 Worker 异常退出（agentLoop 返回 early_exit 而非 done event）
    //   或崩溃时，只有 onWorkerExit 能兜底通知渲染进程。
    this.forwardToRenderer(conversationId, {type: 'done', reason: 'aborted'} as AgentStreamEvent)
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
        // ★ 方案 C：段内数组 + contentLength（镜像 accumulator.ts，复用 appendCappedPart）
        pending.contentParts = pending.contentParts || []
        pending.contentLength = appendCappedPart(
          pending.contentParts, content, pending.contentLength, PENDING_MSG_MAX_BYTES,
        ).length
        break
      }
      case 'thinking': {
        const thinkChunk = (event as {type: 'thinking'; content?: string}).content || ''
        if (!pending) pending = createPendingMsg()
        pending.thinkParts = pending.thinkParts || []
        pending.thinkParts.push(thinkChunk)
        pending.thinkLength = (pending.thinkLength || 0) + thinkChunk.length
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
            textOffset: pending.contentLength,
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
        const tc = pending.toolCalls[idx]
        pending.toolCalls[idx] = {
          ...tc,
          status: normalized.success ? 'success' : 'error',
          result: normalized,
          // ★ 需求1链路：agent 工具从 result._meta 恢复子会话 ID（taskId === childConvId）
          //   与 manager.accumulator.ts accumulateStreamEvent 保持逻辑一致（双轨）
          ...(tc.name === 'agent' && normalized._meta?.childConvId
            ? {taskId: normalized._meta.childConvId as string}
            : {}),
        }
        this.pendingNeedsTurnReset.add(conversationId)
        break
      }
      case 'tool_denied': {
        const denied = event as {toolCallId?: string; reason?: string}
        if (!pending || !denied.toolCallId) break
        const idx = pending.toolCalls.findIndex(t => t.id === denied.toolCallId)
        if (idx === -1) break
        const deniedReason = `[PERMISSION_DENIED] ${denied.reason || '权限被拒绝'}`
        pending.toolCalls[idx] = {
          ...pending.toolCalls[idx],
          status: 'error',
          // 与 loop 内存态 createToolResultMessage 失败格式逐字节一致（含 [ERROR] 前缀）
          result: {
            output: '',
            error: deniedReason,
            toolResult: `[ERROR] ${deniedReason}`,
          },
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
      stopUserAttention()
    }
  }

  /** 响应用户提问的回答 */
  respondAskUser(conversationId: string, requestId: string, answer: string): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.USER_ANSWER_RESULT, requestId, answer})
      stopUserAttention()
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

  /** 广播会话级模型 override 更新到所有运行中的 Agent（主进程 → Worker） */
  broadcastModelOverride(convId: string, override: import('@shared/types').ModelOverride | null): void {
    for (const id of this.getRunningConversations()) {
      const entry = this.workers.get(id)
      if (entry) {
        entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_MODEL_OVERRIDE, convId, override})
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
      // inputContent/outputContent 在事件类型中已声明可选（渲染端转发载荷不含），
      // 日志消费的是 worker→主进程原始事件，worker 侧 controller.ts 总是填充；
      // 防御性默认值兜底（空串）。
      inputContent: event.inputContent ?? '',
      outputContent: event.outputContent ?? '',
      toolCalls: event.toolCalls as LlmCallLog['toolCalls'],
      messages: event.messages as LlmCallLog['messages'],
      systemPrompt: event.systemPrompt,
    })
  }

  /** 提取本次 loop 的最后一条用户/助手消息（供 Stop hook 使用） */
  private extractLastLoopMessages(conversationId: string): Array<{role: string; content: string}> {
    const result: Array<{role: string; content: string}> = []

    try {
      const repo = createConversationRepository()
      const {messages: convMsgs} = repo.readMessagesTail(conversationId, 10)
      const lastUserMsg = [...convMsgs].reverse().find(m => m.role === 'user')

      if (lastUserMsg) {
        result.push({role: 'user', content: typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''})
      }

      // 从 pendingAssistantMsg 读取当前循环的 assistant 响应
      const pending = this.pendingAssistantMsg.get(conversationId)
      if (pending) {
        // ★ 方案 C：读取 content 前 finalize（惰性 join）
        finalizePending(pending)
        if (pending.content) {
          result.push({role: 'assistant', content: pending.content})
        }
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
      // ★ llm_call_done 瘦身逻辑见 manager.streamForward.ts（渲染端只用 stats 字段，
      //   大字段不再经 IPC 全链传输；LLM 日志走独立通道不受影响）
      this.mainWindow.webContents.send('agent-stream', createForwardPayload(conversationId, event))
    } catch (err: unknown) {
      logger.error('forwardToRenderer', {error: err instanceof Error ? err.message : String(err)})
    }
  }

  /** 清理会话资源 */
  private cleanup(conversationId: string): void {
    // ★ 级联清理子会话：父会话终止时，确保所有子会话的 running 状态也被清除
    //    即使 Worker 侧的 catch 块已寄送 done 事件，Worker termination 可能导致消息丢失，
    //    此处从主进程侧兜底发送 done 事件到渲染进程
    // ★ 多级级联：递归遍历 parentToChildren 树（而非仅直接子级），
    //   主会话终止 → 一级子会话 → 二级子会话…逐层下发 done(aborted)，
    //   否则二级子会话的 running 状态永远无法清除。
    const collectDescendantConvs = (rootId: string, acc: string[] = []): string[] => {
      const children = this.parentToChildren.get(rootId)
      if (children) {
        for (const childConvId of children) {
          acc.push(childConvId)
          collectDescendantConvs(childConvId, acc)
        }
      }
      return acc
    }
    const allDescendants = collectDescendantConvs(conversationId)
    for (const childConvId of allDescendants) {
      // 逐级下发 done(aborted)，同时清理该子会话的关系映射（含各中间层条目）
      this.forwardToRenderer(childConvId, {type: 'done', reason: 'aborted'} as AgentStreamEvent)
      this.parentToChildren.delete(childConvId)
    }
    this.parentToChildren.delete(conversationId)

    // 触发 SessionEnd Hook
    HookExecutor.getInstance().execute('SessionEnd', {
      sessionId: conversationId,
      reason: 'cleanup',
    }).catch(() => {})

    this.workers.delete(conversationId)
    this.pendingAssistantMsg.delete(conversationId)
    this.pendingNeedsTurnReset.delete(conversationId)
    this.streamListeners.delete(conversationId)
  }

  /**
   * session_handoff 工具回调：为新会话启动独立 Agent Worker（交接首轮运行）。
   * 复用 start() 既有链路——用户在新会话发消息时 start() 会自动 abort 该 Worker 并重建。
   * ★ 模型配置从主进程 runtimeConfigManager 组装（含 API key）——工具侧传入的裸 modelConfig（apiKey 为空）无法创建 LLM adapter。
   */
  private async startHandoffSession(msg: {
    convId: string
    title?: string
    messages: ChatMessage[]
    workingDir: string
  }): Promise<void> {
    const handoffScheme = runtimeConfigManager.getScheme()
    const handoffProviders = runtimeConfigManager.getProviders()
    await this.start({
      conversationId: msg.convId,
      messages: msg.messages,
      modelConfig: {} as ModelConfig, // 由 loop 从 schemeConfig 解析
      maxTurns: systemSettingsRepo.getJson<SystemSettings>('settings')?.agent?.maxTurns ?? 500,
      workingDir: msg.workingDir,
      schemeConfig: handoffScheme ? {
        scheme: handoffScheme,
        providers: handoffProviders as any,
      } : undefined,
      modelOverride: runtimeConfigManager.getOverride(msg.convId),
      conversationTitle: msg.title,
    })
  }
}

// 导出 singleton
export const agentManager = new AgentManager()