import {createWithEqualityFn} from 'zustand/traditional'
import type {ConversationSummary, Message, ContentBlock, ToolCall} from '@shared/types'

import {useAgentStore, createDefaultConvData} from './agentStore'
import {useProjectGroupStore} from './projectGroupStore'
import {buildConversationSections, type ConversationSection, SECTION_DEFAULT, SECTION_STEP, CHILD_DEFAULT} from '../lib/conversationSections'
import {getBasename} from '../lib/format'
import {workspacePathKey, UNASSIGNED_WORKSPACE_KEY} from '../lib/workspacePath'
import {collectDescendants} from './conversationTree'
import {flatString} from '../utils/flatString'
import {PROJECT_GROUP_VIEW_CONFIG_KEY} from '@shared/configKeys'

// ★ 内存优化 D2：flatString 已迁至叶子模块（src/renderer/utils/flatString.ts）以消除
//   toolCallsStore → conversationStore → agentStore/* → toolCallsStore 循环依赖。
//   此处 re-export 保持既有导入方（agentStore/index.ts、toolResultBatch.ts 等）不变。
export {flatString}

export interface WorkspaceInfo {
  lastOpenedAt: number
  conversations: ConversationSummary[]
}

interface ConversationStore {
  currentWorkspacePath: string | null
  /** 当前工作目录的 git 分支（非 git 目录为 null，徽章条件渲染） */
  gitBranch: string | null
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

    /** 「我在看谁」：侧栏列表 / 备忘录面板 / 搜索的取数范围（spec §5.1） */
    viewScope: ViewScope | null
    /** 已折叠的项目段 key 集合（组 id 或 project path；D19/⑥：跨重启保留） */
    collapsedGroupIds: string[]
    /** 段 key（项目路径）→ 该段窗口大小（已加载的非置顶根会话上限），缺省 10（spec §7.2） */
    sectionWindowSizes: Record<string, number>
    /** 子会话窗口大小（父会话 id → 可见条数；缺省 CHILD_DEFAULT；不落盘） */
    childWindowSizes: Record<string, number>
    /** §15.1⑤ / §13-2「单项目视图窗口化」的一次性提示已读标记（随 scope 载荷持久化，初值 false） */
    singleViewWindowHintShown: boolean
    /**
     * 【已失效，待清理】Task 12 后 `buildConversationSections` 用 `searching`
     * 取代了旧「展开父会话」语义，该状态不再影响任何渲染/窗口口径；store 保留
     * `expandedChildParents` + `expandChildParents` 仅为最小变更、避免连带删调用点。
     * 原语义：已被用户点「加载更多」整体展开子列表的父会话 id 集合（子会话窗口豁免；会话级，不持久化）。
     */
    expandedChildParents: Record<string, true>
    /** §15.1①「定位该项目段」：待滚动定位的段 key，由消费方渲染后 clearFocusProject 复位 */
    pendingFocusProject: string | null
    /** 段 key（项目路径）→ 该项目 git 分支；由 refreshVisibleBranches 批量只读填充 */
    gitBranches: Record<string, string | null>
    setViewScope: (scope: ViewScope | null) => void
    setProjectGroupView: (groupId: string) => void
    toggleSectionCollapsed: (key: string) => void
    restoreScope: () => Promise<void>
    /** 作用域化取数：**渲染层列表唯一入口**（spec §5.3） */
    getScopedSections: () => ConversationSection[]
    /** 展开段窗口 +10（即时：摘要已在内存，无需等待） */
    expandSection: (key: string) => void
    /** 设定段窗口展示条数（分页控制条专用） */
    setSectionWindowSize: (key: string, count: number) => void
    /** 设定子会话窗口展示条数（子级分页控制条专用；不落盘） */
    setChildWindowSize: (parentId: string, count: number) => void
    /**
     * 【已失效，待清理】Task 12 后 `expandedChildParents` 不再影响 `buildConversationSections`
     * 的窗口/豁免口径，该 action 写入的 state 也不再被任何渲染路径读取；保留仅为
     * 兼容 `ConversationSidebar` 的兜底调用点（同样失效）。后续清理时与上述 state 一并移除。
     * 原语义：批量把父会话子列表标记为「已展开」（子会话窗口豁免；激活会话祖先链兜底用）。
     */
    expandChildParents: (ids: string[]) => void
    /** 置位「单项目视图窗口化」一次性提示的已读标记并落盘（§15.1⑤：此后不再出现） */
    dismissWindowHint: () => void
    /** 请求把某项目段滚入视野（组视图「添加项目」后定位用） */
    focusProjectSegment: (path: string) => void
    clearFocusProject: () => void
    /** 批量只读当前作用域内项目的 git 分支（不新增 fs.watch） */
    refreshVisibleBranches: () => Promise<void>
    /** 跨项目跳转类操作：让视图跟随目标项目（§5.2 跟随矩阵）——**只写 viewScope** */
    followScopeToProject: (path: string) => void
    /** 同步「我在哪干活」（`currentWorkspacePath` = 激活会话所属项目，spec §5.1）到目标项目。
     *  与 `followScopeToProject` 的分工见实现处注释：本函数**不写 viewScope**，故可安全地
     *  放进切换会话链路（计划禁止进切换链路的是会改 viewScope 的 followScopeToProject）。 */
    syncCurrentProject: (path: string) => void

    // Workspace
  setWorkspace: (path: string | null) => void
    /** 登记工作目录并返回「生效键」（未登记则按唯一口径 create），**不切换**当前工作区/视图。
     *  供「把项目加入项目组」这类只需登记、必须停留原视图的调用方使用；登记口径见 registerWorkspace。
     *  返回 null = 登记未能确认，调用方不应继续。 */
  ensureWorkspaceRegistered: (path: string) => Promise<string | null>
  removeWorkspace: (path: string) => void
    /** 跨窗口跳转：切到目标会话所属的工作区并激活该会话（不为未注册路径新建工作区记录，
     *  不抢占该工作区的首个根会话；工作区对比按归一化路径）。
     *  `opts.follow` = 是否让视图跟随目标项目（写 viewScope，可能踢出组视图）。
     *  默认 true（跨窗口入口语义不变）；组视图内的窗口内跳转（最近会话列表）传 false，
     *  只同步「在哪干活」不停留视图之外（与 syncCurrentProject 分工见其实现注释）。 */
  openConversationInWorkspace: (convId: string, workspacePath: string, opts?: {follow?: boolean}) => Promise<void>

