import type {AgentState, IntentAnalysisResult, RunMode, Task, WorkMode} from '@shared/types'
import type {AgentStreamEvent} from '../../../main/agent/stream'

/** Agent Stream Payload 类型 */
export interface AgentStreamPayload {
    conversationId: string
    event: AgentStreamEvent
}

// ─── LLM 消息格式 ────────────────────────────────────────
// 与主进程 ChatMessage 类型对齐

export interface LLMMessage {
    role: 'user' | 'assistant' | 'tool'
    content: string
    toolCalls?: Array<{
        id: string
        name: string
        arguments: Record<string, unknown>
    }>
    toolCallId?: string
    toolResult?: string
    isError?: boolean
}

export interface HookResultItem {
    id: string
    event: string
    hookName: string
    success: boolean
    error?: string
    timestamp: number
    conversationId: string // 所属会话
}

// ─── 多会话独立 Agent 状态 ────────────────────────────
/** 每个会话独立的运行时数据，包括流式缓冲区、消息 ID、agent 状态等 */
export interface ConvAgentData {
    agentState: AgentState
    streamBuffer: string
    thinkingContent: string | null
    /** 跟踪流式过程中的时间序内容块（仅流式期间存在，done 时重建为 contentBlocks） */
    streamBlocks: Array<{
        type: 'think' | 'tool_use'
        id: string
        /** 该 block 出现时的 streamBuffer 长度，用于重建文本段顺序 */
        textOffset: number
        /** think 块累积内容 */
        thinkContent?: string
        thinkSignature?: string
        /** tool_use 块数据 */
        toolCall?: import('@shared/types').ToolCall
    }>
    /** 当前正在流式输出的 assistant 消息 ID */
    streamingMessageId: string | null
    /** 工具执行完毕后，等待 LLM 响应中 */
    isThinkingAfterTools: boolean
    /** 当前正在执行的工具数量 */
    runningToolCount: number
    /** Agent 向用户提问的内容（ask_user 工具触发） */
    pendingQuestion: { question: string; options?: string[]; multiSelect?: boolean; requestId?: string } | null
    /** 紧凑模式工具调用详情弹窗数据（null = 关闭） */
    toolPopupData: {
        toolCalls: any[]
        title?: string
        isAgent?: boolean
        agentDisplayName?: string | null
        agentTypeLabel?: string | null
        /** 当前展开的卡片 ID 列表（跨会话恢复） */
        expandedCardIds?: string[]
    } | null
    /** Agent 需要用户确认权限的内容（核心权限系统触发） */
    pendingPermissionConfirm: { question: string; requestId?: string } | null
    /** 当前任务列表 */
    tasks: Task[]
    /** 意图分析结果 */
    intentResult: IntentAnalysisResult | null
    /** LLM 运行错误信息，显示在消息列表左下角而非消息气泡中 */
    errorMessage: string | null
    /** 工具执行开始时的临时提示消息（如"工具执行中..."），tool_start 后清除 */
    executingToolsMessage: string | null
    /** 用户运行时发送的消息队列，下一 turn 依次作为独立消息处理 */
    pendingMessages: Array<{
        content: string
        attachments?: Array<{ id: string; name: string; path: string; size: number; type: string; isImage: boolean }>
        metadata?: Record<string, unknown>
    }>
}

// ─── Agent Store（渲染进程侧） ──────────────────────────
//
// 职责：
// 1. 管理 Agent 运行时状态（idle/thinking/running/error）
// 2. 缓冲流式文本 / thinking / 工具调用
// 3. 通过 IPC 启动/中止 Agent
// 4. 所有事件（text/tool_start/tool_result）写入同一条 assistant 消息
//    → 一次 Agent 回合 = 一条 assistant 消息（含内联工具调用）

