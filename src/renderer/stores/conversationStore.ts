import {createWithEqualityFn} from 'zustand/traditional'
import type {ConversationSummary, Message} from '@shared/types'

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
  createConversation: () => Promise<string>
  deleteConversation: (id: string) => Promise<void>
    deleteConversations: (ids: string[]) => Promise<void>
  setActiveConversation: (id: string | null) => void
  updateConversationMeta: (convId: string, updates: { title?: string; preview?: string }) => void
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
  deleteMessage: (id: string) => void
  loadMessages: (convId: string) => Promise<void>
    /** 增量加载：只加载最近 N 条，替代 loadMessages 的全量加载 */
    loadMessagesInitial: (convId: string, pageSize?: number) => Promise<void>
    /** 加载更早的消息（追加到头部） */
    loadMoreMessages: (convId: string, pageSize?: number) => Promise<void>
    /** 预加载（侧栏 hover 触发） */
    preloadConversation: (convId: string) => Promise<void>
  saveMessages: () => Promise<void>
  flushMessages: () => void
    /** 取消未执行的持久化定时器（用于压缩等场景，防止 stale 数据覆盖 SQLite） */
    cancelPendingSave: () => void
  getMessages: () => Message[]
  truncateMessagesAfter: (id: string) => void

  // Init
  loadConversations: () => Promise<void>
}

// ─── Persistence: delta-first (增量优先) ───────────────────────
// 性能优化：流式期间高频落库只写"变化的那一条消息"（conversation-write-messages-delta），
// 不做全量重写，IPC 传输和 SQLite 写入量都小 1~2 个数量级。
// 断电保留粒度：单条消息级，且事务原子（该消息要么完整要么不存在）。
// 全量写（saveMessages）仅保留在退出/切换兜底路径。

let saveTimer: ReturnType<typeof setTimeout> | null = null
let isDirty = false

/** 每会话的 dirty 消息 Map（messageId → Message），只增不减，flush 后清空 */
const dirtyMessages: Record<string, Map<string, Message>> = {}
/** 每会话的 delta 落库 debounce timer */
const deltaTimers: Record<string, ReturnType<typeof setTimeout> | null> = {}

function getDirtyMap(convId: string): Map<string, Message> {
    if (!dirtyMessages[convId]) dirtyMessages[convId] = new Map()
    return dirtyMessages[convId]
}

// ─── 子会话判定缓存 ─────────────────────────────────────
// isChildConversation 在流式落库路径（markMessageDirty/scheduleDeltaSave/...）高频调用，
// 每次 find 全量扫描 conversations。缓存父→子关系：只关心「某 id 是否在 conversations 中
// 且带 parentConvId」。通过 zustand subscribe 在 workspaces/currentWorkspacePath 变化时
// 重建缓存（缓存键 = 所有子会话 id 集合），避免每次 find。

/** 子会话 id 缓存（含 currentWorkspacePath 版本号，防止工作区切换后误命中） */
let childConvIdsCache = new Set<string>()
let childConvCacheKey = ''

/** 校验缓存并重建（写路径高频调用，开销 O(conversations)，远小于多次 find） */
function ensureChildConvCache(): void {
    const state = useConversationStore.getState()
    const wsPath = state.currentWorkspacePath || ''
    const convs = wsPath ? state.workspaces[wsPath]?.conversations ?? [] : []
    // 会话列表按工作区隔离；指纹 = 工作区 + 所有会话的 id:parentConvId 摘要，
    // 任一会话增删/父级变化/工作区切换都会改变指纹，从而触发重建。
    let fingerprint = wsPath
    for (const c of convs) {
        fingerprint += `|${c.id}:${c.parentConvId || ''}`
    }
    if (fingerprint === childConvCacheKey) return
    childConvCacheKey = fingerprint
    const childIds = new Set<string>()
    for (const c of convs) {
        if (c.parentConvId) childIds.add(c.id)
    }
    childConvIdsCache = childIds
}

/**
 * 判断是否为子会话（agent 工具创建）。
 * 子会话的持久化由主进程 agentTool 负责（写入 user 任务消息 + 最终 assistant 结果），
 * 渲染端不得落库子会话消息，否则流式期间写入的 UUID 消息会与 agentTool 写入的
 * msg-<timestamp> 消息重复（幽灵重复气泡）。
 */
function isChildConversation(convId: string): boolean {
    if (!convId) return false
    ensureChildConvCache()
    return childConvIdsCache.has(convId)
}

/** 标记一条消息为 dirty（内存态已更新，待增量落库） */
function markMessageDirty(convId: string, message: Message) {
    // ★ 子会话不落库（主进程 agentTool 负责持久化，见 isChildConversation）
    if (isChildConversation(convId)) return
    getDirtyMap(convId).set(message.id, message)
    isDirty = true
}

