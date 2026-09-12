/**
 * 工具调用状态管理 Store
 * 
 * 独立管理工具调用的运行时状态，避免频繁更新触发全局重渲染。
 * 
 * 设计原则：
 * 1. 工具状态变化（progress、status）只更新本 store，不触碰 loadedMessages
 * 2. 只有在最终结果返回时，才同步更新 loadedMessages
 * 3. 使用批量异步处理，避免高频更新导致 UI 卡顿
 */

import {create} from 'zustand'
import {flatString} from '../utils/flatString'

/** 扩展的工具结果类型（包含主进程返回的完整字段） */
export interface ExtendedToolResult {
    success: boolean
    output: string
    error?: string
    /** 文件变更副作用 */
    artifacts?: Array<{
        filePath: string
        action: 'created' | 'modified' | 'deleted'
        content?: string
    }>
    /** 补丁数据（用于 file_edit 等工具） */
    diff?: string
    /** 任务列表更新 */
    tasks?: any[]
}

/** 进度时间轴条目 */
export interface ProgressEntry {
    timestamp: number
    text: string
}

/** 子 Agent 流式事件条目（存储完整的思考/工具/正文事件） */
export interface SubAgentStreamEntry {
    type: 'text' | 'thinking' | 'tool_start' | 'tool_result' | 'error'
    timestamp: number
    content?: string
    toolName?: string
    toolArgs?: Record<string, unknown>
    isError?: boolean
}

/** 工具调用运行时状态 */
export interface ToolCallState {
    status: 'pending' | 'running' | 'success' | 'error' | 'cancelled'
    progress?: string
    progressPercent?: number
    eta?: number
    /** 执行超时时间（毫秒），由主进程 tool_start 事件注入，用于倒计时显示 */
    timeoutMs?: number
    /** 工具开始执行的时间戳（tool_start 到达时刻），倒计时起点 */
    startedAt?: number
    result?: ExtendedToolResult
    /** 详细状态 */
    detailStatus?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    /** 子 Agent 任务 ID（taskId === 子会话 ID，用于跳转/关联） */
    taskId?: string
    /** token 用量（仅 agent 工具） */
    tokenUsage?: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
    }
    /** 进度时间轴（按时间序累积，用于 agent 卡片展开时的 timeline 渲染） */
    progressLog?: ProgressEntry[]
    /** 子 Agent 流式事件（完整的思考/工具调用/正文事件序列） */
    subAgentStream?: SubAgentStreamEntry[]
    /** 所属会话 ID（注册时写入，供会话清理时整批清除） */
    convId?: string
}

interface ToolCallsStore {
    /** toolCallId -> 工具状态 */
    states: Record<string, ToolCallState>
    
    /** 注册一个新的工具调用（初始化状态） */
    registerToolCall: (toolCallId: string, initial?: Partial<ToolCallState>, convId?: string) => void
    
    /** 更新工具状态（progress、status 等）；convId 仅用于 key 不存在时的兜底建键 */
    updateToolCall: (toolCallId: string, updates: Partial<ToolCallState>, convId?: string) => void
    
    /** 设置工具执行结果；convId 仅用于 key 不存在时的兜底建键 */
    setToolResult: (toolCallId: string, result: ExtendedToolResult, convId?: string) => void
    
    /** 批量更新工具状态（用于批量异步处理） */
    batchUpdate: (updates: Array<{ toolCallId: string; updates: Partial<ToolCallState> }>) => void
    
    /** 获取单个工具状态 */
    getState: (toolCallId: string) => ToolCallState | undefined
    
    /** 获取多个工具状态 */
    getStates: (toolCallIds: string[]) => Record<string, ToolCallState>
    
    /** 清理指定工具的状态 */
    clearToolCall: (toolCallId: string) => void
    
    /** 清理所有工具状态（新的 assistant 消息开始时调用） */
    clearAll: () => void

    /** 向进度时间轴追加条目（立即更新，不走批处理队列） */
    appendProgressLog: (toolCallId: string, text: string) => void

    /** 向子 Agent 流追加事件条目（立即更新，不走批处理队列） */
    appendSubAgentStream: (toolCallId: string, entry: SubAgentStreamEntry) => void

