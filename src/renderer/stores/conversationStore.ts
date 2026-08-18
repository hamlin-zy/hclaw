import {createWithEqualityFn} from 'zustand/traditional'
import type {ConversationSummary, Message, ContentBlock, BlockDeltaPatch, MessageBlock, ToolCall} from '@shared/types'

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
    handleSessionCreated: (convId: string, title: string, workspacePath: string) => void
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
// 持久化由块级增量唯一负责。

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 每会话的 dirty 块级增量 Map（messageId → 累积 patch），flush 后清空 */
const dirtyBlockDeltas: Record<string, Map<string, BlockDeltaPatch>> = {}

/** Throttle state per conversation for delta save */
interface DeltaThrottleState {
    lastFlush: number
    timer: ReturnType<typeof setTimeout> | null
}
const deltaThrottle: Record<string, DeltaThrottleState> = {}

function getBlockDeltaMap(convId: string): Map<string, BlockDeltaPatch> {
    if (!dirtyBlockDeltas[convId]) dirtyBlockDeltas[convId] = new Map()
    return dirtyBlockDeltas[convId]
}

/** 合并 upsertBlocks：块 id 主键幂等——同 id 后写覆盖（内容/状态更新），异 id 追加，保持首见顺序。
 *  think 段内增长、tool_call 状态更新等场景复用同一 id → 同一次 flush 内只发最新版本。
 *  text 块特殊处理：同 id（同 textSeq）的 content 增量拼接，因为 recordTextBlock 传入的是增量文本。 */
function mergeBlocksById(prev: MessageBlock[] | undefined, next: MessageBlock[]): MessageBlock[] {
    const byId = new Map<string, MessageBlock>()
    for (const b of prev ?? []) byId.set(b.id, b)
    for (const b of next) {
        const existing = byId.get(b.id)
        if (existing && b.blockType === 'text') {
            // text 块增量拼接：同 id text 块（相同 textSeq）的 content 累加
            byId.set(b.id, {...b, content: (existing.content || '') + (b.content || '')})
        } else {
            byId.set(b.id, b)
        }
    }
    return [...byId.values()]
}