/** 调度该会话的增量落库（debounce 合并流式高频更新） */
function scheduleDeltaSave(convId: string, delay: number) {
    if (isChildConversation(convId)) return
    if (deltaTimers[convId]) clearTimeout(deltaTimers[convId]!)
    deltaTimers[convId] = setTimeout(() => {
        deltaTimers[convId] = null
        void flushDirtyMessages(convId)
    }, delay)
}

/** 立即把某会话的 dirty 消息增量写入 SQLite */
async function flushDirtyMessages(convId: string): Promise<void> {
    // ★ 子会话不落库（主进程 agentTool 负责持久化）
    if (isChildConversation(convId)) {
        // 清理可能残留的 dirty 标记（修复前标记的旧条目）
        dirtyMessages[convId]?.clear()
        return
    }
    if (deltaTimers[convId]) {
        clearTimeout(deltaTimers[convId])
        deltaTimers[convId] = null
    }
    const dirtyMap = dirtyMessages[convId]
    if (!dirtyMap || dirtyMap.size === 0) return
    const pending = [...dirtyMap.values()]
    dirtyMap.clear()

    try {
        // 逐条 delta 写入（串行 invoke，避免 IPC 并发顺序错乱）
        for (const msg of pending) {
            await window.electronAPI?.conversationWriteMessagesDelta?.(convId, msg)
        }
    } catch {
        // 失败不重试（下次 scheduleDeltaSave 会重新标记），避免积压
    }
}

/** 持久化指定会话的全部消息（全量路径，仅退出/切换兜底使用） */
async function persistMessages(convId: string, messages: Message[]) {
    if (convId && !isChildConversation(convId)) {
        await window.electronAPI?.conversationWriteMessages?.(convId, messages)
    }
}

function forceFlush() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
    // 增量优先：刷所有会话的 dirty 消息
    const {activeConversationId, loadedMessages} = useConversationStore.getState()
    const convIds = Object.keys(dirtyMessages)
    for (const convId of convIds) {
        void flushDirtyMessages(convId)
    }
    // 若没有 dirty 消息但标记了 isDirty（全量待写），走全量兜底
  if (activeConversationId && isDirty) {
      const hasDirty = (dirtyMessages[activeConversationId]?.size ?? 0) > 0
      if (!hasDirty) {
          persistMessages(activeConversationId, loadedMessages)
      }
    isDirty = false
  }
}

/** 仅取消保存定时器，不触发写入（用于压缩等场景，压缩后会重新写入完整数据） */
function cancelPendingSave() {
    if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
    }
    // 清空全部 delta timer 与 dirty 状态
    for (const convId of Object.keys(deltaTimers)) {
        if (deltaTimers[convId]) clearTimeout(deltaTimers[convId])
        deltaTimers[convId] = null
    }
    for (const convId of Object.keys(dirtyMessages)) {
        dirtyMessages[convId].clear()
    }
    isDirty = false
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

/** 切换会话状态核心逻辑：同步 loadedMessages、agent 状态、IPC 通知
 *  （不含 flushMessages，调用方决定是否需要先 flush）
 *  用于 setActiveConversation / deleteConversation / deleteConversations 共享路径 */