    /** 批量清除某会话的全部工具运行时状态（会话删除/收尾兜底；正常路径由 tool_result 完成时逐个 clearToolCall） */
    clearConversationToolCalls: (convId: string) => void
}

// ─── 批量更新队列 ───────────────────────────────────────

let batchQueue: Array<{ toolCallId: string; updates: Partial<ToolCallState> }> = []
let batchRafId: number | null = null
let isProcessing = false

/**
 * 执行批量更新
 */
function flushBatch(store: { set: (fn: (state: ToolCallsStore) => Partial<ToolCallsStore>) => void }) {
    if (batchQueue.length === 0) return
    
    const updates = batchQueue
    batchQueue = []
    batchRafId = null
    isProcessing = false
    
    store.set((state) => {
        const newStates = {...state.states}
        for (const {toolCallId, updates: partial} of updates) {
            // 只更新已存在的 key：若该 key 已被 clearToolCall / clearConversationToolCalls 删除，
            // 则丢弃这批迟到的 progress 更新，避免复活出一个无 convId 的孤儿 key（会导致
            // 会话级清理永远删不掉、UI 上已中止的工具卡片一直转圈）。
            const existing = newStates[toolCallId]
            if (!existing) continue
            newStates[toolCallId] = {...existing, ...partial}
        }
        return {states: newStates}
    })
}

/**
 * 调度批量更新（使用 requestAnimationFrame）
 */
function scheduleBatchFlush(store: { set: (fn: (state: ToolCallsStore) => Partial<ToolCallsStore>) => void }) {
    if (isProcessing) return
    if (batchRafId !== null) return
    
    isProcessing = true
    batchRafId = requestAnimationFrame(() => {
        flushBatch(store)
    })
}

/** 子 Agent 流式事件数组滑动窗口上限：控制单条 assistant 气泡的内存占用 */
const MAX_SUBAGENT_STREAM_ENTRIES = 500

/** 进度时间轴条数上限（与主进程 PROGRESS_LOG_MAX 对齐，见 src/main/agent/manager.accumulator.ts） */
export const PROGRESS_LOG_MAX = 200

/**
 * 单条 subAgentStream text 条目合并后的字符上限。
 * 数组滑动窗口（500 条）无法约束"单条超长流式文本"——LLM 逐 token 到达时所有 token 会
 * 合并进同一条 entry，content 可无限增长。这里对合并结果做二次封顶。
 * 取 12000：约为常见中英文混排 3~4k token，足以容纳一个完整的正文块而不产生可见截断，
 * 同时把单条 entry 的内存占用限制在可控范围（远大于测试中的短合并串）。
 */
export const MAX_SUBAGENT_TEXT_LENGTH = 12000

/**
 * 合并文本被截断时追加的可见提示。
 *
 * ★ 内存优化 B2：哨兵抗碰撞。截断逻辑需要从正文中剔除历史标记（见 appendSubAgentStream），
 *   若直接用可见文案 `…(已截断较早内容)` 作哨兵，`split(marker).join('')` 会无差别删除
 *   正文中偶然出现的同名中文字面量（例如模型输出里恰好写了这句话）——内容被静默吞掉。
 *   这里用 U+2063 INVISIBLE SEPARATOR 包夹哨兵：可见文案保持 `…(已截断较早内容)` 不变，
 *   UI 观感一致，但正文自然语言几乎不可能命中完整哨兵，剔除操作只作用于真正的标记。
 *   U+2063 是普通 UTF-16 code unit（无代理对），split/join/flatString 对其无特殊语义。
 *   其长度已计入 MARKER.length，参与 keep 计算（MAX - MARKER.length），无需额外处理。
 */
export const SUBAGENT_TEXT_TRUNCATION_MARKER = '\u2063…(已截断较早内容)\u2063'

