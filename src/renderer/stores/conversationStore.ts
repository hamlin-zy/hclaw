import {createWithEqualityFn} from 'zustand/traditional'
import type {ConversationSummary, Message, ContentBlock} from '@shared/types'

import {useAgentStore, createDefaultConvData} from './agentStore'
import {fuzzyFilter} from '../lib/search'
import {collectDescendants} from './conversationTree'

interface WorkspaceInfo {
  lastOpenedAt: number
  conversations: ConversationSummary[]
}

interface ConversationStore {
  currentWorkspacePath: string | null
  activeConversationId: string | null
  workspaces: Record<string, WorkspaceInfo>
  loadedMessages: Message[]
    /** 所有会话的消息缓存，keyed by conversationId */
    messagesMap: Record<string, Message[]>
    /** 每个会话是否还有更多历史消息 */
    hasMoreMap: Record<string, boolean>
    /** 每个会话是否正在加载更早的消息 */
    loadingMoreMap: Record<string, boolean>
    /** 已渲染过的会话 ID 列表（LRU 缓存控制，非活跃 10 分钟后清理） */
    renderedConversationIds: string[]
    /** 每个会话的最后活跃时间戳 */
    conversationLastActiveAt: Record<string, number>
  searchQuery: string

    // Workspace
  setWorkspace: (path: string | null) => void
  removeWorkspace: (path: string) => void

    // Conversations
  createConversation: (title?: string) => Promise<string>
    handleSessionCreated: (convId: string, title: string, workspacePath: string, handoffFromConvId?: string, createdAt?: number, updatedAt?: number) => void
    /** 子会话创建事件处理（agent 工具创建）：侧栏顶部插入，保留其他工作区 */
    handleChildConvCreated: (convId: string, title: string, parentConvId?: string) => void
  deleteConversation: (id: string) => Promise<void>
    deleteConversations: (ids: string[]) => Promise<void>
  setActiveConversation: (id: string | null) => void
  updateConversationMeta: (convId: string, updates: { title?: string; preview?: string }) => void
    /** 会话元数据事件消费（§3.4）：message-finalized → 更新 updatedAt 并按侧栏规则重排 */
    touchConversation: (convId: string, updatedAt: number) => void
    togglePinConversation: (id: string) => void

  // Search
  setSearchQuery: (query: string) => void
  getFilteredConversations: () => ConversationSummary[]
    getConversationTitle: () => string

    /** 将会话标记为已渲染（加入 LRU 缓存） */
    markConversationRendered: (convId: string) => void
    /** 清理超过 10 分钟不活跃的已渲染会话 */
    cleanupInactiveConversations: () => void

    // Messages
  addMessage: (message: Omit<Message, 'id' | 'timestamp'> & { id?: string }) => void
    /** 向指定会话添加消息（用于非活跃会话的后台 agent 写入） */
    addMessageToConv: (convId: string, message: Omit<Message, 'id' | 'timestamp'> & { id?: string }) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
    /** 更新指定会话中的消息（用于非活跃会话的后台 agent 写入） */
    updateMessageForConv: (convId: string, id: string, updates: Partial<Message>) => void
    /** 块级增量：替换指定会话消息 contentBlocks 中指定 id 的块（其他块引用不变） */
    updateMessageBlockForConv: (convId: string, id: string, blockId: string, blockPatch: ContentBlock) => void
  deleteMessage: (id: string) => void
  loadMessages: (convId: string) => Promise<void>
    /** 增量加载：只加载最近 N 条，替代 loadMessages 的全量加载 */
    loadMessagesInitial: (convId: string, pageSize?: number) => Promise<void>
    /** 加载更早的消息（追加到头部） */
    loadMoreMessages: (convId: string, pageSize?: number) => Promise<void>
    /** 预加载（侧栏 hover 触发） */
    preloadConversation: (convId: string) => Promise<void>
  getMessages: () => Message[]
  truncateMessagesAfter: (id: string) => void

  // Init
  loadConversations: () => Promise<void>

  // Handoff guidance（交接引导）
  /** 会话级"交接弹窗不再提醒"标记（convId → true） */
  handoffDismissed: Record<string, boolean>
  dismissHandoffPrompt: (convId: string) => void
  clearHandoffDismissals: () => void
}

/** 默认 agent 空闲状态（切换会话时后备） */

const TOOL_RESULT_MEMORY_CAP = 2000

/** 生成扁平字符串副本。V8 的 slice/substring 对长串返回 SlicedString（引用整个父串，
 *  Chromium Issue 2869），截断大字符串后若不强制复制，被截掉的父串无法被 GC 释放。 */
export function flatString(s: string): string {
    return s.split('').join('')
}

/** 截断提示后缀（output 与 toolResult 共用） */
const TRUNCATE_SUFFIX = '\n\n*(输出过长，已截断。展开加载完整内容)*'

/** 截断 message 中大型工具结果的内存副本，完整内容已通过块级增量落库。
 *  幂等短路由 _fullOutputStored 标记承担：已截断过则跳过，避免双重截断提示。
 *  ★ 同时截断 output 与 toolResult 两个字段：normalizeToolResult 会为每个工具结果
 *    生成两份全文（output + formatToolResult 副本），只截 output 会导致 toolResult
 *    中的数 MB 原文永久驻留（堆快照实测 175MB）。 */
function truncateLargeResults(message: Message): Message {
    if (!message.toolCalls || message.toolCalls.length === 0) return message
    // ★ 快速扫描（零分配）：先确认确有需截断的项才重建数组。水合/翻页常对大量消息调用，
    //   绝大多数消息无需截断，此前无条件 map 会为每条消息新建 toolCalls 数组（虽被 GC 但
    //   属无谓分配）。扫描命中才走 map 重建，未命中直接返回原引用。
    const needsTruncate = message.toolCalls.some(tc => {
        const result = tc.result as {output?: unknown; toolResult?: string; _fullOutputStored?: boolean} | undefined
        if (!result || typeof result.output !== 'string') return false
        if (result._fullOutputStored) return false
        return result.output.length > TOOL_RESULT_MEMORY_CAP
            || (typeof result.toolResult === 'string' && result.toolResult.length > TOOL_RESULT_MEMORY_CAP)
    })
    if (!needsTruncate) return message
    let modified = false
    const truncated = message.toolCalls.map(tc => {
        const result = tc.result as {output?: unknown; toolResult?: string; _fullOutputStored?: boolean} | undefined
        if (!result || typeof result.output !== 'string') return tc
        if (result._fullOutputStored) return tc
        const outputTooLong = result.output.length > TOOL_RESULT_MEMORY_CAP
        const toolResultTooLong = typeof result.toolResult === 'string' && result.toolResult.length > TOOL_RESULT_MEMORY_CAP
        if (!outputTooLong && !toolResultTooLong) return tc
        modified = true
        return {
            ...tc,
            result: {
                ...result,
                output: outputTooLong
                    ? flatString(result.output.slice(0, TOOL_RESULT_MEMORY_CAP)) + TRUNCATE_SUFFIX
                    : result.output,
                ...(toolResultTooLong ? {
                    toolResult: flatString(result.toolResult!.slice(0, TOOL_RESULT_MEMORY_CAP)) + TRUNCATE_SUFFIX,
                } : {}),
                _fullOutputStored: true,
                _outputTruncatedLength: result.output.length,
            } as typeof tc.result,
        }
    })
    return modified ? { ...message, toolCalls: truncated } : message
}