/** 追加/合并某消息的块级增量 */
export function accumulateBlockDelta(convId: string, msgId: string, patch: Partial<BlockDeltaPatch>): void {
    if (isChildConversation(convId)) return
    const map = getBlockDeltaMap(convId)
    const cur = map.get(msgId) ?? {upsertBlocks: []}
    map.set(msgId, {
        upsertBlocks: mergeBlocksById(cur.upsertBlocks, patch.upsertBlocks ?? []),
        // 字段级合并而非整体替换：finalize 只传 {endedAt}，必须与已累积的
        // role/timestamp/metadata 合并，否则首写前仅有 finalize 的补丁会丢行级字段
        // （主进程 writeBlockDelta 以 typeof role === 'string' 判行，缺 role 则建行被跳过）。
        messageFields: {...cur.messageFields, ...(patch.messageFields ?? {})},
        finalize: patch.finalize ?? cur.finalize,
    })
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

/** 从消息提取瘦身 messageFields（assistant 只含非块字段；user/system 含 content） */
function extractMessageFields(message: Message): NonNullable<BlockDeltaPatch['messageFields']> {
    const metadata: Record<string, unknown> = {
        agentName: message.agentName,
        agentType: message.agentType,
        model: message.model,
        skillExecution: message.skillExecution,
        attachments: message.attachments,
        plannedCommands: message.plannedCommands,
        commandId: (message as {commandId?: string}).commandId,
        commandArgs: (message as {commandArgs?: string}).commandArgs,
        commandTemplate: message.metadata?.commandTemplate,
    }
    if (message.role !== 'assistant') metadata.content = message.content
    return {role: message.role, timestamp: message.timestamp, endedAt: message.endedAt, metadata}
}

/** 标记一条消息为 dirty（行级字段变更；内容块由 accumulateBlockDelta 记账） */
function markMessageDirty(convId: string, message: Message) {
    if (isChildConversation(convId)) return
    accumulateBlockDelta(convId, message.id, {messageFields: extractMessageFields(message)})
}

/** 按 text 段序号累积 text 块（增量文本，同 textSeq 的块在 mergeBlocksById 中拼接）。
 *  textSeq = streamBlocks.length（非 text 块数即 text 段序号）。
 *  增量文本独立存储，不持有完整 streamBuffer（避免 SlicedString 父引用 O(n²) 内存放大）。 */
export function recordTextBlock(convId: string, msgId: string, incrementalText: string): void {
    if (isChildConversation(convId)) return
    if (!incrementalText) return
    // ★ textSeq：streamBlocks 仅含非 text 块（think/tool_use），其长度即 text 段序号。
    //   无 think/tool 时 seq=0，每插入一个非 text 块后 seq 递增 → 各 text 段独立 id。
    const agentState = useAgentStore.getState().convAgentStates[convId]
    const textSeq = agentState?.streamBlocks?.length ?? 0
    accumulateBlockDelta(convId, msgId, {
        upsertBlocks: [{
            id: `text-${msgId}-${textSeq}`, messageId: msgId, blockType: 'text',
            content: incrementalText, data: null, sequence: 0, timestamp: Date.now(),
            turnIndex: agentState?.currentTurnIndex,
        }],
    })
}

/** think 块（段内增长同 id → 主进程 UPDATE 内容） */
export function recordThinkBlock(convId: string, msgId: string, id: string, content: string, status: 'thinking' | 'complete', startOffset: number): void {
    if (isChildConversation(convId)) return
    const timestamp = Date.now()
    const agentState = useAgentStore.getState().convAgentStates[convId]
    accumulateBlockDelta(convId, msgId, {
        upsertBlocks: [{
            id, messageId: msgId, blockType: 'think',
            content, data: JSON.stringify({id, content, status, timestamp}), sequence: 0, timestamp,
            turnIndex: agentState?.currentTurnIndex,
        }],
    })
}

/** tool_call 块（tool_use 事件到达）。序列化 ToolCall 除 result 外的所有字段，
 *  确保类型新增字段时自动覆盖（无需逐一罗列 14 字段）。 */
export function recordToolCallBlock(convId: string, msgId: string, tc: ToolCall): void {
    if (isChildConversation(convId)) return
    const {result: _result, ...persistable} = tc
    const agentState = useAgentStore.getState().convAgentStates[convId]
    accumulateBlockDelta(convId, msgId, {
        upsertBlocks: [{
            id: `${msgId}-tc-${tc.id}`, messageId: msgId, blockType: 'tool_call',
            content: null, sequence: 0, timestamp: Date.now(),
            data: JSON.stringify(persistable),
            turnIndex: agentState?.currentTurnIndex,
        }],
    })
}

/** tool_result 块（tool_result 到达，含完整 result） */
export function recordToolResultBlock(convId: string, msgId: string, tc: ToolCall): void {
    if (isChildConversation(convId)) return
    if (tc.result === undefined) return
    const timestamp = Date.now()
    const agentState = useAgentStore.getState().convAgentStates[convId]
    accumulateBlockDelta(convId, msgId, {
        upsertBlocks: [{
            id: `${msgId}-tr-${tc.id}`, messageId: msgId, blockType: 'tool_result',
            content: null, sequence: 0, timestamp,
            data: JSON.stringify({id: tc.id, result: tc.result}),
            turnIndex: agentState?.currentTurnIndex,
        }],
    })
}

/** done/error 收尾：finalize patch（主进程补 ended_at + end 块） */
export function finalizeMessageDelta(convId: string, msgId: string, endedAt: number): void {
    if (isChildConversation(convId)) return
    accumulateBlockDelta(convId, msgId, {finalize: true, messageFields: {endedAt}})
}

const THROTTLE_MS = 30000

/** 立即写并重置 throttle 记账（立即写与兜底 timer 两条路径共用） */
function flushAndReset(convId: string, state: DeltaThrottleState): void {
    if (state.timer) {
        clearTimeout(state.timer)
        state.timer = null
    }
    void flushDirtyMessages(convId)
    state.lastFlush = Date.now()
}

/** throttle 调度：距上次写入 ≥30s 立即写，否则挂 30s 兜底 timer */
function scheduleDeltaSave(convId: string): void {
    if (isChildConversation(convId)) return
    let state = deltaThrottle[convId]
    if (!state) {
        state = { lastFlush: 0, timer: null }
        deltaThrottle[convId] = state
    }

    const elapsed = Date.now() - state.lastFlush
    // 首次（lastFlush=0）立即写；此后仅 30s 兜底 timer 触发（段边界由 Task 2 显式 flush）
    if (elapsed >= THROTTLE_MS) {
        flushAndReset(convId, state)
    } else if (!state.timer) {
        state.timer = setTimeout(() => flushAndReset(convId, state), THROTTLE_MS - elapsed)
    }
}

/** 立即把某会话的 dirty 块级增量写入 SQLite */
async function flushDirtyMessages(convId: string): Promise<void> {
    // ★ 子会话不落库（主进程 agentTool 负责持久化）
    if (isChildConversation(convId)) {
        // 清理可能残留的 dirty 标记（修复前标记的旧条目）
        dirtyBlockDeltas[convId]?.clear()
        return
    }
    // 清理 throttle 状态：清掉兜底 timer 但保留 state（throttle 语义依赖 state 跨 flush 存活，
    // 供 scheduleDeltaSave 的 lastFlush 更新生效）
    const throttleState = deltaThrottle[convId]
    if (throttleState?.timer) {
        clearTimeout(throttleState.timer)
        throttleState.timer = null
    }
    const dirtyMap = dirtyBlockDeltas[convId]
    if (!dirtyMap || dirtyMap.size === 0) return

    // ★ 失败重试语义（设计 §8：IPC invoke 失败 → dirty 块保留，30s 兜底 timer 重试）。
    //   先同步快照并清空 map（保持 throttle 语义：flush 期间新累积重新入 map，下次 flush 再写），
    //   逐条 invoke 成功才确认落库；失败条目在循环后按需恢复（与 flush 期间新累积按块 id 合并，
    //   任何一端都不丢）。recordTextBlock 传增量文本，重试重发的就是首次构建好的增量 patch。
    const pending = [...dirtyMap.entries()]
    dirtyMap.clear()
    const succeeded: Array<[string, BlockDeltaPatch]> = []
    try {
        // 逐条块级增量写入（串行 invoke，避免 IPC 并发顺序错乱）
        for (const [msgId, patch] of pending) {
            const ok = await window.electronAPI?.conversationWriteBlockDelta?.(convId, msgId, patch) ?? true
            if (!ok) {
                // 主进程返回 false（SQLite 写失败/事务回滚）：恢复该消息 patch 待兜底重试
                console.warn(`[conversationStore] writeBlockDelta 失败，恢复 dirty 待兜底重试: conv=${convId} msg=${msgId}`)
                restoreDirtyPatch(dirtyMap, msgId, patch)
                continue
            }
            succeeded.push([msgId, patch])
        }
    } catch (err) {
        // 意外异常（IPC 层 reject 等）：未成功条目全部恢复，供 30s 兜底 timer 重试
        console.warn('[conversationStore] flushDirtyMessages 意外异常，恢复 dirty 待兜底重试:', err)
        const succeededIds = new Set(succeeded.map(([id]) => id))
        for (const [msgId, patch] of pending) {
            if (!succeededIds.has(msgId)) restoreDirtyPatch(dirtyMap, msgId, patch)
        }
    }
    // 仍有失败/新累积条目 → 挂 30s 兜底 timer 重试（本函数顶部已清掉旧 timer）
    if (dirtyMap.size > 0) {
        let ts = deltaThrottle[convId]
        if (!ts) { ts = { lastFlush: 0, timer: null }; deltaThrottle[convId] = ts }
        if (!ts.timer) {
            ts.timer = setTimeout(() => flushAndReset(convId, ts), THROTTLE_MS)
        }
    }

    // ★ 内存截断保留（防大工具结果无界增长——上轮修复成果，不可回归）：
    //   tool_result 块 flush 时已带完整 result 落库，此处截断内存副本安全。
    //   patch 无完整 Message → 从 messagesMap 取已落库消息再截断。
    //   仅截断成功落库的消息（失败消息保留内存副本，待重试成功后随截断生效）。
    if (succeeded.length > 0) {
        truncatePersistedMessages(convId, new Set(succeeded.map(([id]) => id)))
    }
}

/** 恢复一次失败 flush 的消息 patch 到 dirty map（与 flush 期间新累积按块 id 合并，新块优先）。
 *  旧 patch 的同 id 块不得覆盖新块，但旧块若无新对应必须保留（增量 patch 内容独立，
 *  丢失即永久内容缺口）。 */
function restoreDirtyPatch(dirtyMap: Map<string, BlockDeltaPatch>, msgId: string, patch: BlockDeltaPatch): void {
    const cur = dirtyMap.get(msgId)
    if (!cur) {
        dirtyMap.set(msgId, patch)
        return
    }
    dirtyMap.set(msgId, {
        upsertBlocks: mergeBlocksById(patch.upsertBlocks ?? [], cur.upsertBlocks ?? []),
        messageFields: {...patch.messageFields, ...cur.messageFields},
        finalize: cur.finalize ?? patch.finalize,
    })
}

/** 按会话立即刷 dirty（段边界 / done / error / injected 收尾路径调用） */
export function flushConversationDirty(convId: string): Promise<void> {
    return flushDirtyMessages(convId)
}

/** 截断本轮已落库消息中大型工具结果的内存副本（完整内容已在 DB）。 */
function truncatePersistedMessages(convId: string, pendingIds: Set<string>): void {
    const store = useConversationStore.getState()
    const msgs = store.messagesMap[convId]
    if (!msgs) return
    let needsUpdate = false
    const newMsgs = msgs.map(m => {
        if (!pendingIds.has(m.id)) return m
        const truncated = truncateLargeResults(m)
        if (truncated !== m) needsUpdate = true
        return truncated
    })
    if (!needsUpdate) return
    useConversationStore.setState({
        messagesMap: { ...store.messagesMap, [convId]: newMsgs },
        loadedMessages: convId === store.activeConversationId ? newMsgs : store.loadedMessages,
    })
}

const TOOL_RESULT_MEMORY_CAP = 5000

/** 截断 message 中大型工具结果的内存副本，完整内容已通过块级增量落库。
 *  幂等短路由 _fullOutputStored 标记承担：已截断过则跳过，避免双重截断提示。 */
function truncateLargeResults(message: Message): Message {
    if (!message.toolCalls || message.toolCalls.length === 0) return message
    let modified = false
    const truncated = message.toolCalls.map(tc => {
        if (!tc.result || typeof tc.result.output !== 'string') return tc
        if (tc.result.output.length <= TOOL_RESULT_MEMORY_CAP) return tc
        const result = tc.result as {output?: string; _fullOutputStored?: boolean}
        if (result._fullOutputStored) return tc
        modified = true
        return {
            ...tc,
            result: {
                ...tc.result,
                _fullOutputStored: true,
                _outputTruncatedLength: tc.result.output.length,
                output: tc.result.output.slice(0, TOOL_RESULT_MEMORY_CAP)
                    + '\n\n*(输出过长，已截断。展开加载完整内容)*',
            },
        }
    })
    return modified ? { ...message, toolCalls: truncated } : message
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

    // 先 flush dirty（await 完成后再 evict：确保脏数据先落库；flush 期间 truncatePersistedMessages
    // 会更新 messagesMap，若先 evict 再异步 flush 会互相覆盖）
    const dirtyMap = dirtyBlockDeltas[convId]
    if (dirtyMap?.size) {
        await flushDirtyMessages(convId)
    }

    // flush 期间 truncatePersistedMessages 会更新 messagesMap（截断大工具结果）——
    // 用 flush 前的旧快照 setState 会把截断回滚并覆盖并发写入，故重读最新状态再 evict
    const currentMsgs = useConversationStore.getState().messagesMap[convId]
    if (!currentMsgs) return
    const evictCount = Math.max(1, Math.floor(currentMsgs.length * 0.3))
    const evicted = currentMsgs.slice(0, evictCount)
    const kept = currentMsgs.slice(evictCount)

    useConversationStore.setState(state => ({
        messagesMap: { ...state.messagesMap, [convId]: kept },
        hasMoreMap: { ...state.hasMoreMap, [convId]: true },
    }))

    // 清理被 evict 消息的 dirty 标记
    if (dirtyMap) {
        for (const evictedMsg of evicted) {
            dirtyMap.delete(evictedMsg.id)
        }
    }
}

function forceFlush() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
    // 刷所有会话的 dirty 消息（全量写兜底已移除）
    const convIds = Object.keys(dirtyBlockDeltas)
    for (const convId of convIds) {
        void flushDirtyMessages(convId)
    }
}

