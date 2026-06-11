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
    result?: ExtendedToolResult
    /** 详细状态 */
    detailStatus?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
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
}

interface ToolCallsStore {
    /** toolCallId -> 工具状态 */
    states: Record<string, ToolCallState>
    
    /** 注册一个新的工具调用（初始化状态） */
    registerToolCall: (toolCallId: string, initial?: Partial<ToolCallState>) => void
    
    /** 更新工具状态（progress、status 等） */
    updateToolCall: (toolCallId: string, updates: Partial<ToolCallState>) => void
    
    /** 设置工具执行结果 */
    setToolResult: (toolCallId: string, result: ExtendedToolResult) => void
    
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
            const existing = newStates[toolCallId] || {status: 'pending' as const}
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

export const useToolCallsStore = create<ToolCallsStore>()((set, get) => ({
    states: {},
    
    registerToolCall: (toolCallId, initial) => {
        set((state) => ({
            states: {
                ...state.states,
                [toolCallId]: {
                    status: 'pending',
                    ...initial,
                },
            },
        }))
    },
    
    updateToolCall: (toolCallId, updates) => {
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
                    ...(state.states[toolCallId] || {status: 'pending'}),
                    ...updates,
                },
            },
        }))
    },
    
    setToolResult: (toolCallId, result) => {
        set((state) => ({
            states: {
                ...state.states,
                [toolCallId]: {
                    ...(state.states[toolCallId] || {status: 'pending'}),
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
            const existing = state.states[toolCallId] || {status: 'pending' as const}
            const currentLog = existing.progressLog || []
            const lastEntry = currentLog.length > 0 ? currentLog[currentLog.length - 1] : null
            // 去重：如果最后一条文本相同，不追加
            if (lastEntry?.text === text) return {}
            return {
                states: {
                    ...state.states,
                    [toolCallId]: {
                        ...existing,
                        progress: text,
                        progressLog: [...currentLog, entry],
                    },
                },
            }
        })
    },

    appendSubAgentStream: (toolCallId, entry) => {
        set((state) => {
            const existing = state.states[toolCallId] || {status: 'pending' as const}
            const currentStream = existing.subAgentStream || []
            // 合并连续 text 条目：LLM token 级流式输出逐 token 到达，
            // 若上一个 entry 也是 text 类型，追加内容而非创建新 entry，避免单个词/字独占一行
            const lastEntry = currentStream.length > 0 ? currentStream[currentStream.length - 1] : undefined
            if (entry.type === 'text' && lastEntry?.type === 'text') {
                const merged = {
                    ...lastEntry,
                    content: (lastEntry.content || '') + (entry.content || ''),
                }
                const newStream = [...currentStream]
                newStream[newStream.length - 1] = merged
                return {
                    states: {
                        ...state.states,
                        [toolCallId]: {
                            ...existing,
                            subAgentStream: newStream,
                        },
                    },
                }
            }
            return {
                states: {
                    ...state.states,
                    [toolCallId]: {
                        ...existing,
                        subAgentStream: [...currentStream, entry],
                    },
                },
            }
        })
    },
}))