/** 主动截断活跃会话的大工具结果（不等待 flushDirtyMessages）。
 *  每 30 秒执行一次，防止活跃会话工具结果在内存无界增长。 */
let activeTruncateTimer: ReturnType<typeof setTimeout> | null = null
let activeTruncateConvId: string | null = null

function scheduleActiveTruncate(convId: string) {
    // 如果已经在为同一会话调度，跳过
    if (activeTruncateTimer && activeTruncateConvId === convId) return
    // 取消之前的定时器（如果是不同会话）
    if (activeTruncateTimer) {
        clearTimeout(activeTruncateTimer)
        activeTruncateTimer = null
    }
    activeTruncateConvId = convId
    activeTruncateTimer = setTimeout(() => {
        activeTruncateTimer = null
        const store = useConversationStore.getState()
        const msgs = store.messagesMap[convId]
        if (!msgs) return
        let modified = false
        const newMsgs = msgs.map(m => {
            const truncated = truncateLargeResults(m)
            if (truncated !== m) modified = true
            return truncated
        })
        if (modified) {
            useConversationStore.setState({
                messagesMap: {...store.messagesMap, [convId]: newMsgs},
                loadedMessages: convId === store.activeConversationId ? newMsgs : store.loadedMessages,
            })
        }
        // 重新调度
        scheduleActiveTruncate(convId)
    }, 30000)
}

function clearActiveTruncate() {
    if (activeTruncateTimer) {
        clearTimeout(activeTruncateTimer)
        activeTruncateTimer = null
        activeTruncateConvId = null
    }
}

// ─── 单会话内存权重上限（兜底）──────────────────────────
// 长会话/重工具输出会话在非活跃时可能无界增长，本函数作为兜底：
// 权重超限的非活跃会话先 flush dirty，再 evict 最旧的 30% 消息。

const CONVERSATION_WEIGHT_CAP = 500

function computeMessageWeight(msg: Message): number {
    let w = 1
    w += (msg.contentBlocks?.length ?? 0)
    if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
            // 截断后 output 只剩 5KB，完整内容已在 DB（不驻留内存）——
            // 保守计权：读 _outputTruncatedLength 反映 DB 完整长度，否则按当前 output 长度
            const result = tc.result as {output?: string; _outputTruncatedLength?: number} | undefined
            const fullLen = typeof result?._outputTruncatedLength === 'number'
                ? result._outputTruncatedLength
                : (typeof result?.output === 'string' ? result.output.length : 0)
            if (fullLen > 1000) {
                // 真实字节计权：1000 字符 = 1 权重（此前固定 +5 严重低估，500 上限形同虚设）
                w += Math.max(1, Math.ceil(fullLen / 1000))
            }
        }
    }
    return w
}

async function maybeTrimConversation(convId: string): Promise<void> {
    const store = useConversationStore.getState()
    const msgs = store.messagesMap[convId]
    if (!msgs || convId === store.activeConversationId) return
    const totalWeight = msgs.reduce((sum, m) => sum + computeMessageWeight(m), 0)
    if (totalWeight <= CONVERSATION_WEIGHT_CAP) return

    // flush dirty 已随渲染端落库退出（Phase 3）而删除；直接截断 + evict
    const currentMsgs = useConversationStore.getState().messagesMap[convId]
    if (!currentMsgs) return
    // ★ 截断保留消息的大工具结果（在 evict 前）。非活跃会话里残留的超大 toolResult
    //   （如数 MB ANSI 文本）若不截断会一直驻留内存；这些结果完整内容已通过块级增量落库，
    //   内存截断安全且幂等（_fullOutputStored 短路）。只对引用变化的消息落 setState。
    const truncatedMsgs = currentMsgs.map(m => truncateLargeResults(m))
    if (truncatedMsgs.some((m, i) => m !== currentMsgs[i])) {
        useConversationStore.setState(state => ({
            messagesMap: { ...state.messagesMap, [convId]: truncatedMsgs },
            loadedMessages: convId === state.activeConversationId ? truncatedMsgs : state.loadedMessages,
        }))
    }
    const evictCount = Math.max(1, Math.floor(currentMsgs.length * 0.3))
    const kept = truncatedMsgs.slice(evictCount)

    useConversationStore.setState(state => ({
        messagesMap: { ...state.messagesMap, [convId]: kept },
        hasMoreMap: { ...state.hasMoreMap, [convId]: true },
    }))
}

/** 默认 agent 空闲状态（切换会话时后备） */
const DEFAULT_AGENT_STATE = {
    agentState: {
        status: 'idle' as const,
        mode: 'auto' as const,
        currentModelName: undefined,
        currentModelProvider: undefined,
    },
}

/** 判断是否为根会话：无父级，或父级已删除的孤儿子会话（与侧边栏分组逻辑一致） */
function isRootConversation(conv: ConversationSummary, idSet: Set<string>): boolean {
    return !conv.parentConvId || !idSet.has(conv.parentConvId)
}

/** 获取当前工作区第一个根会话的 ID（非子会话；启动激活 / 删除后切换目标） */
function getFirstRootConversationId(): string | null {
    const { currentWorkspacePath, workspaces } = useConversationStore.getState()
    if (!currentWorkspacePath) return null
    const convs = workspaces[currentWorkspacePath]?.conversations || []
    const idSet = new Set(convs.map(c => c.id))
    return convs.find(c => isRootConversation(c, idSet))?.id ?? null
}

/** 权限模式合法值（会话级 UI 仅暴露 safe/auto 两档，与 IPC 校验一致） */
function isPermissionMode(v: unknown): v is 'safe' | 'auto' {
    return v === 'safe' || v === 'auto'
}

