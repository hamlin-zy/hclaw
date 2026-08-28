/**
 * AgentManager 实现
 */

import {Worker} from 'worker_threads'
import {BrowserWindow} from 'electron'
import * as path from 'path'
import {WORKER_MESSAGE_TYPES} from './constants'
import type {AgentStreamEvent} from './stream'
import type {AgentTemplate, Message, SystemSettings} from '@shared/types'
import {DEFAULT_MAX_TOKENS} from '@shared/types'
import type {ChatMessage, ModelConfig} from './model/types'
import {permissionEngine} from './tools/permission'
import {isRecordingEnabled, getLlmTraceRootDir} from '../utils/llmTraceRecorder'
import type {LlmCallRecord} from '@shared/types/llmTrace'
import {gracefulRestart} from '../utils/restart'
import {capabilityManager} from './capabilityManager'
import {logger} from './logger'
import {mcpWorkerManager, setAgentManagerRef} from './mcp/mcpWorkerManager'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {upsertSnapshot, getActiveBatch} from '../repositories/sqlite/taskBatchRepository'
import {runtimeConfigManager} from './runtimeConfigManager'
import {eventBus, CapabilityEvents, MCPThemeEvents} from '../common/eventBus'
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
import {createPendingMsg, normalizeToolResult, finalizePending, appendCappedPart, isRenderedCopyFingerprintMatch, buildStreamSnapshot} from './manager.accumulator'

// ─── 快照 v2 辅助（与 manager.accumulator.ts 双轨一致）──────────
const PROGRESS_LOG_MAX_IMPL = 200
const SUB_AGENT_STREAM_MAX_IMPL = 500

type SubAgentEntry = NonNullable<PendingAssistantMsg['subAgentStream']>[string][number]

function appendProgressEntryImpl(pending: PendingAssistantMsg, toolCallId: string, text: string): void {
  const log = (pending.progressLog ??= {})
  const arr = (log[toolCallId] ??= [])
  arr.push({time: Date.now(), text})
  if (arr.length > PROGRESS_LOG_MAX_IMPL) arr.splice(0, arr.length - PROGRESS_LOG_MAX_IMPL)
}

function capSubAgentBucketImpl(bucket: SubAgentEntry[]): void {
  if (bucket.length > SUB_AGENT_STREAM_MAX_IMPL) bucket.splice(0, bucket.length - SUB_AGENT_STREAM_MAX_IMPL)
}
import {createForwardPayload, extractWorkerErrorMessage} from './manager.streamForward'
import {recordLlmUsageEvent} from '../usageWrite'