    // Conversations
    /** 新建会话。`opts.workspacePath` = 在指定项目创建（段头「+」/ 抽屉「添加项目」）；
     *  `opts.follow` 与 workspacePath 同在契约里，但**本参数不改变视图归属**（由调用方
     *  `newConversation` 负责：stayInScope=false → follow:true → followScopeToProject），
     *  保留以维持入口契约（计划 Task 15 明定、被三个入口与既有测试逐字断言）。
     *  缺省（不传 opts）= 沿用 currentWorkspacePath，行为与改造前一致。 */
  createConversation: (title?: string, opts?: {workspacePath?: string; follow?: boolean}) => Promise<string>
    handleSessionCreated: (convId: string, title: string, workspacePath: string, handoffFromConvId?: string, createdAt?: number, updatedAt?: number) => void
    /** 子会话创建事件处理（agent 工具创建）：插入父会话所属工作区列表顶部，保留其他工作区。
     *  workspacePath 为父会话所属工作区（事件 payload 下发）；该工作区未在本地缓存时新建条目再插入
     *  （与 handleSessionCreated、onConversationCreated schedule 分支同策略），workspacePath 为空串时跳过；
     *  不回退 currentWorkspacePath（避免子会话被错插到当前工作区）。 */
    handleChildConvCreated: (convId: string, title: string, parentConvId: string | undefined, workspacePath: string) => void
  deleteConversation: (id: string) => Promise<void>
    deleteConversations: (ids: string[]) => Promise<void>
    /** 切换活跃会话。force=true 时即使目标已是活跃会话也重走完整切换流程
     *  （用于「切工作区 + 进目标会话」：setWorkspace 会先把该目录首个根会话置为活跃） */
  setActiveConversation: (id: string | null, opts?: { force?: boolean }) => void
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
    /** 向指定会话添加消息（用于非活跃会话的后台 agent 写入）
     *  timestamp 为显式第三参数（省略时取当前时刻）；刻意不从 message 对象读取，见实现处说明 */
    addMessageToConv: (convId: string, message: Omit<Message, 'id' | 'timestamp'> & { id?: string }, timestamp?: number) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
    /** 更新指定会话中的消息（用于非活跃会话的后台 agent 写入） */
    updateMessageForConv: (convId: string, id: string, updates: Partial<Message>) => void
    /** 块级增量：替换指定会话消息 contentBlocks 中指定 id 的块（其他块引用不变） */
    updateMessageBlockForConv: (convId: string, id: string, blockId: string, blockPatch: ContentBlock) => void
  deleteMessage: (id: string) => void
    /** 按会话删除消息（用于非活跃会话的后台 agent 清理，如 abort 后移除空占位气泡） */
    deleteMessageForConv: (convId: string, id: string) => void
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

/** 截断提示后缀（output 与 toolResult 共用） */
const TRUNCATE_SUFFIX = '\n\n*(输出过长，已截断。展开加载完整内容)*'

/** ★ INV-ORDER：消息时间序的**唯一入口**。
 *  `messagesMap[convId]` 恒为「按 timestamp 升序、同值保持既有相对顺序」的稳定序列
 *  （Array.prototype.sort 自 ES2019 起保证稳定，与 DB 侧 (timestamp, rowid) 口径一致）。
 *  所有把数组顺序当时间序用的消费者 —— 气泡渲染顺序、上/下一条用户消息导航、
 *  loadMoreMessages 的前插游标（existing[0].timestamp）—— 都依赖该不变量。
 *  因此任何「取内存数组直接用」的位置必须先过本函数，禁止再写第二处排序语义。 */
function orderMessages(list: Message[]): Message[] {
    return [...list].sort((a, b) => a.timestamp - b.timestamp)
}

/** 截断 message 中大型工具结果的内存副本，完整内容已通过块级增量落库。
 *  幂等短路由 _fullOutputStored 标记承担：已截断过则跳过，避免双重截断提示。
 *  ★ 同时截断 output 与 toolResult 两个字段：normalizeToolResult 会为每个工具结果
 *    生成两份全文（output + formatToolResult 副本），只截 output 会导致 toolResult
 *    中的数 MB 原文永久驻留（堆快照实测 175MB）。
 *  ★★ 缺陷 D2 修复：必须一并改写 contentBlocks 中指向被截断 ToolCall 的块。
 *    blocksToMessage（src/main/repositories/sqlite/messageBlockHelper.ts:288-294）把
 *    同一个 ToolCall 对象同时 push 进 message.toolCalls 与 message.contentBlocks。
 *    此前只重建 toolCalls，contentBlocks[].toolCall.result 仍指向含全文的旧对象 →
 *    截断产生新 tc 后内存一点没省（堆快照持有链走的正是 contentBlocks）。
 *    此处按 ToolCall id 匹配改写，并让两条路径复用同一截断后对象（引用一致、幂等）。 */
export function truncateLargeResults(message: Message): Message {
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
    // ★ D2：记录被截断 ToolCall 的 id → 新对象，供 contentBlocks 按 id 同步改写
    const rewritten = new Map<string, ToolCall>()
    const truncated = message.toolCalls.map(tc => {
        const result = tc.result as {output?: unknown; toolResult?: string; _fullOutputStored?: boolean} | undefined
        if (!result || typeof result.output !== 'string') return tc
        if (result._fullOutputStored) return tc
        const outputTooLong = result.output.length > TOOL_RESULT_MEMORY_CAP
        const toolResultTooLong = typeof result.toolResult === 'string' && result.toolResult.length > TOOL_RESULT_MEMORY_CAP
        if (!outputTooLong && !toolResultTooLong) return tc
        modified = true
        const newTc = {
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
        rewritten.set(tc.id, newTc)
        return newTc
    })
    if (!modified) return message

    // ★ D2：contentBlocks 与 toolCalls 常引用同一 ToolCall 对象。只改 toolCalls 会让
    //   contentBlocks 仍持有含全文的旧对象 → 截断形同虚设。此处按 id 换成截断后对象，
    //   未命中的块保持原引用（React.memo bail out 依赖）。
    let newBlocks = message.contentBlocks
    // modified 为真 ⟺ 至少一个 tc 命中截断并写入 rewritten，故原先的 `rewritten.size > 0` 是恒真条件
    if (message.contentBlocks?.length) {
        let blocksChanged = false
        const mapped = message.contentBlocks.map(block => {
            if (block.type !== 'tool_use' || !block.toolCall) return block
            const newTc = rewritten.get(block.toolCall.id)
            if (!newTc || newTc === block.toolCall) return block
            blocksChanged = true
            return {...block, toolCall: newTc}
        })
        if (blocksChanged) newBlocks = mapped
    }
    // 未命中块改写时不下发 contentBlocks 键（与 {...message, toolCalls} 等价：仍持有原引用）
    return {...message, toolCalls: truncated, ...(newBlocks === message.contentBlocks ? {} : {contentBlocks: newBlocks})}
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
        // ★ 目标会话已不存在（删除/缓存释放/非活跃清理）：终止自续期链。
        //   此前在 `!msgs` 时直接 return 但续期语句在其后无条件执行，会话删除后
        //   这条 30s 链会永久空转并不断续期。
        if (!msgs) {
            activeTruncateConvId = null
            return
        }
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

/** 会话释放路径专用：若当前截断链的目标 convId 正是被释放的会话，
 *  则立即清定时器并置空句柄（否则只能等下一次空转才发现会话已不存在）。 */
function cancelActiveTruncateFor(ids: string[]): void {
    if (!activeTruncateConvId || !ids.includes(activeTruncateConvId)) return
    clearActiveTruncate()
}

/** `loadMessagesInitial` 的 in-flight 去重表（convId → 在途 Promise）。
 *  三条路径会对同一 convId 并发发起首屏水合：`switchActiveConversation`（用户切会话）、
 *  `preloadConversation`（侧栏 hover）、`loadConversations` 的批量预热（并发 5）。
 *  无去重时底层 `conversationReadTail` 会被重复发起（同一批 SQLite 查询叠加，且后到的
 *  响应会覆盖先到的）。共享同一 Promise 后三者天然复用同一次读取。
 *  settle 后立即清理——它只是「在途」标记，不是消息缓存（缓存由 messagesMap 承担）。 */
const initialLoadInFlight = new Map<string, Promise<void>>()

/** `loadConversations` 的并发锁（in-flight 去重）。三个调用点会在同一 tick 内并发触发，
 *  无锁时会重复发起 conversationList 与整批预热。settle 后释放。
 *  与 initialLoadInFlight 共用同一张「单槽锁」表（key 为下方哨兵值）。 */
const LOAD_CONVERSATIONS_LOCK = '__loadConversations__'
const loadConversationsInFlight = new Map<string, Promise<void>>()

/**
 * in-flight 去重：同一 key 的并发调用复用同一 Promise，settle 后自动清标记。
 *
 * 两个刻意为之的细节（勿改成 `async` 包装或提前删标记）：
 *  1. 返回的不是 `async` 函数的返回值——`async` 会把结果再包一层新 Promise，
 *     使并发调用拿到不同引用（去重语义仍在，但调用方无法按引用判断「同一请求」）。
 *  2. 登记的是 `guarded`（`.finally` 之后才 resolve），故不存在
 *     「已 settle 但标记仍在」的窗口。
 */
function dedupeInFlight<T>(inFlight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key)
    if (existing) return existing
    const guarded = run().finally(() => { inFlight.delete(key) })
    inFlight.set(key, guarded)
    return guarded
}

// ─── 单会话内存权重上限（兜底）──────────────────────────
// 长会话/重工具输出会话在非活跃时可能无界增长，本函数作为兜底：
// 权重超限的非活跃会话先截断大工具结果（幂等），再 evict 最旧的 30% 消息。

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

// ─── messagesMap 数量约束 + LRU 淘汰（缺陷 D1；Task 17 改为按项目预算）──────
// 现象：loadConversations 的预热循环对当前工作区全部会话调 loadMessagesInitial，
// 把整库消息（含工具结果）灌进 messagesMap。此前只有单会话权重（CONVERSATION_WEIGHT_CAP）
// 与 10 分钟不活跃清理兜底，二者对"预热进来但从未被渲染"的会话均失效
// → 渲染进程 JS 堆实测 1154.7MB、messagesMap 持有 1976 个 conv-* 键。
//
// 新策略（spec §10.2：全局单阈值 → 按项目预算，驻留量不随项目数线性增长）：
//  · 预热：只预热当前工作区最近更新的 PRELOAD_MAX_CONVERSATIONS 个会话，且不超过
//    该项目的常驻预算（loadConversations）。
//  · 驻留：**每项目** messagesMap 键数上限 MAX_RESIDENT_PER_PROJECT，超出即按项目内
//    「最后激活时间」LRU 淘汰；全局另有 GLOBAL_MESSAGES_MAP_HARD_CAP 安全阀，
//    超出时淘汰「最冷项目的最冷会话」。触发点为会话切换 / 首屏水合（loadMessagesInitial）。
//  · 缓存池：renderedConversationIds 按项目 ≤ MAX_RENDERED_PER_PROJECT（3 热 + 2 温），
//    由唯一登记点 markConversationRendered 末尾的守卫执行；它同时是
//    cleanupInactiveConversations（10 分钟不活跃清理）的输入集。
//  · 项目归属不明（workspaces 反查不到）的会话不参与项目计数，只受全局安全阀约束。
// 保护集（§10.2-2）= 激活会话 + running/thinking + 三种待交互态（pendingPermissionConfirm /
//  pendingQuestion / pendingToolsChangeConfirm），**优先于预算**：不得为凑数驱逐流式 /
//  待交互会话，故某项目 / 全局均可临时超限。
// 淘汰只针对非活跃会话，且完整内容在 DB，切回会话时 loadMessagesInitial 重新水合 → 不损体验。

/** 启动预热的最大会话数（按 updatedAt 降序取最近更新者；实际取它与每项目常驻预算的较小者） */
const PRELOAD_MAX_CONVERSATIONS = 10

/** 每项目常驻会话上限（messagesMap 键数，超限按项目内「最后激活时间」LRU 淘汰） */
const MAX_RESIDENT_PER_PROJECT = 3

/** 每项目缓存池上限（renderedConversationIds，含常驻 = 3 热 + 2 温） */
const MAX_RENDERED_PER_PROJECT = 5

/** 全局安全阀（≈10 项目 × 3；超限淘汰「最冷项目的最冷会话」，§10.2-4） */
const GLOBAL_MESSAGES_MAP_HARD_CAP = 30

/** 会话是否处于「不可驱逐」状态：正在流式（running/thinking）——驱逐会打断正在进行的会话。
 *  注意口径**小于** cleanupInactiveConversations 的保护集（后者另含 pendingPermissionConfirm /
 *  pendingQuestion / pendingToolsChangeConfirm 三种待交互态），勿据此推断清理逻辑。 */
function isProtectedConv(convId: string): boolean {
    const st = useAgentStore.getState().convAgentStates[convId]?.agentState?.status
    return st === 'running' || st === 'thinking'
}

/** 会话 → 项目路径（读 workspaces 反查；找不到返回 null）。
 *  ★ 单次查询用；批量场景（比较器 / 全量分组）必须改用 buildConvProjectIndex——
 *    本函数是 O(会话总数)，在比较器里反复调用会退化成 O(n²)。 */
function projectPathOfConv(convId: string): string | null {
    return findConvHome(useConversationStore.getState().workspaces, convId)
}

/** 会话在哪个项目（跨项目反查，与 projectPathOfConv 同口径但显式收 workspaces 入参：
 *  便于在 set((state) => …) 里按「同一份 state」定位，避免读到更新中途的 store）。
 *  会话操作必须按**会话自身所属项目**读写（I-1(b)）：组视图下操作对象可能不属于
 *  currentWorkspacePath，「按当前项目」会改错列表 / 展开错后代 / 界面不变。 */
function findConvHome(workspaces: Record<string, WorkspaceInfo>, convId: string): string | null {
    return findConvAcrossWorkspaces(workspaces, convId)?.workspacePath ?? null
}

/** 跨工作区按 convId 取会话摘要 + 所属目录（未加载的项目段查不到 → null）。
 *  供渲染端「完成未读」判定读取 parentConvId / channel 两个口子；口径与侧栏
 *  「最近会话」区块的定位一致（同一份 workspaces 真相，避免第二真相）。 */
export function findConvAcrossWorkspaces(
    workspaces: Record<string, WorkspaceInfo>,
    convId: string,
): {conv: ConversationSummary; workspacePath: string} | null {
    for (const [workspacePath, ws] of Object.entries(workspaces)) {
        const conv = ws.conversations.find(c => c.id === convId)
        if (conv) return {conv, workspacePath}
    }
    return null
}

/** 在 workspaces 里按**归一化键**反查实际键（I-1 加固：`p in workspaces` 裸比较在
 *  大小写 / 尾分隔符不同的等价串下会误判为「不存在」，从而漏段或错误回退）。
 *  返回实际键（而非入参原串）——调用方要用它去 `workspaces[key]` 取会话列表。 */
function findWorkspaceKey(workspaces: Record<string, WorkspaceInfo>, path: string): string | null {
    if (path in workspaces) return path
    const target = workspacePathKey(path)
    return Object.keys(workspaces).find(k => workspacePathKey(k) === target) ?? null
}

/** 一次性建立「会话 → 项目路径」反查表（O(会话总数)，供一次 enforce 调用内的所有查询复用） */
function buildConvProjectIndex(): Map<string, string> {
    const index = new Map<string, string>()
    const {workspaces} = useConversationStore.getState()
    for (const [path, info] of Object.entries(workspaces)) {
        for (const c of info.conversations) {
            if (!index.has(c.id)) index.set(c.id, path)
        }
    }
    return index
}

/** 预算淘汰的不可驱逐集（§10.2-2）：激活会话 + running/thinking + 三种待交互态。
 *  口径**大于** isProtectedConv（后者只含流式两态，供截断兜底复用），勿互相推断。 */
function isProtectedForBudget(convId: string): boolean {
    const state = useConversationStore.getState()
    if (convId === state.activeConversationId) return true
    if (isProtectedConv(convId)) return true
    const conv = useAgentStore.getState().convAgentStates[convId]
    return !!(conv?.pendingPermissionConfirm || conv?.pendingQuestion || conv?.pendingToolsChangeConfirm)
}

/** 驱逐若干会话的全部渲染端缓存：releaseConvCaches 负责 messagesMap / hasMoreMap /
 *  loadingMoreMap / conversationLastActiveAt / handoffDismissed 五张会话级表、agentStore
 *  运行时数据，并终止指向它们的 30s 截断自续期链。
 *  此处再补 renderedConversationIds（LRU 已渲染表）的移除——否则被驱逐 id 仍留在
 *  cleanupInactiveConversations 的输入集中，其后续过滤会为悬空 id 空转。 */
function evictConversations(ids: string[]): void {
    if (!ids.length) return
    releaseConvCaches(ids)
    const removed = new Set(ids)
    useConversationStore.setState(state => ({
        renderedConversationIds: state.renderedConversationIds.filter(id => !removed.has(id)),
    }))
}

/** 数量上限执行（两段式）：① 每项目 messagesMap 键数 ≤ MAX_RESIDENT_PER_PROJECT；
 *  ② 全局键数 ≤ GLOBAL_MESSAGES_MAP_HARD_CAP，超限淘汰「最冷项目的最冷会话」。
 *  两段都只从「可驱逐者」（按最后激活时间升序）里取，保护集（isProtectedForBudget）
 *  一个都不动 → 某项目 / 全局可因保护集而临时超限（§10.2-2，属预期）。
 *  项目冷热 = 该项目内会话的最大 lastActive；无项目归属者各自成组。
 *  被驱逐会话可从 DB 重新水合（loadMessagesInitial）。 */
function enforceMessagesMapSizeLimit(): void {
    const state = useConversationStore.getState()
    const ids = Object.keys(state.messagesMap)
    // 快路径：总量不超两常量之较小者时，项目分组与全局安全阀都不可能触发。
    // 判据取 min(每项目预算, 全局安全阀) 而非只取每项目预算，故本判据不依赖
    // MAX_RESIDENT_PER_PROJECT ≤ GLOBAL_MESSAGES_MAP_HARD_CAP 这一不变式
    //（该不变式无任何守卫，常量漂移会静默短路全局安全阀，令 spec §10.2-4 失效）。
    if (ids.length <= Math.min(MAX_RESIDENT_PER_PROJECT, GLOBAL_MESSAGES_MAP_HARD_CAP)) return

    const lastActiveOf = (id: string) => state.conversationLastActiveAt[id] ?? 0
    const projectIndexOf = buildConvProjectIndex()
    const projectOf = (id: string) => projectIndexOf.get(id) ?? null

    const ordered = ids
        .filter(id => !isProtectedForBudget(id))
        .sort((a, b) => lastActiveOf(a) - lastActiveOf(b))

    const toEvict: string[] = []
    // ① 项目内裁剪：项目「键数」含保护集，故裁剪量 = 该项目键数 - 预算，只从可驱逐者里取
    const projectCount = new Map<string, number>()
    for (const id of ids) {
        const p = projectOf(id)
        if (p) projectCount.set(p, (projectCount.get(p) ?? 0) + 1)
    }
    const removableByProject = new Map<string, string[]>()
    for (const id of ordered) {
        const p = projectOf(id)
        if (!p) continue
        const list = removableByProject.get(p)
        if (list) list.push(id)
        else removableByProject.set(p, [id])
    }
    for (const [p, removable] of removableByProject) {
        const over = (projectCount.get(p) ?? removable.length) - MAX_RESIDENT_PER_PROJECT
        if (over > 0) toEvict.push(...removable.slice(0, over))
    }
    // ② 全局安全阀：先按项目聚合热度，再淘汰最冷项目里的最冷会话
    const keptCount = ids.length - toEvict.length
    if (keptCount > GLOBAL_MESSAGES_MAP_HARD_CAP) {
        const evicted = new Set(toEvict)
        const remaining = ordered.filter(id => !evicted.has(id))
        const projectHeat = new Map<string, number>()
        for (const id of remaining) {
            const p = projectOf(id) ?? `\0${id}`
            projectHeat.set(p, Math.max(projectHeat.get(p) ?? 0, lastActiveOf(id)))
        }
        remaining.sort((a, b) => {
            const byHeat = (projectHeat.get(projectOf(a) ?? `\0${a}`) ?? 0)
                - (projectHeat.get(projectOf(b) ?? `\0${b}`) ?? 0)
            return byHeat !== 0 ? byHeat : lastActiveOf(a) - lastActiveOf(b)
        })
        toEvict.push(...remaining.slice(0, keptCount - GLOBAL_MESSAGES_MAP_HARD_CAP))
    }

    if (toEvict.length) evictConversations(toEvict)
}

/** 每项目缓存池上限执行（renderedConversationIds ≤ MAX_RENDERED_PER_PROJECT）。
 *  调用点唯一：markConversationRendered 末尾——会话切换 / hover 预热 / 批量预热三条
 *  登记路径都经它收口（此前 renderedConversationIds 只是 cleanupInactiveConversations
 *  的输入集，不构成任何上限）。项目归属不明时不设限（无法按项目计数）。
 *  同样只淘汰非保护集，且按「最后激活时间」升序取最冷者。 */
function enforceRenderedPoolLimit(project: string | null): void {
    if (!project) return
    const state = useConversationStore.getState()
    const projectIndexOf = buildConvProjectIndex()
    const inProject = state.renderedConversationIds.filter(id => projectIndexOf.get(id) === project)
    if (inProject.length <= MAX_RENDERED_PER_PROJECT) return

    const evict = inProject
        .filter(id => !isProtectedForBudget(id))
        .sort((a, b) => (state.conversationLastActiveAt[a] ?? 0) - (state.conversationLastActiveAt[b] ?? 0))
        .slice(0, inProject.length - MAX_RENDERED_PER_PROJECT)
    if (evict.length) evictConversations(evict)
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
 *
 * 安全模式：子会话（parentConvId 非空）不写自己的 permissionMode（主进程 IPC 亦硬拒绝），
 * 其显示值由 ConvModeSegs 固定呈现为「自动」——子代理一律以 auto 运行，实际治理由
 * 该 Agent 的 tools/disallowedTools 承担。此处无显式值即回退全局默认，与主会话同路径。
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
 *  用于 setActiveConversation / deleteConversation / deleteConversations 共享路径
 *  force：跳过「已是活跃会话」短路，强制重走完整切换。调用方为「切工作区 + 进目标会话」时
 *  必须传（setWorkspace 会把该目录首个根会话置为活跃，目标是它时短路会跳过消息合并与
 *  agent 状态同步，见 setActiveConversation 调用点传 force 的说明）。 */
async function switchActiveConversation(id: string | null, opts?: {force?: boolean}) {
    const store = useConversationStore.getState()
    if (!opts?.force && id === store.activeConversationId) return

    // ★ 用户看到即消：激活会话即清「已完成未读」标记（放置在此处 = setActiveConversation 与
    //   删除后回退激活两条路径共用同一落点）。render 侧 ConversationItem 另有同 action 兜底，
    //   覆盖不走本函数的直接 setState 激活站点。
    if (id) useAgentStore.getState().clearConvDoneUnread(id)

    // 切换前先清理旧活跃会话的定时截断
    clearActiveTruncate()

    if (id) {
        store.markConversationRendered(id)
        // ★ I-1(a)：激活会话决定「我在哪干活」（spec §5.1：currentWorkspacePath = 激活会话所属项目）。
        //   组视图内点其他成员项目的会话行只经过本函数，不同步 → currentWorkspacePath 停在旧项目，
        //   于是右键删除按旧项目展开后代、重命名/置顶只改旧项目的列表、头部项目名与分支显示旧项目。
        //   ★ 不违反「禁止把 followScopeToProject 塞进切换链路」：本函数只同步 currentWorkspacePath，
        //   **不写 viewScope**（组内换会话 ≠ 离开组视图），改 viewScope 的那条路径仍是调用方职责。
        //   父/子会话都算：projectPathOfConv 按会话自身所属项目跨项目反查。
        const homeProject = projectPathOfConv(id)
        if (homeProject) useConversationStore.getState().syncCurrentProject(homeProject)
        const targetMsgs = store.messagesMap[id]
        // ★ 如果 messagesMap 已有消息但缺少用户消息（流式子会话场景），
        //   先从 SQLite 加载持久化消息，再合并流式消息，确保用户消息不丢失
        if (targetMsgs && targetMsgs.some(m => m.role === 'user')) {
            // ★ INV-ORDER：本分支此前直接采信内存数组顺序，是**唯一跳过排序的出口**
            //   （判定条件是「内存已有 user 角色」，注入消息 catalog/env/memory/language-guard
            //   也是 user 角色 → 命中率被放大）。内存里若 assistant 先落、user 后落，
            //   气泡顺序就永久颠倒，且切走切回不复原，只有整段重载（重开）才自愈。
            //   此处过 orderMessages，并**写回会话级键 messagesMap[id]** ——
            //   只写全局镜像 loadedMessages 不生效（会话级数组仍是乱序的第二真相）。
            const ordered = orderMessages(targetMsgs)
            useConversationStore.setState(state => ({
                activeConversationId: id,
                messagesMap: {...state.messagesMap, [id]: ordered},
                loadedMessages: ordered,
            }))
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
                    && !!(agentConvData?.pendingQuestion || agentConvData?.pendingPermissionConfirm
                        || agentConvData?.pendingToolsChangeConfirm)
                const isRunning = agentStatus === 'running' || agentStatus === 'thinking' || isBlockedPending
                if (isRunning) {
                    const {messagesMap} = useConversationStore.getState()
                    const sqliteMsgs = messagesMap[id] || []
                    const targetIds = new Set(targetMsgs.map(m => m.id))
                    const merged = orderMessages([...sqliteMsgs.filter(m => !targetIds.has(m.id)), ...targetMsgs])
                    // messagesMap 按 convId 键写（不污染其他会话）；
                    // loadedMessages 是全局镜像 → 必须按当前 active 条件写（见下方竞态说明）
                    useConversationStore.setState(state => ({
                        messagesMap: {...messagesMap, [id]: merged},
                        loadedMessages: state.activeConversationId === id ? merged : state.loadedMessages,
                    }))
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
        // ★ 竞态防护（active 校验）：上面的 `await store.loadMessagesInitial(id)` 之后，
        //   activeConversationId 可能已被后续切换改写。以下三处写的是「全局」状态，不是
        //   按 convId 键写的会话级数据，迟到响应会把新活跃会话的全局状态顶掉：
        //     · applyConvModesToAgentStore(id) → agentStore 顶层 permissionMode/messageDisplayMode
        //     · refreshActiveBatch?.(id)      → 全局待办批次
        //     · scheduleActiveTruncate(id)    → 全局唯一的 30s 截断定时器（会清掉新会话的）
        //   触发场景：A→B→A 快速切换时 B 的迟到响应。每项目 3 常驻预算的 LRU 淘汰
        //   提高了异步分支（驱逐 + 重新水合）的触发频率，使该竞态更易暴露。
        //   仍按 convId 键写的（updateConvData / reconcileStreamingContent / messagesMap[id]）
        //   不在此列——它们不会污染其他会话，保留执行。
        if (useConversationStore.getState().activeConversationId !== id) return
        // 会话级模式初始化（meta → 全局默认回退）
        void applyConvModesToAgentStore(id)
        // ★ 主动水合待办批次：切换会话时从 DB 查询活跃批次，
        //   不依赖 TodoStrip 的被动 useEffect（条件不满足时水合会漏触发，
        //   导致"重启后进行中的待办列表不显示"）
        void agentStore.refreshActiveBatch?.(id)
    } else {
        useConversationStore.setState({ activeConversationId: null, loadedMessages: [] })
    }
    // 为新活跃会话启动定时截断（active 校验同上方：迟到响应不得抢占定时器）
    if (id && useConversationStore.getState().activeConversationId === id) {
        scheduleActiveTruncate(id)
        // ★ D1：切换后该会话刚被标为最新活跃，立即执行数量上限淘汰
        enforceMessagesMapSizeLimit()
    }
}

// ── Git 分支感知 ────────────────────────────────────────

/** 拉取指定目录的 git 分支并写入 store（带竞态守卫：仅当仍是当前工作区时生效） */
async function refreshGitBranch(wsPath: string | null): Promise<void> {
    if (!wsPath) {
        useConversationStore.setState({gitBranch: null})
        return
    }
    try {
        const branch = await window.electronAPI?.workspace?.getGitBranch(wsPath) ?? null
        // 等待期间可能已切换工作区，避免旧目录的分支覆盖新目录
        if (useConversationStore.getState().currentWorkspacePath === wsPath) {
            useConversationStore.setState({gitBranch: branch})
        }
    } catch { /* 非 git 目录 / IPC 失败 → 保持 null，徽章不渲染 */ }
}

/** 订阅主进程 git 分支变化广播（外部命令行切分支）。应用启动时调用一次 */
export function subscribeGitBranchChanges(): () => void {
    const unsub = window.electronAPI?.workspace?.onGitBranchChanged?.((branch) => {
        useConversationStore.setState({gitBranch: branch})
        // ★ 段头徽章同步：gitBranches[path] 的旧缓存会挡住 getScopedSections 里的 ??
        //   回退（仅当前项目才回退到 gitBranch），不刷则徽章停留旧值。
        //   先显式覆盖当前工作区键（无 getGitBranches IPC 时也生效），
        //   再触发 refreshVisibleBranches 兜底批量刷新（失败静默，不影响交互）。
        const wsPath = useConversationStore.getState().currentWorkspacePath
        if (wsPath) {
            const {gitBranches} = useConversationStore.getState()
            if (wsPath in gitBranches) {
                useConversationStore.setState({gitBranches: {...gitBranches, [wsPath]: branch}})
            }
        }
        void useConversationStore.getState().refreshVisibleBranches()
    })
    return () => unsub?.()
}

// ── 工作区路径归一化（比较/去重，绝不可回传主进程）──────────

/** 注册表工作区记录（与 env.d.ts 的 workspace.list() 元素同形） */
type WorkspaceRecord = { id: string; path: string; name: string; createdAt: number; updatedAt: number }

/**
 * getByPath 精确未命中时的等价项扫描。
 *
 * 为什么需要：目录选择对话框返回的串不带尾分隔符，而 DB（workspaces 表）里可能存着
 * 带尾分隔符的历史串（E:\workspace\ 之类），getByPath 是 `WHERE path = ?` 精确匹配 → 必然查不到。
 * 若此时直接 create，同一目录就会写进第二条 DB 记录；渲染层也会多出一个键。
 *
 * · 恰好一条 → 用它（不 create）。
 * · 多条 → 取 updatedAt 最新的一条并 warn（等价记录多条属历史 bug 遗留的数据异常，
 *   静默挑一个会让问题不可观测）。
 * · 零条 → 返回 null，由调用方决定是否 create。
 */
async function findEquivalentWorkspace(path: string): Promise<WorkspaceRecord | null> {
    const all = await window.electronAPI?.workspace?.list?.()
    if (!all) return null
    const target = workspacePathKey(path)
    const matches = (all as WorkspaceRecord[]).filter(w => workspacePathKey(w.path) === target)
    if (matches.length === 0) return null
    if (matches.length === 1) return matches[0]
    console.warn(
        `[workspace] 发现 ${matches.length} 条归一化等价的工作区记录（${path}），已取 updatedAt 最新的一条`,
        matches.map(m => m.path),
    )
    return [...matches].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

/**
 * 解析「生效键」：决定写入 currentWorkspacePath / workspaces 用哪个串。
 * setWorkspace / removeWorkspace / openConversationInWorkspace 三处共用，保证口径一致。
 *
 * 为什么需要：同一目录可能以多种写法出现（尾分隔符、分隔符方向、Windows 大小写），
 * 用原始串写键会与已有等价键并存 → 侧栏同一项目两条记录、当前那条指向空列表。
 *
 * 解析顺序（固定）：
 *  ① workspaces 里已有等价键 → 复用（优先取 conversations 非空的那个，保住已加载列表；都空取第一个）；
 *  ② 注册表返回 / 扫描到的规范路径（DB 原串，与 getByPath 的精确串对齐）；
 *  ③ 兜底原始 path（未登记路径）。
 *
 * ⚠ 归一化串仅用于比较，绝不作为键写回主进程。
 */
function resolveWorkspaceKey(path: string, canonicalPath?: string | null): string {
    const target = workspacePathKey(path)
    const workspaces = useConversationStore.getState().workspaces
    const equivalentKeys = Object.keys(workspaces).filter(k => workspacePathKey(k) === target)
    if (equivalentKeys.length > 0) {
        return equivalentKeys.find(k => (workspaces[k]?.conversations.length ?? 0) > 0) ?? equivalentKeys[0]
    }
    return canonicalPath ?? path
}

/**
 * 工作区登记（全仓库唯一口径）：精确命中 → 等价扫描 → create → 回读。
 *
 * 为什么必须唯一：`ensureWorkspaceRegistered` 与 `setWorkspace` 都要走这段序列，任何一处
 * 再抄一遍，就会重新引入「同一目录被重复 create 成第二条记录」的缺陷（见 findEquivalentWorkspace 注释）。
 * 两者都只调本函数 —— 只是需要的产物不同：前者要「生效键」，后者还要记录本身（setCurrent 要 id）。
 *
 * 返回 null = 登记未能确认（getByPath 回读为空）；调用方据此决定是否继续。
 */
async function registerWorkspace(path: string): Promise<WorkspaceRecord | null> {
    // 必须传原始串：主进程 getByPath 是 `WHERE path = ?` 精确匹配，传归一化串查不到（既有契约，已有测试钉住）。
    let workspace = (await window.electronAPI?.workspace?.getByPath(path)) ?? null
    if (!workspace) {
        // 精确未命中 → 先做等价扫描，避免同一目录（DB 里带着另一种写法的旧串）被重复 create 出第二条记录。
        const equivalent = await findEquivalentWorkspace(path)
        if (equivalent) {
            workspace = equivalent
        } else {
            const id = `ws-${crypto.randomUUID()}`
            const name = path.split(/[/\\]/).pop() || '新项目'
            // create 仍写原始串（主进程精确匹配口径）
            await window.electronAPI?.workspace?.create(id, path, name)
            workspace = (await window.electronAPI?.workspace?.getByPath(path)) ?? null
        }
    }
    return workspace
}

/**
 * 视图作用域（spec §5.1）：只存 id，不缓存组对象快照
 */
export type ViewScope =
    | {type: 'project'; path: string}
    | {type: 'group'; groupId: string}

const VIEW_SCOPE_KEY = PROJECT_GROUP_VIEW_CONFIG_KEY

interface PersistedScope {
    viewScope: ViewScope | null
    collapsedGroupIds: string[]
    singleViewWindowHintShown?: boolean
}

/** viewScope 形状守卫（持久化载荷来自 system_settings，可能被手工篡改 / 版本漂移） */
function isPersistedViewScope(v: unknown): v is ViewScope {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    if (o.type === 'project') return typeof o.path === 'string'
    if (o.type === 'group') return typeof o.groupId === 'string'
    return false
}

/**
 * 持久化载荷形状校验：非法字段一律当作「无持久化」/缺省。
 *
 * 为什么必须做：App init 的整段初始化包在「全有全无」的 try 里（App.tsx:346），
 * restoreScope 一旦抛错（例：篡改成 `{viewScope: {type: 'project'}}` 缺 path，
 * resolveScopeFallback 里 `workspacePathKey(undefined)` 会 TypeError），后续
 * 快捷键绑定 / 主题 / 汇率同步等初始化会被一并静默跳过 —— 失败面远大于「视图没恢复」。
 */
export function parsePersistedScope(raw: unknown): PersistedScope | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    return {
        viewScope: isPersistedViewScope(o.viewScope) ? o.viewScope : null,
        collapsedGroupIds: Array.isArray(o.collapsedGroupIds)
            ? o.collapsedGroupIds.filter((k): k is string => typeof k === 'string')
            : [],
        singleViewWindowHintShown: o.singleViewWindowHintShown === true,
    }
}

/**
 * 重启恢复的回退链（spec §5.2）：
 *   存的是组 → 组还在？用；组已删 → 激活会话所属项目 → currentWorkspacePath → null
 *   存的是项目 → 该项目还在（与 currentWorkspacePath 等价）？用；否则 → currentWorkspacePath → null
 * 纯函数，便于单测（不读 store，全部入参传入）。
 */
export function resolveScopeFallback(input: {
    stored: ViewScope | null
    groups: Array<{id: string; members: Array<{projectPath: string}>}>
    currentWorkspacePath: string | null
    activeConvWorkspacePath: string | null
}): ViewScope | null {
    const {stored, groups, currentWorkspacePath, activeConvWorkspacePath} = input
    const project = (path: string | null): ViewScope | null =>
        path ? {type: 'project', path} : null

    if (stored?.type === 'project') {
        if (currentWorkspacePath && workspacePathKey(stored.path) === workspacePathKey(currentWorkspacePath)) {
            return stored
        }
        return project(currentWorkspacePath)
    }
    if (stored?.type === 'group') {
        if (groups.some(g => g.id === stored.groupId)) return stored
        return project(activeConvWorkspacePath) ?? project(currentWorkspacePath)
    }
    return project(activeConvWorkspacePath) ?? project(currentWorkspacePath)
}

/**
 * 当前作用域包含哪些项目路径（顺序即渲染顺序，spec §5.3）。
 *
 * 组视图 = 组内成员按 group_order（members 数组序）——但**只保留本端可见（已加载）的项目**：
 * 组里的项目可能在别的窗口才登记，不可见时渲染空段只会误导。组不存在（被解散）或
 * 成员全不可见 → 回退 currentWorkspacePath 单段（§5.2 回退链的运行期版本）。
 * 项目视图 = viewScope.path 单段（**优先认 scope**，见下方 R-AU 注释）；该键不可见 / 无 scope
 * → 落到 currentWorkspacePath 单段。
 *
 * 纯函数（组对象由 projectGroupStore 现取，不在本 store 缓存快照），便于单测。
 */
export function resolveScopeProjectPaths(state: {
    viewScope: ViewScope | null
    workspaces: Record<string, WorkspaceInfo>
    currentWorkspacePath: string | null
}): string[] {
    const {viewScope, workspaces, currentWorkspacePath} = state
    if (viewScope?.type === 'project') {
        // ★ 项目档必须认 scope（spec §5.1：viewScope 就是「我在看谁」）——否则会出现
        //   「viewScope.path=B 而 currentWorkspacePath=A」的漂移：组视图内点其他成员项目的
        //   会话行只调 setActiveConversation（组内换会话 ≠ 离开组视图），currentWorkspacePath
        //   仍是 A；此后 handoff 跟随到 B 只写 viewScope → 取数却按 A 走，跟随沦为 no-op。
        //   键比较走 workspacePathKey 归一（尾分隔符 / 大小写不同的等价串不得误判为不可见）。
        const key = findWorkspaceKey(workspaces, viewScope.path)
        if (key) return [key]
        // 目标项目不可见 → 回退 currentWorkspacePath（与组档的回退对称，§5.2）
    }
    if (viewScope?.type === 'group') {
        const group = useProjectGroupStore.getState().groups.find(g => g.id === viewScope.groupId)
        // R-28（用户指示改 spec 口径）：组视图显示全部组成员段——已加载的用归一化 key（段有会话），
        //   未加载的用原 path（workspaces[原path] 不存在 → conversations=[] → 显示「暂无会话」占位，
        //   点击进项目视图时 registerWorkspace 水合）。不再过滤未加载成员（避免 assign/reorder 后段少显示）。
        const paths = (group?.members ?? [])
            .map(m => findWorkspaceKey(workspaces, m.projectPath) ?? m.projectPath)
        if (paths.length > 0) return paths
        // 组已解散 / 无成员 → 回退（§5.2）
    }
    return currentWorkspacePath ? [currentWorkspacePath] : []
}

/** 落盘（异步、失败静默：持久化失败不得影响交互）。
 *  ★ 唯一构造点：入参是整个 state 切片，调用方一律传 get()——后续给持久化载荷加字段
 *    （如 Task 14 的 singleViewWindowHintShown）时不必逐个手写字面量，避免漏改某一处。 */
function persistScope(state: Pick<ConversationStore, 'viewScope' | 'collapsedGroupIds' | 'singleViewWindowHintShown'>): void {
    void window.electronAPI?.configWrite?.(VIEW_SCOPE_KEY, {
        viewScope: state.viewScope,
        collapsedGroupIds: state.collapsedGroupIds,
        // ★ 只在 true 时写入（brief 把该键定为可选）：false 与「老 payload 缺该键」同义
        //   （restoreScope 读回时 `=== true` 兜底），故省略不丢信息，也让既有落盘断言
        //   （toEqual 全量比对 {viewScope, collapsedGroupIds}）无需改动。
        ...(state.singleViewWindowHintShown ? {singleViewWindowHintShown: true} : {}),
    })?.catch?.(() => {})
}

/**
 * 释放指定会话的全部缓存：messagesMap / hasMoreMap / loadingMoreMap 三个会话级
 * Map 条目 + conversationLastActiveAt / handoffDismissed 两个会话级 Record 条目
 * + agentStore.convAgentStates[convId]。
 * 供 deleteConversation(s) / cleanupInactiveConversations / onConversationDeleted
 * / evictConversations（messagesMap 数量上限 LRU 淘汰）统一复用；
 * 调用方自行处理 activeConversationId 等状态切换。
 */
function releaseConvCaches(ids: string[]): void {
    if (!ids.length) return
    const state = useConversationStore.getState()
    const newMsgMap = {...state.messagesMap}
    const newHasMoreMap = {...state.hasMoreMap}
    const newLoadingMoreMap = {...state.loadingMoreMap}
    // ★ 两个会话级 Record 必须按 convId 同步删除：conversationLastActiveAt 原先只被
    //   cleanupInactiveConversations 的 keepIds 过滤（且该 set 仅在 removedIds.length>0
    //   时执行），handoffDismissed 则完全无人清理 → 删除的会话在这两张表里永久残留。
    const newLastActiveAt = {...state.conversationLastActiveAt}
    const newHandoffDismissed = {...state.handoffDismissed}
    for (const id of ids) {
        delete newMsgMap[id]
        delete newHasMoreMap[id]
        delete newLoadingMoreMap[id]
        delete newLastActiveAt[id]
        delete newHandoffDismissed[id]
    }
    useConversationStore.setState({
        messagesMap: newMsgMap,
        hasMoreMap: newHasMoreMap,
        loadingMoreMap: newLoadingMoreMap,
        conversationLastActiveAt: newLastActiveAt,
        handoffDismissed: newHandoffDismissed,
    })
    for (const id of ids) {
        useAgentStore.getState().removeConvData(id)
    }
    // ★ 若 30s 截断链正指向被释放的会话（活跃会话被删除时会先切走，但仍需兜底），
    //   立即终止，避免残留定时器持续空转
    cancelActiveTruncateFor(ids)
}

/**
 * 「真实删除」专用：释放缓存 + 清「已完成未读」标记。
 * ★ 刻意不复用 releaseConvCaches —— 后者同时被 LRU 预算淘汰（evictConversations）与
 *   10 分钟渲染清理（cleanupInactiveConversations）调用，把标记清理挂上去会让后台完成
 *   标记随驱逐静默消失，正是本标记要消灭的场景。只有真删才该销毁标记。
 */
function releaseDeletedConvs(ids: string[]): void {
    if (!ids.length) return
    releaseConvCaches(ids)
    for (const id of ids) useAgentStore.getState().clearConvDoneUnread(id)
    clearDeletedConvChildWindows(ids)
}

/**
 * 真删专用：清掉这批会话的子会话窗口覆写（childWindowSizes）。
 * ★ 与「已完成未读」标记同口径，刻意不挂 releaseConvCaches —— 后者同时服务 LRU 预算
 *   驱逐与 10 分钟渲染清理（会话仍在），挂上去会让「重新打开会话时的子列表窗口偏好」
 *   随驱逐丢失；只有真删才该销毁。原实现仅 setSectionWindowSize 的段复位分支按段内
 *   现存会话 id 过滤，真删路径无人清理 → 被删会话的条目在进程生命周期内永久驻留。
 */
function clearDeletedConvChildWindows(ids: string[]): void {
    if (!ids.length) return
    const state = useConversationStore.getState()
    const childWindowSizes = {...state.childWindowSizes}
    let changed = false
    for (const id of ids) {
        if (childWindowSizes[id] !== undefined) {
            delete childWindowSizes[id]
            changed = true
        }
    }
    if (changed) useConversationStore.setState({childWindowSizes})
}

export const useConversationStore = createWithEqualityFn<ConversationStore>()(
  (set, get) => ({
      currentWorkspacePath: null,
      gitBranch: null,
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
      viewScope: null,
      collapsedGroupIds: [],
      sectionWindowSizes: {},
      childWindowSizes: {},
      singleViewWindowHintShown: false,
      expandedChildParents: {},
      pendingFocusProject: null,
      gitBranches: {},

      // ── View scope（我在看谁，spec §5.1）───────────────

      setViewScope: (scope) => {
          set({viewScope: scope})
          persistScope(get())
      },

      /** 切到组视图：**只改 viewScope**（不动激活会话与 currentWorkspacePath，spec §5.1） */
      setProjectGroupView: (groupId) => {
          get().setViewScope({type: 'group', groupId})
      },

      toggleSectionCollapsed: (key) => {
          const current = get().collapsedGroupIds
          const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key]
          set({collapsedGroupIds: next})
          persistScope(get())
      },

      // ── 作用域化取数（spec §5.3 / §7.2）─────────────────

      /**
       * 作用域化取数（spec §5.3）：渲染层唯一入口。
       * 组视图 = 组内项目按 group_order 分段；项目视图 = `viewScope.path` 单段
       * （**优先认 scope**，见 resolveScopeProjectPaths 的 R-AU 注释；该键不可见才回退
       * currentWorkspacePath 单段）；无 scope = currentWorkspacePath 单段。
       * 组已不存在（被解散）时自动回退到 currentWorkspacePath（§5.2 回退链的运行期版本）。
       * 段窗口大小取 sectionWindowSizes[path]（缺省 10）；分支优先取批量结果 gitBranches，
       * 仅对「当前项目」回退到既有的单值 gitBranch（由 refreshGitBranch 维护）。
       */
      getScopedSections: () => {
          const state = get()
          const {
              viewScope, workspaces, currentWorkspacePath,
              searchQuery, collapsedGroupIds, sectionWindowSizes, gitBranches,
              expandedChildParents, childWindowSizes, activeConversationId,
          } = state
          const paths = resolveScopeProjectPaths(state)
          // 「未归属」虚拟段的会话（workspacePath 为空的会话）。
          //   排序口径与其他段一致：loadConversations 已按 createdAt desc 排好。
          const unassignedConversations = workspaces[UNASSIGNED_WORKSPACE_KEY]?.conversations ?? []
          // 组视图才追加未归属段；单项目视图（含 currentWorkspacePath 回退）不显示，
          // 避免污染单项目列表。未归属段不取分支（无工作目录，git 无从谈起）。
          const showUnassigned = viewScope?.type === 'group' && unassignedConversations.length > 0
          // 未归属段入参单一来源（两处分支各自构造新对象，行为与原字面量一致）
          const unassignedSection = () => ({
              projectPath: UNASSIGNED_WORKSPACE_KEY,
              projectName: '未归属',
              gitBranch: null,
              conversations: unassignedConversations,
              visibleCount: sectionWindowSizes[UNASSIGNED_WORKSPACE_KEY] ?? SECTION_DEFAULT,
          })
          // 无任何项目但有未归属会话 → 返回单独一个未归属段
          // （关键场景：零项目新用户点 MCP「帮我检查」后能看到诊断会话）
          if (paths.length === 0) {
              if (unassignedConversations.length === 0) return []
              return buildConversationSections({
                  singleProject: false,
                  searchQuery,
                  collapsedKeys: collapsedGroupIds,
                  expandedChildParents,
                  childWindowSizes,
                  // 窗口截断豁免：激活会话必须可见（spec §5.2.4 / V11 / F16）
                  activeConversationId: activeConversationId ?? undefined,
                  projects: [unassignedSection()],
              })
          }
          const single = paths.length === 1
          return buildConversationSections({
              singleProject: single && viewScope?.type !== 'group',
              searchQuery,
              collapsedKeys: collapsedGroupIds,
              expandedChildParents,
              childWindowSizes,
              // 窗口截断豁免：激活会话必须可见（spec §5.2.4 / V11 / F16）
              activeConversationId: activeConversationId ?? undefined,
              projects: [
                  ...paths.map(path => ({
                      projectPath: path,
                      projectName: getBasename(path),
                      gitBranch: gitBranches[path] ?? (path === currentWorkspacePath ? state.gitBranch : null),
                      conversations: workspaces[path]?.conversations ?? [],
                      visibleCount: sectionWindowSizes[path] ?? SECTION_DEFAULT,
                  })),
                  // 组视图：成员项目段之后追加「未归属」段（仅当有未归属会话）
                  ...(showUnassigned ? [unassignedSection()] : []),
              ],
          })
      },

      expandSection: (key) => set(s => ({
          sectionWindowSizes: {...s.sectionWindowSizes, [key]: (s.sectionWindowSizes[key] ?? SECTION_DEFAULT) + SECTION_STEP},
      })),

      /** 设定段窗口展示条数（分页控制条专用）；复位（∧∧∧ 回默认）时单向传播段 → 子：该段子会话窗口一并回默认（spec §5.4 L217） */
      setSectionWindowSize: (key, count) => {
          const next = Math.max(SECTION_DEFAULT, Math.round(count))
          if (next !== SECTION_DEFAULT) {
              set(s => ({sectionWindowSizes: {...s.sectionWindowSizes, [key]: next}}))
              return
          }
          // 复位语义：清掉该段（key = 项目路径）下所有父会话的子窗口覆写 → 回 CHILD_DEFAULT
          const ids = new Set(get().workspaces[key]?.conversations.map(c => c.id) ?? [])
          set(s => {
              const childWindowSizes = {...s.childWindowSizes}
              for (const id of Object.keys(childWindowSizes)) if (ids.has(id)) delete childWindowSizes[id]
              return {sectionWindowSizes: {...s.sectionWindowSizes, [key]: SECTION_DEFAULT}, childWindowSizes}
          })
      },

      /** 设定子会话窗口展示条数（子级分页控制条专用；不落盘） */
      setChildWindowSize: (parentId, count) => set(s => ({
          childWindowSizes: {...s.childWindowSizes, [parentId]: Math.max(CHILD_DEFAULT, Math.round(count))},
      })),

      expandChildParents: (ids) => set(s => {
          if (ids.length === 0) return s
          const next = {...s.expandedChildParents}
          let changed = false
          for (const id of ids) {
              if (!next[id]) { next[id] = true; changed = true }
          }
          return changed ? {expandedChildParents: next} : s
      }),

      /** 一次性提示已读：只置位 + 落盘（提示本身引导用户去点「···」，无独立关闭控件） */
      dismissWindowHint: () => {
          set({singleViewWindowHintShown: true})
          persistScope(get())
      },

      focusProjectSegment: (path) => set({pendingFocusProject: path}),
      clearFocusProject: () => set({pendingFocusProject: null}),

      refreshVisibleBranches: async () => {
          const api = window.electronAPI?.workspace?.getGitBranches
          if (!api) return
          // 2026-09-24 用户反馈修复：**不再过滤未加载成员**。R-28 之后组成员段一律渲染（未加载的显示
          // 「暂无会话」占位），但这里曾把「不在 workspaces 里的组成员」挡住不查 → 这些项目的段头
          // 永远拿不到分支（徽章位空着），用户看到的就是「明明有分支却不显示」。
          // 主进程 getGitBranch 对「非 git 仓库 / 路径不存在 / 不可读」一律返回 null（语义已收敛），
          // 且批量查询只读、不建 watch（watch 仍是当前项目单例），所以整组下发是安全的。
          const paths = resolveScopeProjectPaths(get())
          if (paths.length === 0) return
          try {
              const map = await api(paths)
              if (map) set({gitBranches: {...get().gitBranches, ...map}})
          } catch { /* 分支读取失败不影响列表 */ }
      },

      /** 跨项目跳转类操作：让视图跟随目标项目（§5.2 / §15.1①）——只写「我在看谁」 */
      followScopeToProject: (path) => {
          get().setViewScope({type: 'project', path})
          // ★ I-1(a)：跟随 = 「看谁」+「在哪干活」一起走。只写 viewScope 会让
          //   currentWorkspacePath 停在旧项目，于是组视图下跟随到 B 之后：右键删除按 A
          //   展开后代、重命名/置顶只改 A 的列表、MessageList 的「回到父会话」按 A 查而
          //   静默消失、头部项目名/分支显示 A。同步「在哪干活」不动 viewScope，故另一半
          //   「看谁」仍由本函数负责（分工见 syncCurrentProject 注释）。
          get().syncCurrentProject(path)
      },

      /**
       * 同步「我在哪干活」= currentWorkspacePath 到目标项目。
       *
       * ⚠ 与 followScopeToProject 的分工（两者**不可**互相替代，也**不可**混用）：
       *   · followScopeToProject = 「我在看谁」（写 viewScope）：跨项目跳转类操作让列表作用域跟随。
       *     计划明文禁止把它塞进 switchActiveConversation / setActiveConversation（switchActiveConversation
       *     也保持不写 viewScope）——组内换会话 ≠ 离开组视图，跟随会直接把用户踢出组视图。
       *   · syncCurrentProject = 「我在哪干活」（写 currentWorkspacePath）：**不写 viewScope**，
       *     故可以安全地在切换会话链路里调用（组视图内点其他成员的会话 → 干活地点跟着走、
       *     视图仍停在组视图）。它**不违反**上述禁令：禁的是改 viewScope 的那一个。
       *
       * 只做三件事：① 生效键等价则早返回；② 写 currentWorkspacePath（workspaces 缺该键时补一条
       * 空条目，否则列表按段取数会查不到会话）；③ 刷新 git 分支 + 主进程 setCurrent（异步、失败静默）。
       * **不**重设 activeConversationId、**不**加载消息、**不**写 viewScope。
       */
      syncCurrentProject: (path) => {
          const key = resolveWorkspaceKey(path)
          if (workspacePathKey(key) === workspacePathKey(get().currentWorkspacePath || '')) return
          set((state) => ({
              currentWorkspacePath: key,
              workspaces: state.workspaces[key]
                  ? state.workspaces
                  : {...state.workspaces, [key]: {lastOpenedAt: Date.now(), conversations: []}},
          }))
          void refreshGitBranch(key)
          // 主进程当前项目同步（重启后 current_workspace_id 不落伍）；竞态守卫：等待期间又切走则不写。
          void (async () => {
              try {
                  const ws = await window.electronAPI?.workspace?.getByPath(key)
                  if (ws && useConversationStore.getState().currentWorkspacePath === key) {
                      await window.electronAPI?.workspace?.setCurrent(ws.id)
                  }
              } catch { /* 静默：同步失败不影响交互 */ }
          })()
      },

      /**
       * 启动恢复（App 启动时在 loadConversations 之后调用一次）：
       * 读盘 → 载入组列表 → 用 resolveScopeFallback 走三级回退 → 落 state。
       * 组列表必须先加载：本 store 不重复持有组对象，回退校验依赖 projectGroupStore 的 groups。
       */
      restoreScope: async () => {
          let persisted: PersistedScope | null = null
          try {
              // ★ 形状校验（parsePersistedScope）：篡改/漂移的载荷按「无持久化」处理，
              //   绝不让它把异常抛进 App init 的全有全无 try（见 parsePersistedScope 注释）。
              persisted = parsePersistedScope(await window.electronAPI?.configRead?.(VIEW_SCOPE_KEY))
          } catch { /* 读不到当作没有 */ }
          await useProjectGroupStore.getState().load()
          const groups = useProjectGroupStore.getState().groups
          const state = get()
          const activeConvWs = state.activeConversationId
              ? Object.keys(state.workspaces).find(
                  p => state.workspaces[p].conversations.some(c => c.id === state.activeConversationId),
              ) ?? null
              : null
          const resolved = resolveScopeFallback({
              stored: persisted?.viewScope ?? null,
              groups,
              currentWorkspacePath: state.currentWorkspacePath,
              activeConvWorkspacePath: activeConvWs,
          })
          set({
              viewScope: resolved,
              collapsedGroupIds: Array.isArray(persisted?.collapsedGroupIds) ? persisted!.collapsedGroupIds : [],
              // 老安装的存量 payload 没有该键 → 默认 false（未提示过）
              singleViewWindowHintShown: persisted?.singleViewWindowHintShown === true,
          })
      },

      // ── Workspace ──────────────────────────────────────

      /**
       * 登记工作目录并返回「生效键」（路径 → 键的口径唯一：见 resolveWorkspaceKey）。
       * 与 setWorkspace 的区别：**不** setCurrent、**不**切 currentWorkspacePath / viewScope / 激活会话，
       * 只保证该目录在注册表里存在 + 渲染端 `workspaces` 里有一条（可为空）条目
       * —— 组内「添加项目」需要它（spec §6.2 / §15.1① 停留组视图），且该段要立即可渲染。
       * 返回 null = 登记未能确认（IPC 异常或 create 后回读为空），调用方不应继续。
       */
      ensureWorkspaceRegistered: async (path) => {
          try {
              const workspace = await registerWorkspace(path)
              if (!workspace) return null
              const key = resolveWorkspaceKey(path, workspace.path)
              // ★ I-4：登记成功后给渲染端补一条空条目。resolveScopeProjectPaths 的组档只保留
              //   「本端可见（已加载）的项目」，不补的话新入组项目既不出现也点不到（直到重启
              //   加载会话列表）。只补空条目：**不**切视图、**不** setCurrent、不加载消息
              //   ——「我在看谁 / 在哪干活」都不动。
              set((state) => state.workspaces[key]
                  ? state
                  : {workspaces: {...state.workspaces, [key]: {lastOpenedAt: Date.now(), conversations: []}}})
              return key
          } catch (err) {
              console.error('[ensureWorkspaceRegistered] error:', err)
              return null
          }
      },

      setWorkspace: async (path) => {
          if (!path) {
              set({currentWorkspacePath: null, activeConversationId: null, gitBranch: null})
              return
          }

          let canonicalPath: string | undefined
          try {
              // 登记口径唯一实现（getByPath → 等价扫描 → create → 回读，见 registerWorkspace）：
              // 此处还要用它返回的记录本身（setCurrent 需要 id），故直接调 registerWorkspace。
              const workspace = await registerWorkspace(path)
              if (workspace) {
                  canonicalPath = workspace.path
                  await window.electronAPI?.workspace?.setCurrent(workspace.id)
              }
          } catch (err) {
              console.error('[setWorkspace] error:', err)
          }

          // 生效键：优先复用已有等价键 → 注册表返回的规范路径 → 兜底原始串
          const key = resolveWorkspaceKey(path, canonicalPath)

          // 会话列表只读一次：set 前后引用同一份，避免同一份数据算两遍
          const convs = get().workspaces[key]?.conversations || []
          const idSet = new Set(convs.map(c => c.id))
          // 仅激活根会话（非子会话），避免子会话抢占激活态
          const rootConv = convs.find(c => isRootConversation(c, idSet))

          set((state) => ({
              currentWorkspacePath: key,
              activeConversationId: rootConv?.id || null,
              workspaces: {...state.workspaces, [key]: {lastOpenedAt: Date.now(), conversations: convs}},
          }))

          // 切换工作区：重新拉取 git 分支（主进程侧同时重建 watch）
          void refreshGitBranch(key)

          // 加载消息仅针对根会话（与激活保持一致）
          if (rootConv) {
              get().loadMessages(rootConv.id)
              // 冷启动/切工作区自动激活同样要按会话 meta 恢复输入栏模式
              //（否则只剩 agentStore persist 的全局默认回退，显示被污染的默认值）
              void applyConvModesToAgentStore(rootConv.id)
              // ★ 主动水合待办批次：应用重启后首次加载会话，从 DB 查询活跃批次
              void useAgentStore.getState().refreshActiveBatch?.(rootConv.id)
          }

          // 切「项目」= 现有 setWorkspace + viewScope 同步（组视图 → 单项目视图的路径，spec §5.1）
          set({viewScope: {type: 'project', path: key}})
          persistScope(get())
      },

      removeWorkspace: async (path) => {
          // 先获取 workspace id，以便从数据库中删除
          let workspace: WorkspaceRecord | null = null
          try {
              workspace = (await window.electronAPI?.workspace?.getByPath(path)) ?? null
              // 精确未命中（DB 里存的是另一种写法的旧串）→ 等价扫描拿 id。
              // 直连 getByPath 的后果是 workspaceId 为 undefined → DB 记录删不掉（只删了本地键，删一半）。
              // 删除路径永远不 create。
              if (!workspace) workspace = await findEquivalentWorkspace(path)
          } catch (err) {
              console.error('[removeWorkspace] error:', err)
          }
          const workspaceId = workspace?.id

          // 生效键与 workspace 解析同源
          const key = resolveWorkspaceKey(path, workspace?.path)
          const target = workspacePathKey(path)

          // 获取该工作区下的所有会话 ID，用于批量删除
          // ⚠ 已知残留（本轮不修）：主进程 conversation-list-by-workspace 仍是精确匹配，
          //   DB 里若存在另一种写法的会话 workspacePath，这些会话可能删不干净。
          const conversations = await window.electronAPI?.conversationListByWorkspace?.(key)
          const convIds = conversations?.map((c: any) => c.id) || []
          // 删除前先释放这批会话的渲染端缓存（messagesMap 等五张会话级表、agentStore
          // 运行时数据、截断链）并从 renderedConversationIds（LRU 已渲染表）移除，
          // 只清被删工作区的会话，不影响其余会话状态。
          evictConversations(convIds)
          // ★ 「已完成未读」标记不能挂进 evictConversations（= releaseConvCaches）：后者同时
          //   被 LRU 预算驱逐与 10 分钟渲染清理调用，挂上去会让后台完成信号随驱逐静默消失
          //   （见 conversationStore.doneUnreadInvariant.test.ts H2-a/H2-b）。本路径下方
          //   conversationDeleteBatch 是真删库行，故按真删口径在此显式销毁标记，与
          //   releaseDeletedConvs 语义对齐 —— 漏接即产生永久悬空 key（会话已不存在，不会再
          //   被激活、也不会再触发删除事件，标记在进程生命周期内驻留）。
          for (const id of convIds) useAgentStore.getState().clearConvDoneUnread(id)
          // 子会话窗口覆写同属「只有真删才销毁」的状态（口径见 clearDeletedConvChildWindows 注释）；
          // 本路径走 evictConversations（= releaseConvCaches），故需在此显式接力清理
          clearDeletedConvChildWindows(convIds)

          set((state) => {
              // 清掉所有归一化等价的键（历史遗留的重复键一并清）
              const rest = Object.fromEntries(
                  Object.entries(state.workspaces).filter(([k]) => workspacePathKey(k) !== target)
              )
              // 当前工作区判断按归一化键比较（原串精确比较会漏掉等价写法的当前工作区）
              const isCurrent = state.currentWorkspacePath !== null && workspacePathKey(state.currentWorkspacePath) === target
              return {
                  workspaces: rest,
                  currentWorkspacePath: isCurrent ? null : state.currentWorkspacePath,
                  activeConversationId: isCurrent ? null : state.activeConversationId,
                  gitBranch: isCurrent ? null : state.gitBranch,
              }
          })

          // 从数据库中删除会话和工作区记录
          if (convIds.length > 0) await window.electronAPI?.conversationDeleteBatch?.(convIds)
          if (workspaceId) await window.electronAPI?.workspace?.delete(workspaceId)
      },

      /**
       * 跨窗口跳转：切到目标会话所属的工作区并激活该会话。
       *
       * 与 setWorkspace 的差别（有意为之）：
       *  · 不为未注册的路径新建工作区记录 —— 悬空 workspace_id / hclawDir 回退路径
       *    不该被登记成用户的工作目录；
       *  · 不抢占该工作区的首个根会话 —— 激活哪个会话由调用方决定；
       *  · 工作区对比与去重按归一化键 workspacePathKey（去尾分隔符、统一 `/`、仅 Windows 忽略大小写）。
       */
      openConversationInWorkspace: async (convId, workspacePath, opts) => {
          if (workspacePathKey(workspacePath) !== workspacePathKey(get().currentWorkspacePath || '')) {
              const ws = await window.electronAPI?.workspace?.getByPath(workspacePath)
              // 仅当该路径已登记为工作区时才切「当前工作区」；不 create（不登记悬空路径）
              if (ws) await window.electronAPI?.workspace?.setCurrent(ws.id)
              // 生效键统一由 resolveWorkspaceKey 解析（与 setWorkspace / removeWorkspace 同一口径）：
              // ① 复用已有等价键（也保住该键下已加载的会话列表）② 注册表返回的规范路径 ③ 兜底投递原串。
              // 写归一化串会查不到记录，写投递原串则可能与已有等价键并存 → 侧栏两条 + 当前工作区指向空列表。
              const key = resolveWorkspaceKey(workspacePath, ws?.path)
              set((state) => ({
                  currentWorkspacePath: key,
                  workspaces: state.workspaces[key]
                      ? state.workspaces
                      : {...state.workspaces, [key]: {lastOpenedAt: Date.now(), conversations: []}},
              }))
              void refreshGitBranch(key)
              // §5.2 跟随矩阵：跨窗口/跨项目跳转（PM「发送到会话」、备忘录「跳转会话」、
              // 配置窗口打开会话）必须离开组视图跟随目标项目。
              // 例外：opts.follow === false（组视图内的窗口内跳转，如最近会话列表）只同步
              // 「在哪干活」（上面已 set currentWorkspacePath），不写 viewScope —— 组内换会话
              // ≠ 离开组视图（与 syncCurrentProject 分工注释同口径）。
              if (opts?.follow !== false) get().followScopeToProject(key)
          }
          await get().setActiveConversation(convId)
      },

      // ── Conversations ──────────────────────────────────

      createConversation: async (title?: string, opts?: {workspacePath?: string; follow?: boolean}) => {
          const id = `conv-${crypto.randomUUID()}`
          const now = Date.now()
          // 目标项目：显式传入优先（段头「+」/ 抽屉）；否则沿用当前项目（既有行为不变）
          const target = opts?.workspacePath ?? get().currentWorkspacePath
          // ★ 未归属目标（显式空串 / UNASSIGNED_WORKSPACE_KEY 虚拟键，如未归属会话
          //   激活时按 Ctrl+N、未归属段头「+」）：落库走**空路径**真相口径（与
          //   loadConversations / onConversationCreated 的「空 = 未归属」同一真相；
          //   workspacePath.ts 约定虚拟键不落库、不传主进程），且不切
          //   currentWorkspacePath（:2148 约定：虚拟键不得写入）、不刷分支、不向
          //   主进程 setCurrent。此前虚拟键被当真实项目：'__unassigned__' 落库污染
          //   DB（归段靠字符串巧合而非空路径真相）、currentWorkspacePath 被写进
          //   虚拟键。列表条目插未归属虚拟段（实时可见，不依赖兜底刷新）。
          const isUnassignedTarget = !target || target === UNASSIGNED_WORKSPACE_KEY
          const wsPath = isUnassignedTarget ? '' : target
          // 生效键：目标项目与当前项目等价 → 沿用当前键（不传 opts 时与改造前**逐字一致**，
          // 也避免把摘要写进另一条等价键导致列表查不到）；换项目 → 用唯一归一化口径
          // resolveWorkspaceKey 对齐本机登记（不新增第二条归一化路径）。
          const key = !wsPath
              ? ''
              : workspacePathKey(wsPath) === workspacePathKey(get().currentWorkspacePath || '')
                  ? (get().currentWorkspacePath || '')
                  : resolveWorkspaceKey(wsPath)
          if (key && workspacePathKey(key) !== workspacePathKey(get().currentWorkspacePath || '')) {
              // 「在哪干活」切到目标项目；「我在看谁」由调用方决定（follow / stayInScope，见 opts.follow 注释）
              set({currentWorkspacePath: key})
              void refreshGitBranch(key)
              // 主进程当前项目同步（重启后 current_workspace_id 不落伍）
              void (async () => {
                  const ws = await window.electronAPI?.workspace?.getByPath(key)
                  if (ws) await window.electronAPI?.workspace?.setCurrent(ws.id)
              })()
          }
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
              workspacePath: key,
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
              // 未归属（key 为空串真相）→ 插未归属虚拟段（不存在则建）：不写
              // currentWorkspacePath、不依赖 500ms 兜底；真实项目 → 插该项目段。
              const segKey = key || UNASSIGNED_WORKSPACE_KEY
              const wsInfo = state.workspaces[segKey] || {lastOpenedAt: now, conversations: []}
              return {
                  activeConversationId: id,
                  loadedMessages: [],
                  messagesMap: {...state.messagesMap, [id]: []},
                  workspaces: {
                      ...state.workspaces,
                      [segKey]: {...wsInfo, conversations: [summary, ...wsInfo.conversations]},
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
          // ★ 交接迁移同步：来源会话的活跃批次已迁移到新会话，清空来源会话渲染端
          //   残留待办（refreshActiveBatch 以 DB 为准，无活跃批次即清空 currentBatch/tasks）。
          if (handoffFromConvId) {
              void useAgentStore.getState().refreshActiveBatch(handoffFromConvId)
          }
          // ★ §5.2 跟随矩阵（口径与 newConversation.stayInScope 一致）：
          //   「激活新会话」由上方 switchActiveConversation 负责（只同步「在哪干活」，
          //   不写 viewScope）；本处只补「看谁」——但组视图内目标项目是组员时，
          //   跟随会把用户强制踢出组视图（组内新建/交接 ≠ 离开组视图，与组内点
          //   其他成员会话不写 viewScope 同理）→ 只做段内滚动定位。
          //   目标不在当前组（备忘录处理非组内项目 / 跨项目交接 / 无组视图）→ 跟随，
          //   保证新会话对用户可见。
          if (!workspacePath) return
          const scope = get().viewScope
          const group = scope?.type === 'group'
              ? useProjectGroupStore.getState().groups.find(g => g.id === scope.groupId)
              : null
          const inCurrentGroup = Boolean(group?.members.some(
              m => workspacePathKey(m.projectPath) === workspacePathKey(workspacePath),
          ))
          if (inCurrentGroup) get().focusProjectSegment(workspacePath)
          else get().followScopeToProject(workspacePath)
      },

      // 子 Agent 独立会话创建事件处理：插入父会话所属工作区列表顶部
      // ★ 归属 workspacePath（父会话所属工作区），不用 currentWorkspacePath 兜底：
      //   父会话不在当前工作区时，子会话会被错插到当前工作区的侧栏列表。
      // ★ 归属策略与 handleSessionCreated、onConversationCreated（schedule 分支）统一：
      //   目标工作区未在本地缓存（未加载）时新建条目再插入，使子会话立即出现在其
      //   真实项目列表下；切换/刷新时再经 conversation-list-by-workspace 从 DB 补齐完整列表。
      //   workspacePath 为空串时仍跳过（不为 '' 新建条目）；不回退 currentWorkspacePath。
      // ★ 必须保留其他工作区条目（...state.workspaces），否则项目选择器会丢失其他项目
      handleChildConvCreated: (convId, title, parentConvId, workspacePath) => {
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
              // 目标工作区未在本地缓存则新建条目（与 handleSessionCreated 同构）；
              // workspacePath 为空串时不新建 '' 条目，直接跳过
              const wsInfo = workspacePath
                  ? (state.workspaces[workspacePath] || {lastOpenedAt: now, conversations: []})
                  : undefined
              // 去重守卫：会话已存在（双投递）则跳过
              if (!wsInfo || wsInfo.conversations.some(c => c.id === convId)) return state
              return {
                  workspaces: {
                      ...state.workspaces,
                      [workspacePath]: {...wsInfo, conversations: [summary, ...wsInfo.conversations]},
                  },
              }
          })
      },

      deleteConversation: async (id) => {
          const state = get()
          // ★ I-1(b)：按**会话自身所属项目**展开后代 —— 组视图下右键的对象可能不属于
          //   currentWorkspacePath；按当前项目展开会让目标项目的后代成孤儿（列表里也删不掉）。
          const convPath = findConvHome(state.workspaces, id)
          const conversations = convPath ? state.workspaces[convPath]?.conversations ?? [] : []
          const toDelete = collectDescendants(conversations, [id])
          const wasActive = toDelete.includes(state.activeConversationId || '')
          await window.electronAPI?.conversationDeleteBatch?.(toDelete)
          set((state) => {
              const restMap = {...state.messagesMap}
              for (const delId of toDelete) {
                  delete restMap[delId]
              }
              if (!convPath || !state.workspaces[convPath]) return {...state, messagesMap: restMap}
              const remaining = state.workspaces[convPath].conversations.filter(c => !toDelete.includes(c.id))
              return {
                  messagesMap: restMap,
                  workspaces: {...state.workspaces, [convPath]: {...state.workspaces[convPath], conversations: remaining}},
              }
          })
          if (wasActive) await switchActiveConversation(getFirstRootConversationId())
          // 删除会话时统一释放消息缓存（messagesMap/hasMoreMap/loadingMoreMap）、
          // 两个会话级 Record（conversationLastActiveAt / handoffDismissed）与 agent
          // 运行时状态（含全部后代子会话），避免按 convId 的残留
          releaseDeletedConvs(toDelete)
      },

      deleteConversations: async (ids) => {
          if (!ids.length) return
          const state = get()
          // ★ I-1(b)：后代展开必须**覆盖其它项目** —— 入参 id 可能分属不同项目（会话管理页
          //   跨项目删除），只看 currentWorkspacePath 会漏掉其它项目的后代（成孤儿）。
          const toDeleteSet = new Set<string>(ids)
          for (const info of Object.values(state.workspaces)) {
              for (const delId of collectDescendants(info.conversations, ids)) toDeleteSet.add(delId)
          }
          const toDelete = [...toDeleteSet]
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
          // 同上：批量删除也需清两个会话级 Record 与 agent 运行时状态
          releaseDeletedConvs(toDelete)
      },

      setActiveConversation: async (id, opts) => {
          if (id === get().activeConversationId && !opts?.force) return
          // 刷新待处理的批次数据（文本 + 工具结果），防止切换后丢失正在流式的内容
          useAgentStore.getState().flushPendingStreamData()
          await switchActiveConversation(id, opts)
      },

      updateConversationMeta: (id, updates) => {
          set((state) => {
              // ★ I-1(b)：按会话自身所属项目写（否则组视图下重命名非当前项目的会话时
              //   DB 已改、界面不变：改动落在当前项目的列表上）。
              const wsPath = findConvHome(state.workspaces, id)
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
              // ★ I-1(b)：按会话自身所属项目写（与 togglePinConversation /
              //   onConversationUpdated 的 findConvHome 范式一致）。此前只在
              //   currentWorkspacePath 单段 map，未命中静默返回 → 未归属会话
              //   （UNASSIGNED_WORKSPACE_KEY 虚拟段）与其他非当前工作区会话的
              //   updatedAt 不实时刷新（列表排序不动、预览位置不更新），重载
              //   后才恢复。此处也不得因 currentWorkspacePath 为空整体早退
              //   （零项目场景的未归属会话同样需要收到更新）。
              const wsPath = findConvHome(state.workspaces, convId)
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
                  // ★ I-1(b)：按会话自身所属项目写（否则组视图下置顶非当前项目的会话
                  //   会写错列表：界面看起来「永远置不上」，且落库的 pinned 与界面不一致）。
                  const wsPath = findConvHome(state.workspaces, id)
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

      /**
       * 兼容既有消费方（ConversationSidebar / useGlobalHotkeys）的平铺视图：
       * 口径与渲染一致 = 各段 rows 的顺序平铺（受窗口/折叠/搜索影响，spec §7.2）。
       * 排序仍由 sections 保证（置顶优先 → createdAt desc），此处不再二次排序。
       */
      getFilteredConversations: () => {
          const sections = get().getScopedSections()
          const workspaces = get().workspaces
          const flat: ConversationSummary[] = []
          for (const section of sections) {
              const convs = workspaces[section.projectPath]?.conversations ?? []
              const byId = new Map(convs.map(c => [c.id, c]))
              // 行顺序即最终顺序（折叠段 rows 为空 → 折叠时不显示，与渲染一致）
              for (const row of section.rows) {
                  const conv = byId.get(row.id)
                  if (conv) flat.push(conv)
              }
          }
          return flat
      },

      getConversationTitle: () => {
          const {currentWorkspacePath, workspaces, activeConversationId} = get()
          return (currentWorkspacePath ? workspaces[currentWorkspacePath]?.conversations : [])?.find((c: any) => c.id === activeConversationId)?.title || ''
      },

      // ── Messages ──────────────────────────────────────

      /** 向指定会话添加消息（仅更新 UI 状态，持久化由主进程处理）
       *  timestamp 为**显式第三参数**，不是消息对象字段：调用方给不出更准的时间时可省略 → 取当前时刻。
       *  ★ 刻意不从 message 对象读 timestamp：既有调用方传的对象运行时带该字段，
       *    从中读取会把真实时间改写成旧值（类型上用 Omit 挡掉了，运行时挡不住）。 */
      addMessageToConv: (convId: string, message: Omit<Message, 'id' | 'timestamp'> & { id?: string }, timestamp?: number) => {
          const newMessage: Message = {...message, id: message.id || crypto.randomUUID(), timestamp: timestamp ?? Date.now()}
          const convMsgs = get().messagesMap[convId] || []
          // ★ INV-ORDER：按 ts 落位，而非无条件 append（旧实现永远追加末尾，越晚写入越靠后，
          //   补写历史消息时会造出与时间轴不符的假序）。数组恒有序（不变量）时，
          //   ts ≥ 末条 ts 的常见路径 findIndex 必然落空 → 仍追加末尾，与旧行为逐字等价；
          //   只有 ts 更早才插到正确位置。条件用 `>` 使同 ts 的后来者保持靠后，
          //   与 DB 侧 (timestamp, rowid) 口径一致。
          const insertAt = convMsgs.findIndex(m => m.timestamp > newMessage.timestamp)
          const newConvMsgs = insertAt === -1
              ? [...convMsgs, newMessage]
              : [...convMsgs.slice(0, insertAt), newMessage, ...convMsgs.slice(insertAt)]
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

      deleteMessageForConv: (convId, id) => {
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
          const msgsTyped = orderMessages((msgs as Message[]).map(m => truncateLargeResults(m)))
          set(state => ({
              messagesMap: {...state.messagesMap, [convId]: msgsTyped},
              loadedMessages: convId === state.activeConversationId ? msgsTyped : state.loadedMessages,
          }))
      },

      /** 增量加载：只加载最近 N 条消息（默认 50，确保切换会话时看到完整上下文） */
      loadMessagesInitial: (convId, pageSize = 50) => {
          // ★ in-flight 去重（对照 loadMoreMessages 的 loadingMoreMap 守卫）：
          //   同一 convId 的并发调用复用同一 Promise，不再发起第二次 IPC/DB 读取。
          //   switchActiveConversation / preloadConversation / 批量预热均走本入口。
          //   「非 async + 同一 Promise 引用 + settle 后清标记」由 dedupeInFlight 统一保证。
          return dedupeInFlight(initialLoadInFlight, convId, async () => {
              const result = await window.electronAPI?.conversationReadTail?.(convId, pageSize) || {
                  messages: [],
                  totalCount: 0
              }
              // ★ 内存泄漏修复：从 DB 水合的大工具结果必须在进 messagesMap 前截断。
              //   DB（message_blocks.tool_result.data）存的是完整 result，供主进程 LLM 上下文
              //   完整复原（execution.ts:72 readMessages）与缓存命中率——此处只在渲染内存副本上
              //   截断，绝不动 DB，故不影响 LLM 通路。_fullOutputStored 幂等短路避免重复截断。
              const msgs = orderMessages((result.messages as Message[]).map(m => truncateLargeResults(m)))
              const totalCount = result.totalCount
              set(state => ({
                  messagesMap: {...state.messagesMap, [convId]: msgs},
                  loadedMessages: convId === state.activeConversationId ? msgs : state.loadedMessages,
                  hasMoreMap: {...state.hasMoreMap, [convId]: msgs.length < totalCount},
                  // ★ 刚从 DB 水合 = 一次会话活跃 → 登记活跃时间戳。
                  //   否则紧随其后的数量上限淘汰会把「本次刚加载的会话」（在
                  //   conversationLastActiveAt 中无记录 → 视为最久未激活）立刻驱逐回去，
                  //   形成「加载即驱逐」的空转（被驱逐会话的时间戳已被 releaseConvCaches 删除）。
                  conversationLastActiveAt: {...state.conversationLastActiveAt, [convId]: Date.now()},
              }))
              // ★ 不变量：写回后立即执行数量上限约束。
              //   写回本身可能把键数顶到 MAX_RESIDENT_PER_PROJECT（每项目）之上（驱逐后 /
              //   期间其他会话已把 messagesMap 填满）——只在 switchActiveConversation 末尾
              //   enforce 覆盖不到这条迟到写回路径，会永久破坏「每项目 ≤3」的不变量。
              enforceMessagesMapSizeLimit()
          })
      },

      /** 加载更早的消息（追加到 messagesMap 头部） */
      loadMoreMessages: async (convId, pageSize = 2) => {
          if (get().loadingMoreMap[convId]) return // 防止重复加载
          const existing = get().messagesMap[convId]
          if (!existing || existing.length === 0) return
          // ★ 游标为 (timestamp, id) 双键：同毫秒存在多条消息且被 LIMIT 切在边界时，
          //   只传 timestamp 会让主进程用严格 `<` 把同 ts 的更早消息永久排除（分页漏取）。
          //   earliestId 经 IPC 追加为可选第 4 参，主进程据此改为
          //   `timestamp < ? OR (timestamp = ? AND rowid < cursor)`，游标严格单调后退 → 必然终止。
          const earliestTs = existing[0].timestamp
          const earliestId = existing[0].id

          set(state => ({loadingMoreMap: {...state.loadingMoreMap, [convId]: true}}))
          try {
              const result = await window.electronAPI?.conversationReadBefore?.(convId, earliestTs, pageSize, earliestId) || {
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
              const newMsgs = orderMessages([...olderMsgs, ...existing])
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
          // ★ Task 17（§10.2 / R-BN）：预热进内存的会话同时登记进 LRU 缓存池。
          //   此前 hover 路径从不登记 → 载入的会话不受「每项目缓存池 ≤5」约束，
          //   逐个 hover 即可无界撑大 messagesMap（正是 §10.3 要消除的线性增长）。
          get().markConversationRendered(convId)
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

      loadConversations: () => {
          // ★ 并发锁（in-flight 去重）：三个调用点（App.tsx 启动、ConversationsDialog
          //   打开、onConversationCreated 兜底）会在同一 tick 内并发触发本方法。
          //   无锁时会重复发起 conversationList + 整批预热（同一批 SQLite 查询叠加），
          //   并让下方的 active 改写竞争执行。并发调用复用同一 Promise
          //   （「非 async + 同一引用 + settle 后释放」由 dedupeInFlight 统一保证）。
          return dedupeInFlight(loadConversationsInFlight, LOAD_CONVERSATIONS_LOCK, async () => {
              const currentWorkspace = await window.electronAPI?.workspace?.getCurrent()
              const currentWorkspacePath = currentWorkspace?.path || null
              // 启动加载：拉取当前工作区 git 分支（主进程侧同时建立 watch）
              void refreshGitBranch(currentWorkspacePath)
              const allMetas = await window.electronAPI?.conversationList?.() || []

              const workspaces: Record<string, WorkspaceInfo> = {}
              for (const meta of allMetas as any[]) {
                  const wsPath = meta.workspacePath
                  // ★ workspacePath 为空的会话（MCP 诊断弹窗 / scheduler 定时任务等创建）
                  //   不再跳过：收进「未归属」虚拟段，使其在侧栏可见。
                  //   UNASSIGNED_WORKSPACE_KEY 仅内存使用，不落库、不参与 workspacePathKey 匹配。
                  const segKey = wsPath || UNASSIGNED_WORKSPACE_KEY
                  if (!workspaces[segKey]) workspaces[segKey] = {
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
                  if (!workspaces[segKey].conversations.find(c => c.id === summary.id)) {
                      workspaces[segKey].conversations.push(summary)
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
                  // ★ 仅在「当前没有活跃会话」时才自动选中根会话（应用启动时 activeConversationId
                  //   为 null，行为不变）。此前每次调用都无条件改写 active：onConversationCreated
                  //   的兜底刷新 / ConversationsDialog 打开会打断用户正在看的会话并重新水合其消息。
                  if (!get().activeConversationId) {
                      set({activeConversationId: root.id})
                      get().markConversationRendered(root.id)
                      await get().loadMessagesInitial(root.id)
                      // 冷启动自动激活同样要按会话 meta 恢复输入栏模式
                      //（否则只剩 agentStore persist 的全局默认回退，显示被污染的默认值）
                      void applyConvModesToAgentStore(root.id)
                  }
              }

              // ★ 后台预热当前工作区最近更新的若干会话（不是全部！见下方注释）
              // 并发控制：每批 5 个，避免瞬间发起大量 SQLite 查询
              if (currentWorkspacePath && workspaces[currentWorkspacePath]) {
                  const convs = workspaces[currentWorkspacePath].conversations
                  // ★ 缺陷 D1：预热数量收敛到 PRELOAD_MAX_CONVERSATIONS。
                  //   此前对当前工作区全部会话调 loadMessagesInitial，把整库消息（含工具
                  //   结果）灌进 messagesMap → 堆快照实测 1976 个 conv-* 键 / 1116MB 字符串。
                  //   排序依据 ConversationSummary.updatedAt（最近更新/活跃时间，
                  //   src/shared/types/infra.ts:123；touchConversation / updateConversationMeta
                  //   均以它记录会话最近活跃），按降序取最近更新的前 10 个。
                  //   仅限当前工作区（保持原筛选范围）。
                  // ★ Task 17（§10.2）：预热量再收敛为 min(PRELOAD_MAX_CONVERSATIONS,
                  //   MAX_RESIDENT_PER_PROJECT)——预热进来的会话本身就是该项目的常驻会话，
                  //   不能超过该项目的常驻预算（否则"预热即被驱逐"纯烧 CPU/IO）。
                  const toPreload = convs
                      .filter(c => {
                          const existing = get().messagesMap[c.id]
                          return !existing || existing.length === 0
                      })
                      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                      .slice(0, Math.min(PRELOAD_MAX_CONVERSATIONS, MAX_RESIDENT_PER_PROJECT))
                  const concurrency = 5
                  ;(async () => {
                      for (let i = 0; i < toPreload.length; i += concurrency) {
                          const batch = toPreload.slice(i, i + concurrency)
                          // ★ 预加载进内存的会话必须登记到 LRU 缓存表。
                          //   cleanupInactiveConversations 的输入集是 renderedConversationIds，
                          //   此前预热循环从不调 markConversationRendered → 集合差恒空 → 这批
                          //   会话永不被回收。登记后 10 分钟不活跃清理即可回收它们，
                          //   与 messagesMap 每项目常驻预算（MAX_RESIDENT_PER_PROJECT）互补。
                          await Promise.allSettled(batch.map(async c => {
                              await get().loadMessagesInitial(c.id)
                              get().markConversationRendered(c.id)
                          }))
                      }
                  })()
              }
          })
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
          // ★ 每项目缓存池 ≤ MAX_RENDERED_PER_PROJECT（§10.2-3）：本方法是缓存池的**唯一**
          //   登记点，三条路径（switchActiveConversation / preloadConversation / 批量预热）
          //   都在此处收口。守卫内部只淘汰非保护集的最冷者。
          enforceRenderedPoolLimit(projectPathOfConv(convId))
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
                  agentConv?.pendingQuestion ||
                  agentConv?.pendingToolsChangeConfirm) return true
              const lastActive = state.conversationLastActiveAt[id] ?? 0
              return now - lastActive < TEN_MIN_MS
          })
          const removedIds = state.renderedConversationIds.filter(id => !keepIds.includes(id))
          if (removedIds.length === 0) return

          set({renderedConversationIds: keepIds})

          // 统一释放被清理会话的缓存：messagesMap/hasMoreMap/loadingMoreMap、
          // 两个会话级 Record（conversationLastActiveAt / handoffDismissed）、agent
          // 运行时状态（streamBuffer、thinkingContent 等）与截断链。
          releaseConvCaches(removedIds)
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

        // ★ 归属策略与 handleSessionCreated 保持一致：一律按事件携带的真实
        //   workspacePath 归位，绝不用 currentWorkspacePath 改写归属。
        //   定时任务会话的 workspacePath 由主进程按该任务自身的 workspaceId 解析
        //   后随本事件下发（scheduler/index.ts createSchedulerConversation）。
        //   此前对 channel === 'schedule' 强制取 currentWorkspacePath：用户在项目 A
        //   创建定时任务、切到项目 B 后触发时，会话被错归到 B；重载后
        //   loadConversations 又按 meta.workspacePath 跳回 A，产生归属漂移。
        //   与 handleChildConvCreated 同根因——不得用「当前工作区」语义归属
        //   属于其他工作区的对象。
        // ★ payload 无 workspacePath 时收进「未归属」虚拟段（UNASSIGNED_WORKSPACE_KEY），
        //   与 loadConversations 的归位口径同一真相（空路径 = 未归属，如定时任务会话）；
        //   不回退 currentWorkspacePath（归属语义由 `|| UNASSIGNED_WORKSPACE_KEY` 表达）。
        //   此前此处直接 return：定时任务「立即执行」产生的会话在实时路径被丢弃，
        //   500ms 兜底虽会从 DB 归位，但组视图外用户全程看不到新会话出现。
        const wsPath = (conv.workspacePath as string | undefined) || UNASSIGNED_WORKSPACE_KEY

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

        // 目标工作区未在本地缓存（未加载）时新建条目——与 handleSessionCreated 的
        // `state.workspaces[workspacePath] || {lastOpenedAt, conversations: []}` 一致：
        // 定时任务/渠道会话必须立即出现在其真实项目列表下，切换/刷新时再由
        // conversation-list-by-workspace 从 DB 补齐完整列表。
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
        // （「未归属」是内存虚拟键，不是真实工作区，不得写入 currentWorkspacePath）
        if (!state.currentWorkspacePath && wsPath !== UNASSIGNED_WORKSPACE_KEY) {
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

        // 只清除非活跃会话的消息缓存，确保切换回该会话时从 DB 重新读取最新消息（如手机端消息）
        // 活跃会话的缓存不清除：1) 避免丢失尚未持久化的内存消息（新会话首条 Ctrl+K 自动重命名）
        // 压缩场景下的缓存更新由 compact_done 事件中的 loadMessages 自行管理
        if (data.id !== activeConversationId && data.id in messagesMap && messagesMap[data.id]!.length > 0) {
            const newMap = {...messagesMap}
            delete newMap[data.id]
            useConversationStore.setState({messagesMap: newMap})
        }

        // ★ 匹配范围：先查 currentWorkspacePath（高频路径，保持原序），未命中再经
        //   findConvHome 遍历全部已加载工作区（含「未归属」虚拟段）——I-1(b) 原则：
        //   会话操作按会话自身所属段读写，与 onConversationDeleted /
        //   togglePinConversation 的范式一致。此前只在 currentWorkspacePath 单段
        //   findIndex、未命中直接 return：定时任务会话完成后主进程推送
        //   {status:'active'}，但未归属会话（workspacePath 为空，收纳于
        //   UNASSIGNED_WORKSPACE_KEY，而该键永不写入 currentWorkspacePath）与
        //   其他非当前工作区的会话都匹配不到，status 永远停在 'running' → 侧栏
        //   isSchedulerRunning 恒真，图标闪烁不止（重载后 loadConversations 从
        //   DB 读到 active 才消失）。此处也不得因 currentWorkspacePath 为空整体
        //   早退（零项目场景的未归属会话同样需要收到状态更新）。
        let targetWsPath: string = currentWorkspacePath ?? ''
        let wsInfo = currentWorkspacePath ? workspaces[currentWorkspacePath] : undefined
        let convIndex = wsInfo?.conversations.findIndex(c => c.id === data.id) ?? -1
        if (convIndex === -1) {
            const home = findConvHome(workspaces, data.id)
            if (!home) return
            targetWsPath = home
            wsInfo = workspaces[home]
            // findConvHome 命中的不变式：该段 conversations 必含 data.id，
            // 故此处 findIndex 必然 ≥ 0（只取下标，不再二次防御）。
            convIndex = wsInfo.conversations.findIndex(c => c.id === data.id)
        }

        // 更新会话列表中的对应会话
        const updatedConversations = [...wsInfo!.conversations]
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
                [targetWsPath]: {
                    ...wsInfo!,
                    conversations: updatedConversations,
                },
            },
        })

        // ★ 渠道消息专用：主动 reloadMessages 时，从 DB 重新加载消息列表
        // 渠道消息是先写 DB 再通知 UI，不存在未持久化的问题，可以安全地 reload
        if (data.reloadMessages && data.id === activeConversationId) {
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

        // 激活会话被删除：清空激活态（由 UI 回退到空会话页）。
        // messagesMap 条目不在此处删——随后 releaseConvCaches(ids) 会统一释放同一批 id。
        if (state.activeConversationId && idSet.has(state.activeConversationId)) {
            updates.activeConversationId = null
        }
        useConversationStore.setState(updates)

        // ★ 无论被删会话是否激活，统一释放其消息缓存（messagesMap/hasMoreMap/loadingMoreMap）
        //   与 agent 运行时数据；否则非激活会话（后台流式/子会话/其他工作区）的缓存会永久残留。
        //   （messagesMap 在激活分支已删，此处对 ids 统一 delete 幂等。）
        releaseDeletedConvs(ids)
    })
}