/** 显示模式合法值 */
function isDisplayMode(v: unknown): v is 'detailed' | 'compact' | 'ultra-compact' {
    return v === 'detailed' || v === 'compact' || v === 'ultra-compact'
}

/**
 * 会话级模式初始化（会话激活时调用）：读取 conv.meta 的
 * permissionMode/displayMode，回退全局默认后写入 agentStore 顶层字段。
 * 渲染层 4 处消费点统一读顶层，无需改动。
 */
export async function applyConvModesToAgentStore(convId: string): Promise<void> {
    let meta: Record<string, unknown> | null = null
    try {
        meta = (await window.electronAPI?.conversationReadMeta?.(convId)) ?? null
    } catch {
        meta = null
    }
    const perm = meta?.permissionMode
    if (isPermissionMode(perm)) {
        useAgentStore.setState({permissionMode: perm})
    } else {
        try {
            const globalPerm = await window.electronAPI?.agentGetPermissionMode?.()
            if (isPermissionMode(globalPerm)) {
                useAgentStore.setState({permissionMode: globalPerm})
            }
        } catch { /* 保持现有值 */ }
    }
    const disp = meta?.displayMode
    if (isDisplayMode(disp)) {
        useAgentStore.setState({messageDisplayMode: disp})
    } else {
        try {
            const cfg: any = await window.electronAPI?.configRead?.('message-display-mode')
            if (isDisplayMode(cfg?.mode)) {
                useAgentStore.setState({messageDisplayMode: cfg.mode})
            }
        } catch { /* 保持现有值 */ }
    }
}

/** 切换会话状态核心逻辑：同步 loadedMessages、agent 状态、IPC 通知
 *  （落库已收敛至主进程，渲染端切换会话无需 flush）
 *  用于 setActiveConversation / deleteConversation / deleteConversations 共享路径 */
async function switchActiveConversation(id: string | null) {
    const store = useConversationStore.getState()
    if (id === store.activeConversationId) return

    // 切换前先清理旧活跃会话的定时截断
    clearActiveTruncate()

    if (id) {
        store.markConversationRendered(id)
        const targetMsgs = store.messagesMap[id]
        // ★ 如果 messagesMap 已有消息但缺少用户消息（流式子会话场景），
        //   先从 SQLite 加载持久化消息，再合并流式消息，确保用户消息不丢失
        if (targetMsgs && targetMsgs.some(m => m.role === 'user')) {
            useConversationStore.setState({ activeConversationId: id, loadedMessages: targetMsgs })
        } else {
            useConversationStore.setState({ activeConversationId: id })
            await store.loadMessagesInitial(id)
            // ★ 运行中的会话（status 为 running/thinking）：合并渲染进程内存态流式消息。
            //   内存消息为权威（含最新流式内容），SQLite 快照仅用于补缺——纯文本流期间主进程
            //   累积器只在 tool_result / llm_call_done 时机落库，快照可能陈旧，若以 SQLite 为权威
            //   会覆盖内存完整流式内容导致正文被截断。按消息 id 去重，同 id（msg-<ts>-<rand>）
            //   不重复；完成态（idle）不合并，以 SQLite 为准，防重复气泡。
            if (targetMsgs) {
                const agentConvData = useAgentStore.getState().convAgentStates[id]
                const agentStatus = agentConvData?.agentState.status
                // paused + pending 双态（ask_user / permission 阻塞）视同运行中，
                // 否则进入会话时内存流式消息不合并，气泡只显示 DB 陈旧快照
                const isBlockedPending = agentStatus === 'paused'
                    && !!(agentConvData?.pendingQuestion || agentConvData?.pendingPermissionConfirm)
                const isRunning = agentStatus === 'running' || agentStatus === 'thinking' || isBlockedPending
                if (isRunning) {
                    const {messagesMap} = useConversationStore.getState()
                    const sqliteMsgs = messagesMap[id] || []
                    const targetIds = new Set(targetMsgs.map(m => m.id))
                    const merged = [...sqliteMsgs.filter(m => !targetIds.has(m.id)), ...targetMsgs]
                        .sort((a, b) => a.timestamp - b.timestamp)
                    useConversationStore.setState({messagesMap: {...messagesMap, [id]: merged}, loadedMessages: merged})
                }
            }
        }
        // 同步该会话的 agent 状态（确保输入框和按钮状态正确）
        const agentStore = useAgentStore.getState()
        // ★ 渲染端补全（运行中会话）：切回时 DB/内存快照的 contentBlocks 滞后于流式进度
        //   （非活跃期间 contentBlocks 冻结不重建；块级落库惰性使 DB 只有已 flush 的 think 块，
        //   text/tool 块仍滞留 dirty 队列）→ 用 agentStore 的 streamBlocks/streamBuffer 重建
        //   完整 contentBlocks，修复"切回运行中会话只渲染 thinking、无正文/工具调用"。
        agentStore.reconcileStreamingContent?.(id)
        agentStore.updateConvData(id, agentStore.convAgentStates[id] ?? DEFAULT_AGENT_STATE)
        // 会话级模式初始化（meta → 全局默认回退）
        void applyConvModesToAgentStore(id)
    } else {
        useConversationStore.setState({ activeConversationId: null, loadedMessages: [] })
    }
    // 为新活跃会话启动定时截断
    if (id) {
        scheduleActiveTruncate(id)
    }
}