import {loadPluginAgents} from './manager.pluginAgents'

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

  /** 会话 → 渲染端占位消息 id（ensureStreamingMessage 上报）。
   *  主进程 pending 累积复用该 id，避免与渲染端流式消息双 id 双写（幽灵消息根因）。 */
  private streamingMsgIds: Map<string, string> = new Map()

  constructor() {
    eventBus.on(MCPThemeEvents.TOOLS_REFRESHED, () => {
      this.broadcastMcpToolsRefresh()
    })
    // 能力刷新（技能/插件启停等）→ 广播最新序列化能力，运行中 Worker 重建本地 registry
    eventBus.on(CapabilityEvents.REFRESHED, () => {
      void this.broadcastCapabilitiesRefresh()
    })
  }

  /**
   * 序列化当前能力并广播到所有活跃 Worker（CAPABILITIES_REFRESH）。
   * 序列化失败仅告警，不影响主流程（Worker 保持旧快照）。
   */
  private async broadcastCapabilitiesRefresh(): Promise<void> {
    try {
      const capabilities = await capabilityManager.serializeForWorker()
      this.broadcastToWorkers({type: WORKER_MESSAGE_TYPES.CAPABILITIES_REFRESH, capabilities})
    } catch (err) {
      logger.warn('[AgentManager] broadcastCapabilitiesRefreshFailed', {error: err})
    }
  }

  /** 设置主窗口引用 */
  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
    // 延迟设置避免循环依赖
    setAgentManagerRef({
      workers: this.workers as Map<string, { worker: Worker }>,
    } as Parameters<typeof setAgentManagerRef>[0])
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

  /**
   * 渲染端占位消息 id 注册（ensureStreamingMessage 创建空占位后调用）。
   *
   * 目的：主进程 pending（createPendingMsg 随机 id）与渲染端占位（randomUUID）
   * 双轨独立生成 id，done 时 #mergeAndPersist 全量写兜底会以 pending.id 插入
   * 幽灵副本 → 重启加载后每条助手消息渲染 2 份。注册后 pending 一律复用
   * 渲染端 id，兜底路径自然短路（该 id 已有 blocks）。
   */
  registerStreamingMessage(conversationId: string, msgId: string): void {
    this.streamingMsgIds.set(conversationId, msgId)
    // 竞态兜底：text 先于注册到达（pending 已创建）→ 立即对齐
    const pending = this.pendingAssistantMsg.get(conversationId)
    if (pending) pending.id = msgId
  }

  // ─── Worker 生命周期管理 ───────────────────────────────

  /**
   * 广播消息到所有活跃 Agent Worker（llm-trace 录制开关等跨线程同步）。
   * 已退出/销毁的 Worker 忽略 postMessage 异常。
   */
  broadcastToWorkers(msg: unknown): void {
    for (const entry of this.workers.values()) {
      try {
        entry.worker.postMessage(msg)
      } catch { /* Worker 已退出时忽略 */ }
    }
  }

  /** 启动 Agent Worker Thread */
  async start(params: AgentStartParams): Promise<void> {
    if (this.workers.has(params.conversationId)) {
      await this.abort(params.conversationId, false)
    }

    const abortController = new AbortController()
    const workerPath = path.join(__dirname, 'worker.js')

    // 加载配置
    const defaultSettings: SystemSettings = {
      agent: {maxTurns: 500, retryCount: 10, initialRetryDelay: 5000, maxRetryDelay: 120000, llmTimeout: 600000, handoffThresholdRatio: 0.5, midLoopOverflowMode: 'auto-handoff', loopDetection: { mode: 'notify', threshold: 3 }},
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

    // ★ 跨轮任务恢复：Worker 进程内存态（taskStore）每次运行全新重建，若无恢复，
    //   新一轮对话中 task_update 找不到上一轮创建的任务（updated=0 静默失败 → UI 不更新）。
    //   从 DB 读取该会话活跃批次快照下发，Worker 启动时 seed 回 taskStore。
    //   恢复失败不阻断启动（退化为"仅同轮任务可见"的旧行为）。
    const taskBatchSnapshot = this.buildTaskBatchSnapshot(params.conversationId)

    const workerParams = {
      ...params,
      modelOverride: runtimeConfigManager.getOverride(params.conversationId),
      permissionMode: runtimeConfigManager.getConvPermissionMode(params.conversationId),
      settings: initialSettings,
      capabilities,
      // llm-trace 录制初态（Worker 侧模块单例无法读到主线程内存开关，spawn 时随 workerData 下发；
      // 运行中变更靠 broadcastToWorkers 广播）
      llmTraceEnabled: isRecordingEnabled(),
      // llm-trace 根目录：Worker 内 electron 不可用，若自行解析会回退 ~/.hclaw 导致与
      // 主线程读盘（userData）分叉——窗口读不到录制的数据。主进程解析后下发，保证写读同源。
      llmTraceRootDir: getLlmTraceRootDir(),
      ...(taskBatchSnapshot ? {taskBatchSnapshot} : {}),
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

        // llm-trace 实时记录/暂停：Worker 无法直推日志窗口，经此转发主进程。
        // 动态 import 打破与 llmCallLogStore（其顶部 import agentManager）的循环依赖。
        if (msg.type === 'llm-trace-record' || msg.type === 'llm-trace-paused') {
            const {pushToLogsWindow} = await import('../utils/llmCallLogStore')
            pushToLogsWindow(
                msg.type === 'llm-trace-record'
                    ? (msg as unknown as {record: LlmCallRecord}).record
                    : {type: 'paused', reason: (msg as unknown as {reason?: string}).reason || '未知原因'},
            )
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
          // ★ handoffFromConvId 必须透传：MessageList「←前会话」导航数据源，
          //   丢失会导致交接后新会话不显示来源按钮（重启从 DB 加载才恢复）
          const sessionMsg = msg as unknown as { convId: string; title?: string; workspacePath?: string; handoffFromConvId?: string }
          this.sendToMainWindow('session_created', {
            id: sessionMsg.convId,
            title: sessionMsg.title || '新会话',
            workspacePath: sessionMsg.workspacePath || '',
            handoffFromConvId: sessionMsg.handoffFromConvId || undefined,
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
        }
      } catch (err: unknown) {
        logger.error('[AgentManager] messageHandlerFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** 读取会话活跃批次快照（跨轮任务恢复用；无活跃批次返回 null） */
  private buildTaskBatchSnapshot(conversationId: string): AgentStartParams['taskBatchSnapshot'] {
    try {
      const active = getActiveBatch(conversationId)
      if (!active) return null
      return {
        batch: {
          id: active.batch.id,
          name: active.batch.name,
          status: active.batch.status === 'completed' ? 'completed' : 'active',
        },
        tasks: active.tasks as import('@shared/types').Task[],
      }
    } catch (err) {
      logger.warn('[AgentManager] task batch snapshot load failed', {error: err})
      return null
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
      // ★ 必须同步清除 streamingMsgIds，否则 accumulateEvent 中
      //   registeredMsgId 仍指向旧消息 id，导致新 pending 复用旧 id，
      //   下一个 text 事件携带旧 id 到渲染端 → handleText 用该 id
      //   再建一条 assistant 消息 → 与已存在的旧消息 id 冲突
      //   → React "two children with the same key" + 旧气泡数据刷新 +
      //   新 user 下方出现空气泡 + 多份旧助手气泡。
      this.streamingMsgIds.delete(conversationId)
      // 将旧 messageId 附带在事件上，让渲染进程知道哪个消息已完成
      if (oldPending?.id) {
        ;(event as Record<string, unknown>).messageId = oldPending.id
      }
      this.forwardToRenderer(conversationId, event)
      return
    }

    // ── 任务批次持久化旁路：所有 tasks_update（含 supersede 收尾事件）统一落库 ──
    // 持久化失败不阻断事件流转，仅记录告警
    if (event.type === 'tasks_update' && event.batchId) {
      // 显式守卫：批次名称/状态任一缺失时跳过落库并告警。
      // 不做守卫的话，undefined 绑定异常会被下方 catch 吞掉，问题难以排查。
      if (event.batchName == null || event.batchStatus == null) {
        logger.warn('[AgentManager] task batch persist skipped: missing batchName/batchStatus', {
          conversationId,
          batchId: event.batchId,
        })
      } else {
        try {
          upsertSnapshot(
            conversationId,
            {id: event.batchId, name: event.batchName, status: event.batchStatus},
            event.tasks,
          )
        } catch (err) {
          logger.warn('[AgentManager] task batch persist failed', {error: err})
        }
      }
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

    // llm_call_done 事件（usageWrite → llm_usage 统计轨）
    if (event.type === 'llm_call_done') {
      recordLlmUsageEvent(conversationId, event)
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
    //   此时只补内容缺口 + endedAt（repairTextTail / setMessageEnded 原语），
    //   绝不 DELETE+全量 INSERT 覆盖精细块。
    //   ★ repairTextTail（崩溃落库修复）：渲染进程崩溃时未 flush 的 text 增量
    //   随 dirty map 丢失，DB 只剩前缀；此处以主进程跨段累积的全文为基准补齐尾部。
    const {createConversationRepository} = await import('../repositories')
    const convRepo = createConversationRepository()
    const existingBlocks = db.prepare('SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ?').get(pending.id) as {c: number}
    if ((existingBlocks?.c ?? 0) > 0) {
      if (isFinal) {
        convRepo.repairTextTail(pending.id, pending.content)
        convRepo.setMessageEnded(conversationId, pending.id, now)
      }
      return
    }

    // ★ 幽灵消息双写防御（根因修复，见 tasks/03-duplicate-assistant-bubbles.md）：
    //   内容指纹一致 → 渲染端已落库（注册机制生效前/竞态下 id 不一致的场景），
    //   只补缺口 + endedAt，绝不 INSERT 幽灵副本；无匹配才是真·渲染进程崩溃（从未落库）。
    const renderedCopyId = await this.#findRenderedCopy(conversationId, pending)
    if (renderedCopyId) {
      if (isFinal) {
        convRepo.repairTextTail(renderedCopyId, pending.content)
        convRepo.setMessageEnded(conversationId, renderedCopyId, now)
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

  /**
   * 幽灵消息双写防御：查找 pending 创建时间附近"内容指纹一致"的 assistant 消息。
   *
   * pending.id 无 blocks ≠ 渲染端未落库——渲染端占位消息（ensureStreamingMessage
   * 随机 id）与主进程 pending（createPendingMsg 随机 id）在注册机制生效前/竞态下
   * 可能不一致，渲染端以占位 id 精细落库（含 turn_index）。此时若本会话 pending
   * 创建时间附近存在内容指纹一致的 assistant 消息 → 判定渲染端已落库，调用方只补
   * endedAt、绝不 INSERT 幽灵副本；不匹配 / 不存在 → null，走全量写兜底
   * （渲染进程崩溃从未落库的场景）。
   */
  async #findRenderedCopy(
    conversationId: string,
    pending: PendingAssistantMsg,
  ): Promise<string | null> {
    const {getDatabase} = await import('../repositories/sqlite')
    const db = getDatabase()
    // ★ 时间窗收紧（-15s ~ +5s）：pending.timestamp 即响应起点，渲染端占位行几乎同时创建；
    //   相邻两条 assistant 消息通常间隔远大于此。配合前缀包含指纹，降低跨消息误判风险。
    const nearbyRow = db.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND role = 'assistant'
         AND timestamp BETWEEN ? - 15000 AND ? + 5000
       ORDER BY timestamp DESC LIMIT 1`
    ).get(conversationId, pending.timestamp, pending.timestamp) as {id: string} | undefined
    if (!nearbyRow) return null

    const nearbyText = (db.prepare(
      'SELECT content FROM message_blocks WHERE message_id = ? AND block_type = ? ORDER BY sequence'
    ).all(nearbyRow.id, 'text') as Array<{content: string | null}>)
      .map(b => b.content ?? '').join('').slice(0, 200)
    if (!isRenderedCopyFingerprintMatch(nearbyText, pending.content)) return null
    return nearbyRow.id
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
  }

  /** 处理 error 事件 */
  private async handleErrorEvent(conversationId: string, errorMsg: string): Promise<void> {
    try {
      await this.#mergeAndPersist(conversationId, this.pendingAssistantMsg.get(conversationId), true)
    } catch (err) {
      logger.error('[AgentManager] 持久化异常', {error: err})
    }

    this.forwardToRenderer(conversationId, {type: 'error', error: errorMsg})
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
    // 渲染端占位消息 id：新建/重建 pending 时复用（消除双 id 双写）
    const registeredMsgId = this.streamingMsgIds.get(conversationId)

    switch (event.type) {
      case 'text': {
        const content = (event as {type: 'text'; content?: string}).content || ''
        // ★ 崩溃落库修复：turn reset 不再丢弃已累积正文（与 manager.accumulator.ts 双轨同步）。
        //   旧逻辑 pending=null 使主进程只持有最后一段文本，渲染进程崩溃时
        //   #mergeAndPersist 无法以全文为基准补齐 DB 缺口。
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

      // ─── 快照 v2（统一恢复路径）：与 manager.accumulator.ts 双轨同步 ───

      case 'tool_progress': {
        const tp = event as {toolCallId?: string; progress?: string}
        if (!pending || !tp.toolCallId || !tp.progress) break
        const states = (pending.toolStates ??= {})
        states[tp.toolCallId] = {...states[tp.toolCallId], progress: tp.progress}
        appendProgressEntryImpl(pending, tp.toolCallId, tp.progress)
        break
      }

      case 'tool_detail': {
        const td = event as {toolCallId?: string; status?: string; progress?: number; eta?: number}
        if (!pending || !td.toolCallId) break
        const states = (pending.toolStates ??= {})
        states[td.toolCallId] = {
          ...states[td.toolCallId],
          ...(td.progress !== undefined ? {progressPercent: td.progress} : {}),
          ...(td.eta !== undefined ? {eta: td.eta} : {}),
          ...(td.status ? {detailStatus: td.status as 'queued' | 'running' | 'completed' | 'failed'} : {}),
        }
        break
      }

      case 'subagent_start': {
        const ss = event as {taskId?: string; description?: string}
        if (!ss.taskId) break
        if (!pending) pending = createPendingMsg()
        const streams = (pending.subAgentStream ??= {})
        const bucket = (streams[ss.taskId] ??= [])
        bucket.push({type: 'start', text: ss.description ?? '', ts: Date.now()})
        capSubAgentBucketImpl(bucket)
        break
      }

      case 'subagent_progress': {
        const sp = event as {taskId?: string; subAgentEvent?: string; progress?: string}
        if (!sp.taskId) break
        if (!pending) pending = createPendingMsg()
        const streams = (pending.subAgentStream ??= {})
        const bucket = (streams[sp.taskId] ??= [])
        bucket.push({type: sp.subAgentEvent ?? 'progress', text: sp.progress ?? '', ts: Date.now()})
        capSubAgentBucketImpl(bucket)
        break
      }

      case 'ask_user': {
        const au = event as {question?: string; options?: string[]; multiSelect?: boolean; requestId?: string}
        if (!au.question) break
        if (!pending) pending = createPendingMsg()
        pending.pendingQuestion = {
          question: au.question,
          options: au.options,
          multiSelect: au.multiSelect,
          requestId: au.requestId,
        }
        break
      }

      case 'permission_confirm': {
        const pc = event as {question?: string; requestId?: string}
        if (!pc.question) break
        if (!pending) pending = createPendingMsg()
        pending.pendingPermissionConfirm = {question: pc.question, requestId: pc.requestId}
        break
      }

      case 'done':
      case 'error': {
        // 终态清空阻塞态（兜底防陈旧阻塞态复活，与 accumulator.ts 双轨一致）
        if (pending) {
          pending.pendingQuestion = null
          pending.pendingPermissionConfirm = null
        }
        break
      }

      default:
    }

    // ★ id 对齐：新建 / turn reset 重建的 pending 一律复用渲染端占位 id
    //   （幂等：已对齐时重设相同值无副作用）
    if (pending && registeredMsgId) {
      pending.id = registeredMsgId
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

  /** 静默指定会话的循环检测指纹（渲染端"这是误判"，经 worker 转发给 Controller 检测门） */
  silenceLoopPattern(conversationId: string, fingerprint: string): void {
    const entry = this.workers.get(conversationId)
    if (entry) {
      entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.LOOP_SILENCE, fingerprint})
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

  /**
   * 广播会话级权限模式（主进程 → Worker）。postMessage 携带 convId，
   * 由 worker 侧按 params.conversationId 过滤——permissionEngine 是 per-worker
   * 单例，只允许目标会话的 worker 应用，避免串扰。
   */
  broadcastConvPermissionMode(convId: string, mode: import('@shared/types').RunMode): void {
    for (const id of this.getRunningConversations()) {
      const entry = this.workers.get(id)
      if (entry) {
        entry.worker.postMessage({type: WORKER_MESSAGE_TYPES.UPDATE_CONV_PERMISSION_MODE, convId, mode})
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

  /**
   * 崩溃恢复流快照（P1）：返回活跃 pending 的只读快照，供渲染端
   * recoverSessions 以主进程为唯一事实源重建流式状态。
   * pending 为 null（首 token 前崩溃窗口）时返回 null。
   */
  async getStreamSnapshot(conversationId: string) {
    const pending = this.pendingAssistantMsg.get(conversationId) ?? null
    if (!pending) return null
    let dbTextBlockCount = 0
    try {
      const {getDatabase} = await import('../repositories/sqlite')
      dbTextBlockCount = (getDatabase().prepare(
        "SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND block_type = 'text'"
      ).get(pending.id) as {c: number} | undefined)?.c ?? 0
    } catch {
      // DB 未就绪等极端情况：基线退化为 0（最坏情况是块 id 碰撞，不阻塞恢复）
    }
    return buildStreamSnapshot(pending, dbTextBlockCount)
  }

  // ─── Agent 模板加载 ──────────────────────────────────

  /** 从插件加载 Agent 模板 */
  loadPluginAgents(): AgentTemplate[] {
    return loadPluginAgents()
  }

  // ─── 内部工具方法 ───────────────────────────────────

  /** 向主窗口发送消息（自动检查窗口有效性） */
  private sendToMainWindow(channel: string, ...args: any[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }

  /** 转发事件到渲染进程（全窗口广播，spec §4.2 多窗口投递） */
  private forwardToRenderer(conversationId: string, event: AgentStreamEvent): void {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) {
      if (!SKIP_LOG_EVENT_TYPES.has(event.type)) {
        logger.info('forwardToRenderer', {skipType: event.type})
      }
      return
    }

    const payload = createForwardPayload(conversationId, event)

    // 循环检测警告：任务栏/托盘闪烁提醒（fire-and-forget，不阻塞转发）
    if (event.type === 'loop_suspected' || event.type === 'loop_escalated') {
      notifyUserAttention({force: true})
    }

    for (const win of windows) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('agent-stream', payload)
        } catch (err: unknown) {
          logger.error('forwardToRenderer', {error: err instanceof Error ? err.message : String(err)})
        }
      }
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

    this.workers.delete(conversationId)
    this.pendingAssistantMsg.delete(conversationId)
    this.streamingMsgIds.delete(conversationId)
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