/** 仅取消保存定时器，不触发写入（用于压缩等场景，压缩后会重新写入完整数据） */
function cancelPendingSave() {
    if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
    }
    // 清空全部 delta throttle 与 dirty 状态
    for (const convId of Object.keys(deltaThrottle)) {
        const ts = deltaThrottle[convId]
        if (ts?.timer) clearTimeout(ts.timer)
        delete deltaThrottle[convId]
    }
    for (const convId of Object.keys(dirtyBlockDeltas)) {
        dirtyBlockDeltas[convId].clear()
    }
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
            // ★ 运行中的会话（status 为 running/thinking）：合并渲染进程内存态流式消息。
            //   内存消息为权威（含最新流式内容），SQLite 快照仅用于补缺——纯文本流期间主进程
            //   累积器只在 tool_result / llm_call_done 时机落库，快照可能陈旧，若以 SQLite 为权威
            //   会覆盖内存完整流式内容导致正文被截断。按消息 id 去重，同 id（msg-<ts>-<rand>）
            //   不重复；完成态（idle）不合并，以 SQLite 为准，防重复气泡。
            if (targetMsgs) {
                const agentState = useAgentStore.getState().convAgentStates[id]?.agentState
                const isRunning = agentState?.status === 'running' || agentState?.status === 'thinking'
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

      // 会话移交工具创建新会话时的处理：侧栏顶部插入 + 自动切换（复用 createConversation 的 state 更新逻辑）
      handleSessionCreated: (convId, title, workspacePath) => {
          const now = Date.now()
          const summary: ConversationSummary = {
              id: convId,
              title,
              preview: '',
              createdAt: now,
              updatedAt: now,
              channel: undefined,
          }

          set((state) => {
              if (!workspacePath) return {
                  activeConversationId: convId,
                  loadedMessages: [],
                  messagesMap: {...state.messagesMap, [convId]: []},
              }
              const wsInfo = state.workspaces[workspacePath] || {lastOpenedAt: now, conversations: []}
              // 去重守卫：会话已存在（双投递）则只切换激活，不重复插入侧栏条目
              if (wsInfo.conversations.some(c => c.id === convId)) {
                  return {...state, activeConversationId: convId}
              }
              return {
                  activeConversationId: convId,
                  loadedMessages: [],
                  messagesMap: {...state.messagesMap, [convId]: []},
                  workspaces: {
                      ...state.workspaces,
                      [workspacePath]: {...wsInfo, conversations: [summary, ...wsInfo.conversations]},
                  },
              }
          })
          // 用默认值初始化新会话的 agent 状态，确保待办列表不会残留旧会话数据
          useAgentStore.getState().updateConvData(convId, createDefaultConvData())
          // 交接总结已由主进程写入 SQLite，加载为可见消息（非阻塞）
          get().loadMessagesInitial(convId).catch?.(() => {})
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
          scheduleDeltaSave(convId)
          // 异步检查内存权重上限（不阻塞当前操作）
          setTimeout(() => maybeTrimConversation(convId), 0)
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
          scheduleDeltaSave(convId)
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
          // 复用 updateMessageForConv 的 set + 落库联动，消除重复
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
          // 删除是结构性变更，delta 无法表达，清除该消息的 dirty 标记
          dirtyBlockDeltas[convId]?.delete(id)
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
          const {activeConversationId} = get()
          // 刷 dirty（块级增量已覆盖所有持久化字段，全量写兜底已移除）
          if (activeConversationId && !isChildConversation(activeConversationId)) {
              const dirtyCount = dirtyBlockDeltas[activeConversationId]?.size ?? 0
              if (dirtyCount > 0) {
                  await flushDirtyMessages(activeConversationId)
              }
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