export const useConversationStore = createWithEqualityFn<ConversationStore>()(
  (set, get) => ({
      currentWorkspacePath: null,
      activeConversationId: null,
      workspaces: {},
      loadedMessages: [],
      messagesMap: {},
      hasMoreMap: {},
      loadingMoreMap: {},
      renderedConversationIds: [],
      conversationLastActiveAt: {},
      searchQuery: '',
      handoffDismissed: {},

      // ── Workspace ──────────────────────────────────────

      setWorkspace: async (path) => {
          if (!path) {
              set({currentWorkspacePath: null, activeConversationId: null})
              return
          }

          try {
              let workspace = await window.electronAPI?.workspace?.getByPath(path)
              if (!workspace) {
                  const id = `ws-${crypto.randomUUID()}`
                  const name = path.split(/[/\\]/).pop() || '新工作区'
                  await window.electronAPI?.workspace?.create(id, path, name)
                  workspace = await window.electronAPI?.workspace?.getByPath(path)
              }
              if (workspace) {
                  await window.electronAPI?.workspace?.setCurrent(workspace.id)
              }
          } catch (err) {
              console.error('[setWorkspace] error:', err)
          }

          set((state) => {
              const convs = state.workspaces[path]?.conversations || []
              const idSet = new Set(convs.map(c => c.id))
              // 仅激活根会话（非子会话），避免子会话抢占激活态
              const firstRoot = convs.find(c => isRootConversation(c, idSet))
              return {
                  currentWorkspacePath: path,
                  activeConversationId: firstRoot?.id || null,
                  workspaces: {...state.workspaces, [path]: {lastOpenedAt: Date.now(), conversations: convs}},
              }
          })

          // 加载消息仅针对根会话（与激活保持一致）
          const convs = get().workspaces[path]?.conversations || []
          const idSet = new Set(convs.map(c => c.id))
          const rootConv = convs.find(c => isRootConversation(c, idSet))
          if (rootConv) get().loadMessages(rootConv.id)
      },

      removeWorkspace: async (path) => {
          // 先获取 workspace id，以便从数据库中删除
          const workspace = await window.electronAPI?.workspace?.getByPath(path)
          const workspaceId = workspace?.id

          // 获取该工作区下的所有会话 ID，用于批量删除
          const conversations = await window.electronAPI?.conversationListByWorkspace?.(path)
          const convIds = conversations?.map((c: any) => c.id) || []

          set((state) => {
              const {[path]: _, ...rest} = state.workspaces
              return {
                  workspaces: rest,
                  currentWorkspacePath: state.currentWorkspacePath === path ? null : state.currentWorkspacePath,
                  activeConversationId: state.currentWorkspacePath === path ? null : state.activeConversationId,
              }
          })

          // 从数据库中删除会话和工作区记录
          if (convIds.length > 0) await window.electronAPI?.conversationDeleteBatch?.(convIds)
          if (workspaceId) await window.electronAPI?.workspace?.delete(workspaceId)
      },

      // ── Conversations ──────────────────────────────────

      createConversation: async (title?: string) => {
          const id = `conv-${crypto.randomUUID()}`
          const now = Date.now()
          const wsPath = get().currentWorkspacePath || ''
          // 新会话固化全局默认（session 级 mode 从创建那一刻生效；旧会话回退仍走全局）
          let defaultPerm: 'safe' | 'auto' = 'safe'
          let defaultDisp: 'detailed' | 'compact' | 'ultra-compact' = 'detailed'
          try {
              const gp = await window.electronAPI?.agentGetPermissionMode?.()
              if (isPermissionMode(gp)) defaultPerm = gp
          } catch { /* 静默：保持 'safe' */ }
          try {
              const cfg: any = await window.electronAPI?.configRead?.('message-display-mode')
              if (isDisplayMode(cfg?.mode)) defaultDisp = cfg.mode
          } catch { /* 静默：保持 'detailed' */ }
          const convTitle = title || '新对话'
          const meta = {
              id,
              title: convTitle,
              workspacePath: wsPath,
              createdAt: now,
              updatedAt: now,
              preview: '',
              status: 'active' as const,
              permissionMode: defaultPerm,
              displayMode: defaultDisp,
          }

          await window.electronAPI?.conversationCreate?.(id, meta)

          const summary: ConversationSummary = {
              id,
              title: convTitle,
              preview: '',
              createdAt: now,
              updatedAt: now,
              channel: undefined
          }

          set((state) => {
              if (!wsPath) return {
                  activeConversationId: id,
                  loadedMessages: [],
                  messagesMap: {...state.messagesMap, [id]: []}
              }
              const wsInfo = state.workspaces[wsPath] || {lastOpenedAt: now, conversations: []}
              return {
                  activeConversationId: id,
                  loadedMessages: [],
                  messagesMap: {...state.messagesMap, [id]: []},
                  workspaces: {
                      ...state.workspaces,
                      [wsPath]: {...wsInfo, conversations: [summary, ...wsInfo.conversations]}
                  },
              }
          })
          // 用默认值初始化新会话的 agent 状态，确保待办列表不会残留旧会话数据
          useAgentStore.getState().updateConvData(id, createDefaultConvData())
          // ★ 会话级模式：createConversation 不走 switchActiveConversation（直接 set 激活），
          //   顶层 seg 值会残留上一会话——此处显式写入刚固化的全局默认（meta 已含同值，
          //   无需经 applyConvModesToAgentStore 再读一次）
          useAgentStore.setState({permissionMode: defaultPerm, messageDisplayMode: defaultDisp})
          return id
      },

      // 会话移交工具创建新会话时的处理：侧栏顶部插入 + 自动切换（复用 createConversation 的 state 更新逻辑）
      handleSessionCreated: (convId, title, workspacePath, handoffFromConvId, createdAt, updatedAt) => {
          const now = Date.now()
          // 时间戳来自事件 payload（创建方 meta），缺省时兜底为当前时间，避免 Invalid Date
          const cAt = createdAt || now
          const uAt = updatedAt || cAt
          const summary: ConversationSummary = {
              id: convId,
              title,
              preview: '',
              createdAt: cAt,
              updatedAt: uAt,
              channel: undefined,
              handoffFromConvId: handoffFromConvId || undefined,
          }

          set((state) => {
              // 仅插入侧栏条目；activeConversationId 由下方 switchActiveConversation 统一设置
              const wsInfo = workspacePath
                  ? (state.workspaces[workspacePath] || {lastOpenedAt: now, conversations: []})
                  : undefined
              // 去重守卫：会话已存在（双投递）则不重复插入侧栏条目
              if (!wsInfo || wsInfo.conversations.some(c => c.id === convId)) return state
              return {
                  workspaces: {
                      ...state.workspaces,
                      [workspacePath]: {...wsInfo, conversations: [summary, ...wsInfo.conversations]},
                  },
              }
          })
          // 用默认值初始化新会话的 agent 状态，确保待办列表不会残留旧会话数据
          // ★ 时序保证：session_created 必然先于 session_handoff_start 被处理（同一
          //   worker→main 消息队列顺序投递），此重置发生在任何交接流事件之前，不会误伤。
          // ★ 防御：仅当该会话尚无活跃流状态（streamingMessageId）时才重置。
          //   memo/scheduler 等创建方若在 start() 之后才广播 session_created，
          //   begin/text 流事件已先到达并建立了占位消息——盲目重置会抹掉
          //   streamingMessageId，切换会话时 DB 覆盖内存占位且合并被跳过，
          //   产生孤儿空白助手气泡。
          const existingConvData = useAgentStore.getState().convAgentStates[convId]
          const hasLiveStream = Boolean(existingConvData?.streamingMessageId)
          if (!hasLiveStream) {
              useAgentStore.getState().updateConvData(convId, createDefaultConvData())
          }
          // ★ 激活切换复用手动切换链路 switchActiveConversation（而非裸 set）：
          //   含持久化消息加载 + 运行中会话内存流式消息合并 + reconcileStreamingContent
          //   重建 contentBlocks + 定时截断调度。此前裸 set + 异步 loadMessagesInitial
          //   整体覆盖 messagesMap 且无重建兜底，会冲掉已到达的流式占位消息，导致
          //   交接后新会话无运行态、助手气泡不渲染，必须手动切换会话才恢复。
          switchActiveConversation(convId).catch((err) => {
              console.error('[handleSessionCreated] switch failed:', err)
          })
      },

      // 子 Agent 独立会话创建事件处理：侧栏顶部插入 + 自动归属当前工作区
      // ★ 必须保留其他工作区条目（...state.workspaces），否则项目选择器会丢失其他项目
      handleChildConvCreated: (convId, title, parentConvId) => {
          const now = Date.now()
          const summary: ConversationSummary = {
              id: convId,
              title,
              preview: '',
              createdAt: now,
              updatedAt: now,
              parentConvId: parentConvId || undefined,
          }
          set((state) => {
              const wsPath = state.currentWorkspacePath
              if (!wsPath) return state
              const wsInfo = state.workspaces[wsPath]
              if (!wsInfo) return state
              // 去重守卫：会话已存在（双投递）则跳过
              if (wsInfo.conversations.some(c => c.id === convId)) return state
              return {
                  workspaces: {
                      ...state.workspaces,
                      [wsPath]: {...wsInfo, conversations: [summary, ...wsInfo.conversations]},
                  },
              }
          })
      },

      deleteConversation: async (id) => {
          const state = get()
          const wsPath = state.currentWorkspacePath
          const conversations = wsPath ? state.workspaces[wsPath]?.conversations ?? [] : []
          const toDelete = collectDescendants(conversations, [id])
          const wasActive = toDelete.includes(state.activeConversationId || '')
          await window.electronAPI?.conversationDeleteBatch?.(toDelete)
          set((state) => {
              const restMap = {...state.messagesMap}
              for (const delId of toDelete) {
                  delete restMap[delId]
              }
              const wsPath = state.currentWorkspacePath
              if (!wsPath || !state.workspaces[wsPath]) return {...state, messagesMap: restMap}
              const remaining = state.workspaces[wsPath].conversations.filter(c => !toDelete.includes(c.id))
              return {
                  messagesMap: restMap,
                  workspaces: {...state.workspaces, [wsPath]: {...state.workspaces[wsPath], conversations: remaining}},
              }
          })
          if (wasActive) await switchActiveConversation(getFirstRootConversationId())
          // 删除会话时同步清理 agent 运行时状态（含全部后代子会话）
          for (const delId of toDelete) {
              useAgentStore.getState().removeConvData(delId)
          }
      },

      deleteConversations: async (ids) => {
          if (!ids.length) return
          const state = get()
          const wsPath = state.currentWorkspacePath
          const conversations = wsPath ? state.workspaces[wsPath]?.conversations ?? [] : []
          const toDelete = collectDescendants(conversations, ids)
          const wasActiveIncluded = toDelete.includes(state.activeConversationId || '')
          await window.electronAPI?.conversationDeleteBatch?.(toDelete)
          set((s) => {
              const newWorkspaces: Record<string, WorkspaceInfo> = {}
              for (const [wsPath, wsInfo] of Object.entries(s.workspaces)) {
                  newWorkspaces[wsPath] = {
                      ...wsInfo,
                      conversations: wsInfo.conversations.filter(c => !toDelete.includes(c.id))
                  }
              }
              const newMap = {...s.messagesMap}
              for (const delId of toDelete) {
                  delete newMap[delId]
              }
              return {messagesMap: newMap, workspaces: newWorkspaces}
          })
          if (wasActiveIncluded) await switchActiveConversation(getFirstRootConversationId())
          for (const delId of toDelete) {
              useAgentStore.getState().removeConvData(delId)
          }
      },

      setActiveConversation: async (id) => {
          if (id === get().activeConversationId) return
          // 刷新待处理的批次数据（文本 + 工具结果），防止切换后丢失正在流式的内容
          useAgentStore.getState().flushPendingStreamData()
          await switchActiveConversation(id)
      },

      updateConversationMeta: (id, updates) => {
          set((state) => {
              const wsPath = state.currentWorkspacePath
              if (!wsPath || !state.workspaces[wsPath]) return state
              return {
                  workspaces: {
                      ...state.workspaces,
                      [wsPath]: {
                          ...state.workspaces[wsPath],
                          conversations: state.workspaces[wsPath].conversations.map(c => c.id === id ? {
                              ...c, ...updates,
                              updatedAt: Date.now()
                          } : c),
                      },
                  },
              }
          })
          window.electronAPI?.conversationUpdateMeta?.(id, {...updates, updatedAt: Date.now()})
      },

      /** 会话元数据事件消费（§3.4）：message-finalized → 更新 updatedAt。
       *  ★ 稳定排序方案：列表按 createdAt 倒序固定，此处不再触发重排——
       *  后台 loop 结束落库不会把会话顶到列表最上方（用户诉求：顺序稳定优于活动时间排序）。 */
      touchConversation: (convId, updatedAt) => {
          set((state) => {
              const wsPath = state.currentWorkspacePath
              if (!wsPath || !state.workspaces[wsPath]) return state
              const conversations = state.workspaces[wsPath].conversations.map(c =>
                  c.id === convId ? {...c, updatedAt: Math.max(c.updatedAt || 0, updatedAt)} : c
              )
              return {
                  workspaces: {...state.workspaces, [wsPath]: {...state.workspaces[wsPath], conversations}},
              }
          })
      },

      togglePinConversation: (id) => {
          let newPinned = false
          set((state) => {
                  const wsPath = state.currentWorkspacePath
                  if (!wsPath || !state.workspaces[wsPath]) return state
                  const conversations = state.workspaces[wsPath].conversations.map(c => {
                      if (c.id === id) {
                          newPinned = !c.pinned;
                          return {...c, pinned: newPinned, updatedAt: Date.now()}
                      }
                      return c
                  })
                  return {workspaces: {...state.workspaces, [wsPath]: {...state.workspaces[wsPath], conversations}}}
              }
          )
          window.electronAPI?.conversationUpdateMeta?.(id, {pinned: newPinned})
      },

      // ── Search ─────────────────────────────────────────

      setSearchQuery: (query) => set({searchQuery: query}),

      // ── Handoff guidance（交接引导）──────────────────────

      dismissHandoffPrompt: (convId) =>
          set((s) => ({handoffDismissed: {...s.handoffDismissed, [convId]: true}})),
      clearHandoffDismissals: () => set({handoffDismissed: {}}),

      getFilteredConversations: () => {
          const {currentWorkspacePath, workspaces, searchQuery} = get()
          if (!currentWorkspacePath || !workspaces[currentWorkspacePath]) return []
          let filtered = workspaces[currentWorkspacePath].conversations
          filtered = fuzzyFilter(filtered, searchQuery, ['title', 'preview'])
          return [...filtered].sort((a, b) => {
              if (a.pinned && !b.pinned) return -1
              if (!a.pinned && b.pinned) return 1
              return (b.createdAt || 0) - (a.createdAt || 0)
          })
      },

      getConversationTitle: () => {
          const {currentWorkspacePath, workspaces, activeConversationId} = get()
          return (currentWorkspacePath ? workspaces[currentWorkspacePath]?.conversations : [])?.find((c: any) => c.id === activeConversationId)?.title || ''
      },

      // ── Messages ──────────────────────────────────────

      /** 向指定会话添加消息（仅更新 UI 状态，持久化由主进程处理） */
      addMessageToConv: (convId: string, message: Omit<Message, 'id' | 'timestamp'> & { id?: string }) => {
          const newMessage: Message = {...message, id: message.id || crypto.randomUUID(), timestamp: Date.now()}
          const convMsgs = get().messagesMap[convId] || []
          const newConvMsgs = [...convMsgs, newMessage]
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
              loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
          }))
          // 异步检查内存权重上限（不阻塞当前操作）
          setTimeout(() => maybeTrimConversation(convId), 0)
      },

      /** 更新指定会话中的消息（仅更新 UI 状态，持久化由主进程处理） */
      updateMessageForConv: (convId: string, id: string, updates: Partial<Message>) => {
          const convMsgs = get().messagesMap[convId] || []
          const idx = convMsgs.findIndex(m => m.id === id)
          if (idx === -1) return
          const current = convMsgs[idx]
          // ★ 短路优化：updates 字段与当前值完全一致时不触发 setState / 权重检查。
          //   流式高频路径（textBatch 每 24ms flush）常以相同 patch 重复调用（如 thinking
          //   状态切换、batch flush 到无增量内容），此时不必要的数组 whole-copy
          //   + setTimeout(maybeTrim) 会重复触发订阅链与分配。
          //   仅当确有变化（浅比较 updates 各字段）才走更新。
          let changed = false
          for (const key of Object.keys(updates) as Array<keyof Message>) {
              if ((updates as any)[key] !== (current as any)[key]) { changed = true; break }
          }
          if (!changed) return
          const newConvMsgs = [...convMsgs]
          newConvMsgs[idx] = {...newConvMsgs[idx], ...updates}
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
              loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
          }))
          // 异步检查内存权重上限（不阻塞当前操作）
          setTimeout(() => maybeTrimConversation(convId), 0)
      },

      /** 块级增量：替换 contentBlocks 数组中指定 id 的块（其他块引用不变 → React.memo bail out）
       *  无该 id 时追加到末尾；找不到 message 安全返回（spec §6.2 方案 B1） */
      updateMessageBlockForConv: (convId: string, id: string, blockId: string, blockPatch: ContentBlock) => {
          const msg = get().messagesMap[convId]?.find(m => m.id === id)
          if (!msg) return
          const blocks = msg.contentBlocks || []
          const bIdx = blocks.findIndex(b => b.id === blockId)
          // 块级替换：新建数组但未变化块保持引用（React.memo bail out 依赖）
          const newBlocks = bIdx === -1
              ? [...blocks, blockPatch]
              : blocks.map((b, i) => (i === bIdx ? blockPatch : b))
          // 复用 updateMessageForConv 的 set（纯内存更新，落库由主进程流式通路承担），消除重复
          get().updateMessageForConv(convId, id, {contentBlocks: newBlocks})
      },

      addMessage: (message) => {
          const convId = get().activeConversationId
          if (!convId) return
          get().addMessageToConv(convId, message)
      },

      updateMessage: (id, updates) => {
          const convId = get().activeConversationId
          if (!convId) return
          get().updateMessageForConv(convId, id, updates)
      },

      deleteMessage: (id) => {
          const convId = get().activeConversationId
          if (!convId) return
          const convMsgs = get().messagesMap[convId] || []
          const newConvMsgs = convMsgs.filter(m => m.id !== id)
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
              loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
          }))
          if (convId) {
              window.electronAPI?.conversationDeleteMessage?.(convId, id)
          }
      },

      loadMessages: async (convId) => {
          // 从磁盘加载消息，存入 messagesMap
          const msgs = await window.electronAPI?.conversationReadMessages?.(convId) || []
          // ★ 内存泄漏修复：全量读回（启动/压缩/渠道 reload）的大工具结果同样在进
          //   messagesMap 前截断。DB 仍存完整 result 供主进程 LLM 上下文，此处只截内存副本。
          const msgsTyped = (msgs as Message[]).map(m => truncateLargeResults(m))
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: msgsTyped},
              loadedMessages: convId === state.activeConversationId ? msgsTyped : state.loadedMessages,
          }))
      },

      /** 增量加载：只加载最近 N 条消息（默认 50，确保切换会话时看到完整上下文） */
      loadMessagesInitial: async (convId, pageSize = 50) => {
          const result = await window.electronAPI?.conversationReadTail?.(convId, pageSize) || {
              messages: [],
              totalCount: 0
          }
          // ★ 内存泄漏修复：从 DB 水合的大工具结果必须在进 messagesMap 前截断。
          //   DB（message_blocks.tool_result.data）存的是完整 result，供主进程 LLM 上下文
          //   完整复原（execution.ts:72 readMessages）与缓存命中率——此处只在渲染内存副本上
          //   截断，绝不动 DB，故不影响 LLM 通路。_fullOutputStored 幂等短路避免重复截断。
          const msgs = (result.messages as Message[]).map(m => truncateLargeResults(m))
          const totalCount = result.totalCount
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: msgs},
              loadedMessages: convId === state.activeConversationId ? msgs : state.loadedMessages,
              hasMoreMap: {...state.hasMoreMap, [convId]: msgs.length < totalCount},
          }))
      },

      /** 加载更早的消息（追加到 messagesMap 头部） */
      loadMoreMessages: async (convId, pageSize = 2) => {
          if (get().loadingMoreMap[convId]) return // 防止重复加载
          const existing = get().messagesMap[convId]
          if (!existing || existing.length === 0) return
          const earliestTs = existing[0].timestamp

          set(state => ({loadingMoreMap: {...state.loadingMoreMap, [convId]: true}}))
          try {
              const result = await window.electronAPI?.conversationReadBefore?.(convId, earliestTs, pageSize) || {
                  messages: [],
                  totalCount: 0
              }
              const olderMsgs = (result.messages as Message[]).map(m => truncateLargeResults(m))
              const totalCount = result.totalCount
              if (olderMsgs.length === 0) {
                  // 没有更多了
                  set(state => ({hasMoreMap: {...state.hasMoreMap, [convId]: false}}))
                  return
              }
              const newMsgs = [...olderMsgs, ...existing]
              set(state => ({
                  messagesMap: {...state.messagesMap, [convId]: newMsgs},
                  loadedMessages: convId === state.activeConversationId ? newMsgs : state.loadedMessages,
                  hasMoreMap: {...state.hasMoreMap, [convId]: newMsgs.length < totalCount},
              }))
          } finally {
              set(state => ({loadingMoreMap: {...state.loadingMoreMap, [convId]: false}}))
          }
      },

      /** 预加载（侧栏 hover 触发，与 loadMessagesInitial 相同） */
      preloadConversation: async (convId) => {
          // 如果已有消息则跳过
          if (get().messagesMap[convId] && get().messagesMap[convId]!.length > 0) return
          await get().loadMessagesInitial(convId)
      },

      getMessages: () => get().loadedMessages,

      truncateMessagesAfter: (id) => {
          const convId = get().activeConversationId
          if (!convId) return
        set((state) => {
            const convMsgs = state.messagesMap[convId] || []
            const idx = convMsgs.findIndex(m => m.id === id)
          if (idx === -1) return state
            const newConvMsgs = convMsgs.slice(0, idx + 1)
            return {
                messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
                loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
            }
        })
      },

      // ── Init ───────────────────────────────────────────

      loadConversations: async () => {
          const currentWorkspace = await window.electronAPI?.workspace?.getCurrent()
          const currentWorkspacePath = currentWorkspace?.path || null
          const allMetas = await window.electronAPI?.conversationList?.() || []

          const workspaces: Record<string, WorkspaceInfo> = {}
          for (const meta of allMetas as any[]) {
              const wsPath = meta.workspacePath
              if (!wsPath) continue
              if (!workspaces[wsPath]) workspaces[wsPath] = {
                  lastOpenedAt: meta.updatedAt || Date.now(),
                  conversations: []
              }
              const summary: ConversationSummary = {
                  id: meta.id,
                  title: meta.title,
                  preview: meta.preview || '',
                  createdAt: meta.createdAt,
                  updatedAt: meta.updatedAt,
                  pinned: meta.pinned,
                  channel: meta.channel,
                  status: meta.status,
                  parentConvId: meta.parentConvId,
                  handoffFromConvId: meta.handoffFromConvId,
              }
              if (!workspaces[wsPath].conversations.find(c => c.id === summary.id)) {
                  workspaces[wsPath].conversations.push(summary)
              }
          }

          for (const ws of Object.values(workspaces)) {
              ws.conversations.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          }

          set({workspaces, currentWorkspacePath})

          if (currentWorkspacePath && workspaces[currentWorkspacePath]?.conversations[0]) {
              // ★ 仅激活并渲染根会话（非子会话）。
              //   列表按 updatedAt 排序，而 agent 工具创建的子会话 updatedAt 较新常排在前，
              //   若直接取 conversations[0] 会错误激活/渲染子会话。
              const convs = workspaces[currentWorkspacePath].conversations
              const idSet = new Set(convs.map(c => c.id))
              const root = convs.find(c => isRootConversation(c, idSet)) ?? convs[0]
              set({activeConversationId: root.id})
              get().markConversationRendered(root.id)
              await get().loadMessagesInitial(root.id)
          }

          // ★ 后台批量预加载当前工作区所有其他会话的前 2 条消息
          // 并发控制：每批 5 个，避免瞬间发起大量 SQLite 查询
          if (currentWorkspacePath && workspaces[currentWorkspacePath]) {
              const convs = workspaces[currentWorkspacePath].conversations
              const toPreload = convs.filter(c => {
                  const existing = get().messagesMap[c.id]
                  return !existing || existing.length === 0
              })
              const concurrency = 5
              ;(async () => {
                  for (let i = 0; i < toPreload.length; i += concurrency) {
                      const batch = toPreload.slice(i, i + concurrency)
                      await Promise.allSettled(batch.map(c => get().loadMessagesInitial(c.id)))
                  }
              })()
          }
      },


      // ── LRU 缓存 ─────────────────────────────────────────

      markConversationRendered: (convId) => {
          set((state) => ({
              renderedConversationIds: state.renderedConversationIds.includes(convId)
                  ? state.renderedConversationIds
                  : [...state.renderedConversationIds, convId],
              conversationLastActiveAt: {
                  ...state.conversationLastActiveAt,
                  [convId]: Date.now(),
              },
          }))
      },

      cleanupInactiveConversations: () => {
          const now = Date.now()
          const TEN_MIN_MS = 10 * 60 * 1000
          const state = get()
          const keepIds = state.renderedConversationIds.filter(id => {
              if (id === state.activeConversationId) return true
              // ★ Agent 保护：运行中或等待用户交互的会话不允许清理
              const agentConv = useAgentStore.getState().convAgentStates[id]
              if (agentConv?.agentState?.status === 'running' ||
                  agentConv?.agentState?.status === 'thinking') return true
              if (agentConv?.pendingPermissionConfirm ||
                  agentConv?.pendingQuestion) return true
              const lastActive = state.conversationLastActiveAt[id] ?? 0
              return now - lastActive < TEN_MIN_MS
          })
          const removedIds = state.renderedConversationIds.filter(id => !keepIds.includes(id))
          if (removedIds.length === 0) return

          const newMsgMap = {...state.messagesMap}
          const newHasMoreMap = {...state.hasMoreMap}
          const newLoadingMoreMap = {...state.loadingMoreMap}
          for (const id of removedIds) {
              delete newMsgMap[id]
              delete newHasMoreMap[id]
              delete newLoadingMoreMap[id]
          }

          set({
              renderedConversationIds: keepIds,
              conversationLastActiveAt: Object.fromEntries(
                  Object.entries(state.conversationLastActiveAt).filter(([id]) => keepIds.includes(id))
              ),
              messagesMap: newMsgMap,
              hasMoreMap: newHasMoreMap,
              loadingMoreMap: newLoadingMoreMap,
          })

          // 同步清理非活跃会话的 agent 运行时状态（streamBuffer、thinkingContent 等）
          for (const id of removedIds) {
              useAgentStore.getState().removeConvData(id)
          }
      },
  })
)