export const useToolCallsStore = create<ToolCallsStore>()((set, get) => ({
    states: {},
    
    registerToolCall: (toolCallId, initial, convId) => {
        set((state) => ({
            states: {
                ...state.states,
                [toolCallId]: {
                    status: 'running' as const,
                    ...initial,
                    ...(convId !== undefined ? {convId} : {}),
                },
            },
        }))
    },
    
    updateToolCall: (toolCallId, updates, convId) => {
        // 对于高频更新（如 progress），加入批量队列
        if (updates.progress !== undefined || updates.progressPercent !== undefined) {
            batchQueue.push({toolCallId, updates})
            scheduleBatchFlush({set})
            return
        }
        
        // 其他更新立即执行
        set((state) => ({
            states: {
                ...state.states,
                [toolCallId]: {
                    // key 不存在时自动建键（streamSubAgents 依赖此行为建立父 agent 运行时 key）。
                    // fallback 必须带上 convId，否则会产出 clearConversationToolCalls 删不掉的孤儿 key
                    // （会话删除/切换后内存态残留）。key 已存在时不覆盖其原有 convId（existing 展开在前）。
                    ...(state.states[toolCallId] || {status: 'running', ...(convId ? {convId} : {})}),
                    ...updates,
                },
            },
        }))
    },
    
    setToolResult: (toolCallId, result, convId) => {
        set((state) => ({
            states: {
                ...state.states,
                [toolCallId]: {
                    // 同 updateToolCall：fallback 必须带 convId，否则产生 clearConversationToolCalls
                    // 删不掉的孤儿 key；key 已存在时不覆盖其原有 convId。
                    ...(state.states[toolCallId] || {status: 'pending', ...(convId ? {convId} : {})}),
                    status: result.error ? 'error' : 'success',
                    result,
                },
            },
        }))
    },
    
    batchUpdate: (updates) => {
        for (const {toolCallId, updates: partial} of updates) {
            batchQueue.push({toolCallId, updates: partial})
        }
        scheduleBatchFlush({set})
    },
    
    getState: (toolCallId) => get().states[toolCallId],
    
    getStates: (toolCallIds) => {
        const states = get().states
        const result: Record<string, ToolCallState> = {}
        for (const id of toolCallIds) {
            if (states[id]) {
                result[id] = states[id]
            }
        }
        return result
    },
    
    clearToolCall: (toolCallId) => {
        set((state) => {
            const {[toolCallId]: _, ...rest} = state.states
            return {states: rest}
        })
    },
    
    clearAll: () => {
        // 先刷完积攒的批量更新
        if (batchRafId !== null) {
            cancelAnimationFrame(batchRafId)
            batchRafId = null
        }
        if (batchQueue.length > 0) {
            // 立即应用所有积攒的更新
            set((state) => {
                const newStates = {...state.states}
                for (const {toolCallId, updates} of batchQueue) {
                    newStates[toolCallId] = {...(newStates[toolCallId] || {status: 'pending' as const}), ...updates}
                }
                batchQueue = []
                return {states: newStates}
            })
        }
        
        // 清空所有状态
        set({states: {}})
        isProcessing = false
    },

    appendProgressLog: (toolCallId, text) => {
        const entry = {timestamp: Date.now(), text}
        set((state) => {
            // 与 flushBatch 同款守卫：若该 key 已被 clearToolCall / clearConversationToolCalls 删除，
            // 直接丢弃本次迟到的 progress 更新，防止复活出无 convId 的孤儿 key
            // （会话级清理永远删不掉、progressLog 继续累积到 PROGRESS_LOG_MAX）。
            const existing = state.states[toolCallId]
            if (!existing) return {}
            const currentLog = existing.progressLog || []
            const lastEntry = currentLog.length > 0 ? currentLog[currentLog.length - 1] : null
            // 去重：如果最后一条文本相同，不追加
            if (lastEntry?.text === text) return {}
            const nextLog = [...currentLog, entry]
            return {
                states: {
                    ...state.states,
                    [toolCallId]: {
                        ...existing,
                        progress: text,
                        // FIFO 丢最旧保最新：始终保留尾部（最新）条目，
                        // StreamEntryRenderer.getLastActiveTime 依赖尾部时间戳判定"最后活跃"脉冲
                        progressLog: nextLog.length > PROGRESS_LOG_MAX
                            ? nextLog.slice(-PROGRESS_LOG_MAX)
                            : nextLog,
                    },
                },
            }
        })
    },

    appendSubAgentStream: (toolCallId, entry) => {
        set((state) => {
            // 与 flushBatch 同款守卫：若该 key 已被 clearToolCall / clearConversationToolCalls 删除，
            // 直接丢弃本次迟到的流式事件，防止复活出无 convId 的孤儿 key
            // （会话级清理永远删不掉、subAgentStream 继续累积）。
            const existing = state.states[toolCallId]
            if (!existing) return {}
            const currentStream = existing.subAgentStream || []
            // 合并连续 text 条目：LLM token 级流式输出逐 token 到达，
            // 若上一个 entry 也是 text 类型，追加内容而非创建新 entry，避免单个词/字独占一行
            const lastEntry = currentStream.length > 0 ? currentStream[currentStream.length - 1] : undefined
            if (entry.type === 'text' && lastEntry?.type === 'text') {
                // 合并前先对结果做长度封顶：超出时保留尾部（丢最早内容）并追加可见提示，
                // 避免逐 token 流式把单条 entry 的 content 撑成无限大。
                let mergedContent = (lastEntry.content || '') + (entry.content || '')
                if (mergedContent.length > MAX_SUBAGENT_TEXT_LENGTH) {
                    // ★ 内存优化 B1：先剔除、后切片、再补一条。
                    //   修复前（D1）先 slice(-keep) 再剔除标记：若切片起点恰好落入标记内部，
                    //   标记被切成半截残片（"(已截断较早内容)" / "较早内容)" / ")" 等），
                    //   split 匹配不到完整标记 → 残片留在内容头部，用户可见。
                    //   改为先剔除全文旧标记（cleaned 内不含任何标记片段），再对 cleaned 切片，
                    //   切片永不切穿标记，从性质上保证结果中不残留任何半截标记片段。
                    //   不变量：任意多次截断后，标记恰好出现 1 次且为后缀，长度 ≤ MAX；
                    //   首次截断时 merged 内无标记，split/join 为恒等操作，结果与 D1 逐字节一致。
                    const keep = MAX_SUBAGENT_TEXT_LENGTH - SUBAGENT_TEXT_TRUNCATION_MARKER.length
                    const cleaned = mergedContent.split(SUBAGENT_TEXT_TRUNCATION_MARKER).join('')
                    // ★ 内存优化 V1：slice(-keep) 产生 SlicedString 会钉住整个父串，flatString 强制扁平复制
                    mergedContent = flatString(cleaned.slice(-keep)) + SUBAGENT_TEXT_TRUNCATION_MARKER
                }
                const merged = {
                    ...lastEntry,
                    content: mergedContent,
                }
                const newStream = [...currentStream]
                newStream[newStream.length - 1] = merged
                return {
                    states: {
                        ...state.states,
                        [toolCallId]: { ...existing, subAgentStream: newStream },
                    },
                }
            }

            if (currentStream.length < MAX_SUBAGENT_STREAM_ENTRIES) {
                return {
                    states: {
                        ...state.states,
                        [toolCallId]: {
                            ...existing,
                            subAgentStream: [...currentStream, entry],
                        },
                    },
                }
            }

            // 达到上限：截断为滑动窗口。截断标记插入头部；下次溢出时 slice 会将其从头部
            // 移出，因此每次溢出都重新插入一条标记（窗口内始终恰好一条）。
            const trimmed = currentStream.slice(-MAX_SUBAGENT_STREAM_ENTRIES + 1)
            return {
                states: {
                    ...state.states,
                    [toolCallId]: {
                        ...existing,
                        subAgentStream: [
                            {
                                type: 'text' as const,
                                timestamp: Date.now(),
                                content: `(已截断较早流式记录，仅保留最近 ${MAX_SUBAGENT_STREAM_ENTRIES} 条)`,
                                _truncationMarker: true,
                            },
                            ...trimmed,
                            entry,
                        ],
                    },
                },
            }
        })
    },

    clearConversationToolCalls: (convId) => {
        set((state) => {
            const newStates = {...state.states}
            let removed = false
            for (const [toolCallId, s] of Object.entries(newStates)) {
                if (s.convId === convId) {
                    delete newStates[toolCallId]
                    removed = true
                }
            }
            return removed ? {states: newStates} : {}
        })
    },
}))