export interface AgentStore {
    agentState: AgentState
    streamBuffer: string
    thinkingContent: string | null
    /** 跟踪流式过程中的时间序内容块（仅流式期间存在，done 时重建为 contentBlocks） */
    streamBlocks: Array<{
        type: 'think' | 'tool_use'
        id: string
        /** 该 block 出现时的 streamBuffer 长度，用于重建文本段顺序 */
        textOffset: number
        /** think 块累积内容 */
        thinkContent?: string
        thinkSignature?: string
        /** tool_use 块数据 */
        toolCall?: import('@shared/types').ToolCall
    }>
    /** 当前正在流式输出的 assistant 消息 ID */
    streamingMessageId: string | null
    /** 工具执行完毕后，等待 LLM 响应中 */
    isThinkingAfterTools: boolean
    /** 当前正在执行的工具数量 */
    runningToolCount: number
    /** Agent 向用户提问的内容（ask_user 工具触发） */
    pendingQuestion: { question: string; options?: string[]; multiSelect?: boolean; requestId?: string } | null
    /** 紧凑模式工具调用详情弹窗数据（null = 关闭） */
    toolPopupData: {
        toolCalls: any[]
        title?: string
        isAgent?: boolean
        agentDisplayName?: string | null
        agentTypeLabel?: string | null
        expandedCardIds?: string[]
    } | null
    /** Agent 需要用户确认权限的内容（核心权限系统触发） */
    pendingPermissionConfirm: { question: string; requestId?: string } | null
    /** 当前任务列表 */
    tasks: Task[]
    /** 意图分析结果 */
    intentResult: IntentAnalysisResult | null
    /** 当前权限规则列表 */
    permissionRules: any[]
    /** 当前权限模式 */
    permissionMode: 'auto' | 'safe'
    /** 当前工作模式 */
    workMode: WorkMode
    /** 消息显示模式：详细模式（detailed）、精简模式（compact）、紧凑模式（ultra-compact） */
    messageDisplayMode: 'detailed' | 'compact' | 'ultra-compact'
    /** 压缩结果统计，用于展示 CompactWarningBanner */
    compactStats: {
        beforeTokens: number
        afterTokens: number
        savedTokens: number
        compactedMessages: number
        showBanner: boolean
    } | null
    /** 压缩是否正在进行中 */
    compactInProgress: boolean
    /** LLM 运行错误信息，显示在消息列表左下角而非消息气泡中 */
    errorMessage: string | null

    // ── Actions ────────────────────────────────────
    clearCompactBanner: () => void
    openToolPopup: (data: NonNullable<AgentStore['toolPopupData']>) => void
    closeToolPopup: () => void
    updateToolPopupExpanded: (expandedCardIds: string[]) => void
    combinedPopupData: {
        items: Array<{type: 'think' | 'tools'; thinkBlock?: any; blockId?: string; toolCalls?: any[]}>
        thinkCount: number
        toolCalls: any[]
        convId?: string
        messageId?: string
    } | null
    openCombinedPopup: (data: NonNullable<AgentStore['combinedPopupData']>) => void
    closeCombinedPopup: () => void

    // ── 多会话独立状态 ──────────────────────────────────
    convAgentStates: Record<string, ConvAgentData>
    getConvData: (convId: string) => ConvAgentData
    updateConvData: (convId: string, updates: Partial<ConvAgentData>) => void
    removeConvData: (convId: string) => void

    setAgentState: (state: Partial<AgentState>) => void
    setMode: (mode: 'auto') => void
    setPermissionMode: (mode: RunMode) => Promise<void>
    setWorkMode: (mode: WorkMode) => Promise<void>
    setMessageDisplayMode: (mode: 'detailed' | 'compact' | 'ultra-compact') => void
    respondQuestion: (result: 'allow' | 'always' | 'deny') => Promise<void>
    answerQuestion: (answer: string) => Promise<void>
    clearPendingQuestion: () => void

    setPendingPermissionConfirm: (confirm: { question: string; requestId?: string } | null) => void

    fetchPermissionRules: () => Promise<void>
    removePermissionRule: (toolName: string) => Promise<void>
    addPermissionRule: (rule: { tool: string; action: string }) => Promise<void>

    startAgent: (params: {
        conversationId: string
        message: string
        messageAttachments?: Array<{ path: string; name: string }>
        messageMetadata?: Record<string, unknown>
    }) => Promise<void>

    abortAgent: (conversationId: string) => Promise<void>

    handleStreamEvent: (payload: AgentStreamPayload) => Promise<void>

    /** 在流式过程中从 streamBlocks 构建 contentBlocks，保持正确的交织渲染顺序 */
    updateMessageContentBlocks: (convId?: string) => void

    /** 刷新所有待处理的流式数据批次（文本 + 工具结果），切换会话前调用 */
    flushPendingStreamData: () => void

    /** 页面刷新后：查询主进程中仍在运行的 agent，恢复流式渲染状态 */
    recoverSessions: () => Promise<void>

    /** 清理残留的 running/thinking 状态（HMR 后 agent 已完成但状态卡住时使用） */
    recoverSessionsCleanup: (keepRunning?: Set<string>) => void

    registerStreamListener: () => () => void

    /** Hook 执行结果列表（用于 UI 反馈） */
    hookResults: HookResultItem[]
    /** 添加 hook 执行结果（自动清理超 50 条的旧记录） */
    addHookResult: (item: HookResultItem) => void
}