// ─── 监听主进程推送的新会话（渠道/定时任务创建等） ──────────

if (typeof window !== 'undefined') {
    window.electronAPI?.onConversationCreated?.((conv: any) => {
        const state = useConversationStore.getState()

        // 先检查所有工作区中是否已存在该会话（去重）
        const {workspaces} = useConversationStore.getState()
        for (const ws of Object.values(workspaces) as any[]) {
            if (ws.conversations?.some((c: any) => c.id === conv.id)) return
        }

        // 定时任务会话：自动归入当前工作目录（不隔离开关）
        const wsPath = conv.channel === 'schedule'
          ? state.currentWorkspacePath
          : (conv.workspacePath || state.currentWorkspacePath || '')
        if (!wsPath) return

        const summary: ConversationSummary = {
            id: conv.id,
            title: conv.title || '新对话',
            preview: conv.preview || '',
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            pinned: conv.pinned,
            channel: conv.channel,
            status: conv.status,
            parentConvId: conv.parentConvId || undefined,
            handoffFromConvId: conv.handoffFromConvId || undefined,
        }

        const wsInfo = workspaces[wsPath] || {lastOpenedAt: Date.now(), conversations: []}
        const updatedConvs = [summary, ...wsInfo.conversations]
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

        const updates: any = {
            workspaces: {
                ...workspaces,
                [wsPath]: {
                    ...wsInfo,
                    conversations: updatedConvs,
                },
            },
        }

        // 如果当前未选中工作区，且会话所属工作区有效，自动切换过去
        if (!state.currentWorkspacePath && wsPath) {
            updates.currentWorkspacePath = wsPath
            updates.activeConversationId = summary.id
        }

        useConversationStore.setState(updates)

        // 回退方案：如果直接添加后仍找不到该会话（如工作区结构不完整），
        // 触发一次全量刷新以同步数据
        setTimeout(() => {
            const after = useConversationStore.getState()
            const found = Object.values(after.workspaces).some(
                (ws: any) => ws.conversations?.some((c: any) => c.id === conv.id)
            )
            if (found) return

            // 全量刷新前保存当前激活会话，避免 loadConversations 自动切换
            const prevActiveId = after.activeConversationId
            after.loadConversations().then(() => {
                if (prevActiveId) {
                    useConversationStore.setState({activeConversationId: prevActiveId})
                }
            })
        }, 500)
    })

    // 监听会话元数据更新（如渠道消息更新 preview）
    window.electronAPI?.onConversationUpdated?.((data: {
        id: string;
        preview?: string;
        title?: string;
        status?: 'active' | 'running' | 'archived';
        updatedAt?: number;
        reloadMessages?: boolean  // 渠道消息专用：强制从 DB 重新加载消息列表
    }) => {
        const state = useConversationStore.getState()
        const {workspaces, currentWorkspacePath, messagesMap, activeConversationId} = state
        if (!currentWorkspacePath) return

        // 只清除非活跃会话的消息缓存，确保切换回该会话时从 DB 重新读取最新消息（如手机端消息）
        // 活跃会话的缓存不清除：1) 避免丢失尚未持久化的内存消息（新会话首条 Ctrl+K 自动重命名）
        // 压缩场景下的缓存更新由 compact_done 事件中的 loadMessages 自行管理
        if (data.id !== activeConversationId && data.id in messagesMap && messagesMap[data.id]!.length > 0) {
            const newMap = {...messagesMap}
            delete newMap[data.id]
            useConversationStore.setState({messagesMap: newMap})
        }

        const wsInfo = workspaces[currentWorkspacePath]
        if (!wsInfo) return

        const convIndex = wsInfo.conversations.findIndex(c => c.id === data.id)
        if (convIndex === -1) return

        // 更新会话列表中的对应会话
        const updatedConversations = [...wsInfo.conversations]
        updatedConversations[convIndex] = {
            ...updatedConversations[convIndex],
            ...(data.preview !== undefined && {preview: data.preview}),
            ...(data.title !== undefined && {title: data.title}),
            ...(data.status !== undefined && {status: data.status}),
            updatedAt: data.updatedAt || Date.now(),
        }

        useConversationStore.setState({
            workspaces: {
                ...workspaces,
                [currentWorkspacePath]: {
                    ...wsInfo,
                    conversations: updatedConversations,
                },
            },
        })

        // ★ 渠道消息专用：主动 reloadMessages 时，从 DB 重新加载消息列表
        // 渠道消息是先写 DB 再通知 UI，不存在未持久化的问题，可以安全地 reload
        if (data.reloadMessages && data.id === activeConversationId) {
            console.log(`[DEBUG:UI] reloadMessages triggered for conv=${data.id.slice(0, 12)}`)
            useConversationStore.getState().loadMessages(data.id)
        }

        // 只更新元数据标题/预览，不重新加载消息列表（默认行为）
        // 防止 loadMessages 覆盖 messagesMap 中尚未持久化的新消息（如新会话首条 Ctrl+K 消息）
        // 非活跃会话的消息加载由用户切换会话时的 setActiveConversation → loadMessagesInitial 触发
    })

    // 监听主进程推送的会话删除（任意窗口删除后，其他窗口从侧栏同步移除）
    window.electronAPI?.onConversationDeleted?.(({ids}) => {
        const idSet = new Set(ids)
        const state = useConversationStore.getState()
        const workspaces = {...state.workspaces}
        for (const [wsPath, wsInfo] of Object.entries(workspaces) as any[]) {
            const remaining = (wsInfo.conversations || []).filter((c: any) => !idSet.has(c.id))
            if (remaining.length !== (wsInfo.conversations || []).length) {
                workspaces[wsPath] = {...wsInfo, conversations: remaining}
            }
        }

        const updates: any = {workspaces}

        // 激活会话被删除：清理激活态与消息缓存（由 UI 回退到空会话页）
        if (state.activeConversationId && idSet.has(state.activeConversationId)) {
            updates.activeConversationId = null
            const newMap = {...state.messagesMap}
            for (const id of ids) delete newMap[id]
            updates.messagesMap = newMap
        }
        useConversationStore.setState(updates)
    })
}