async function switchActiveConversation(id: string | null) {
    const store = useConversationStore.getState()
    if (id === store.activeConversationId) return

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
            // ★ 仅在会话仍在流式运行时合并 streaming 消息（实时观看场景）
            //   已完成（idle）的会话以 SQLite 持久化消息为准，避免与流式中间态重复
            if (targetMsgs) {
                const {useAgentStore} = await import('./agentStore')
                const agentState = useAgentStore.getState().convAgentStates[id]?.agentState
                const isRunning = agentState?.status === 'running' || agentState?.status === 'thinking'
                if (isRunning) {
                    const sqliteMsgs = useConversationStore.getState().messagesMap[id]
                    const existingIds = new Set(sqliteMsgs.map(m => m.id))
                    const streamingOnly = targetMsgs.filter(m => !existingIds.has(m.id))
                    if (streamingOnly.length > 0) {
                        const merged = [...sqliteMsgs, ...streamingOnly]
                        useConversationStore.setState({
                            messagesMap: { ...useConversationStore.getState().messagesMap, [id]: merged },
                            loadedMessages: merged,
                        })
                    }
                }
            }
        }
        // 同步该会话的 agent 状态（确保输入框和按钮状态正确）
        const agentStore = useAgentStore.getState()
        agentStore.updateConvData(id, agentStore.convAgentStates[id] ?? DEFAULT_AGENT_STATE)
    } else {
        useConversationStore.setState({ activeConversationId: null, loadedMessages: [] })
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

      createConversation: async () => {
          const id = `conv-${crypto.randomUUID()}`
          const now = Date.now()
          const wsPath = get().currentWorkspacePath || ''
          const meta = {
              id,
              title: '新对话',
              workspacePath: wsPath,
              createdAt: now,
              updatedAt: now,
              preview: '',
              status: 'active' as const
          }

          await window.electronAPI?.conversationCreate?.(id, meta)

          const summary: ConversationSummary = {
              id,
              title: '新对话',
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
          return id
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
              for (const delId of toDelete) delete restMap[delId]
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
              for (const delId of toDelete) delete newMap[delId]
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
          get().flushMessages()
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

      getFilteredConversations: () => {
          const {currentWorkspacePath, workspaces, searchQuery} = get()
          if (!currentWorkspacePath || !workspaces[currentWorkspacePath]) return []
          let filtered = workspaces[currentWorkspacePath].conversations
          filtered = fuzzyFilter(filtered, searchQuery, ['title', 'preview'])
          return [...filtered].sort((a, b) => {
              if (a.pinned && !b.pinned) return -1
              if (!a.pinned && b.pinned) return 1
              return b.updatedAt - a.updatedAt
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
          // 增量落库：用户消息/新 assistant 消息立即持久化（断电保留进度关键路径）
          markMessageDirty(convId, newMessage)
          scheduleDeltaSave(convId, 1000)
      },

      /** 更新指定会话中的消息（仅更新 UI 状态，持久化由主进程处理） */
      updateMessageForConv: (convId: string, id: string, updates: Partial<Message>) => {
          const convMsgs = get().messagesMap[convId] || []
          const idx = convMsgs.findIndex(m => m.id === id)
          if (idx === -1) return
          const newConvMsgs = [...convMsgs]
          newConvMsgs[idx] = {...newConvMsgs[idx], ...updates}
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
              loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
          }))
          // 增量落库：只写这一条变化的消息
          markMessageDirty(convId, newConvMsgs[idx])
          scheduleDeltaSave(convId, 2000)
      },

      addMessage: (message) => {
          const convId = get().activeConversationId
          if (!convId) return
          const newMessage: Message = {...message, id: message.id || crypto.randomUUID(), timestamp: Date.now()}
          const convMsgs = get().messagesMap[convId] || []
          const newConvMsgs = [...convMsgs, newMessage]
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
              loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
          }))
          markMessageDirty(convId, newMessage)
          scheduleDeltaSave(convId, 1000)
      },

      updateMessage: (id, updates) => {
          const convId = get().activeConversationId
          if (!convId) return
          const convMsgs = get().messagesMap[convId] || []
          const idx = convMsgs.findIndex(m => m.id === id)
          if (idx === -1) return
          const newConvMsgs = [...convMsgs]
          newConvMsgs[idx] = {...newConvMsgs[idx], ...updates}
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: newConvMsgs},
              loadedMessages: convId === state.activeConversationId ? newConvMsgs : state.loadedMessages,
          }))
          markMessageDirty(convId, newConvMsgs[idx])
          scheduleDeltaSave(convId, 2000)
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
          // 删除是结构性变更，delta 无法表达，清除该消息的 dirty 标记
          dirtyMessages[convId]?.delete(id)
      },

      loadMessages: async (convId) => {
          // 从磁盘加载消息，存入 messagesMap
          const msgs = await window.electronAPI?.conversationReadMessages?.(convId) || []
          const msgsTyped = msgs as Message[]
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
          const msgs = result.messages as Message[]
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
              const olderMsgs = result.messages as Message[]
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

      saveMessages: async () => {
          const {activeConversationId, loadedMessages} = get()
          // 优先刷 delta（只写变化消息）；未走 delta 路径的（历史兼容）才全量写
          if (activeConversationId && !isChildConversation(activeConversationId)) {
              const dirtyCount = dirtyMessages[activeConversationId]?.size ?? 0
              if (dirtyCount > 0) {
                  await flushDirtyMessages(activeConversationId)
                  isDirty = false
                  return
              }
        await window.electronAPI?.conversationWriteMessages?.(activeConversationId, loadedMessages)
        isDirty = false
          }
      },

      flushMessages: forceFlush,
      cancelPendingSave,
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
        get().saveMessages()
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
              }
              if (!workspaces[wsPath].conversations.find(c => c.id === summary.id)) {
                  workspaces[wsPath].conversations.push(summary)
              }
          }

          for (const ws of Object.values(workspaces)) {
              ws.conversations.sort((a, b) => b.updatedAt - a.updatedAt)
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
        }

        const wsInfo = workspaces[wsPath] || {lastOpenedAt: Date.now(), conversations: []}
        const updatedConvs = [summary, ...wsInfo.conversations]
            .sort((a, b) => b.updatedAt - a.updatedAt)

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
        //                       2) scheduleSave 依赖 messagesMap[activeConversationId] 进行保存
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
}
