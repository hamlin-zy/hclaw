/**
 * Agent 循环控制器 — 类型定义
 */

import type {ChatMessage, ModelConfig} from '../model/types'
import type {AgentStreamEvent} from '../stream'
import type {LoopState as AgentLoopState} from '../state'
import type {
    AgentTemplate,
    CommandExecutionContext,
    HClawAgentType,
    IntentAnalysisResult,
    MCPServer
} from '@shared/types'
import type {ModelRole} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'

// ─── 控制器内部类型 ────────────────────────────────────

export interface TurnModelSelection {
    modelConfig: ModelConfig
    schemeId: string | null
    schemeName: string | null
    suggestedRole: ModelRole
}

export interface LlmStreamResult {
    assistantContent: string
    assistantThinking: string
    assistantThinkingSignature: string
    assistantReasoningContent: string
    collectedToolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}>
    plannedCommands: string[] | undefined
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    llmDuration: number
    adapter: any
    currentProvider: string
    currentModel: string
    currentConfigSource: string
    currentSchemeName: string | null
}

export interface ToolExecutionResult {
    state: AgentLoopState
    events: AgentStreamEvent[]
}

/** #mainLoop 的退出原因 */
export type MainLoopExitReason = 'max_turns' | 'early_exit'

/** 控制器自身状态 */
export type ControllerState = 'idle' | 'thinking' | 'running' | 'done'

// ─── RunParams ─────────────────────────────────────────

export interface RunParams {
    /** 会话 ID（用于 Hook 系统触发事件） */
    sessionId?: string
    messages: ChatMessage[]
    modelConfig: ModelConfig
    settings?: import('@shared/types').SystemSettings
    workingDir: string
    maxTurns?: number
    customInstructions?: string
    skills?: string[]
    abortSignal?: AbortSignal
    schemeConfig?: {
        scheme: import('@shared/types').ModelScheme
        providers: any[]
    }
    agentType?: HClawAgentType
    mcpServers?: MCPServer[]
    agentTemplates?: AgentTemplate[]
    requestConfirmation?: (message: string) => Promise<'allow' | 'always' | 'deny'>
    askUserQuestion?: (question: string, options?: string[], multiSelect?: boolean) => Promise<string>
    /** 通过渠道发送消息（Worker → Main IPC），返回发送确认结果 */
    channelSend?: (channelId: string, toUser: string, text: string, contextToken?: string, fileType?: string) => Promise<{ success: boolean; error?: string }>
    conversationTitle?: string
    onEvent?: (event: any) => void
    schemeUpdatePromise?: () => Promise<void>
    agentDefinition?: AgentDefinition
    runtimeConfig?: {
        pendingCompact?: boolean
        settings?: import('@shared/types').SystemSettings
    }
    /** 消息元数据（如命令模板等），用于识别命令模式 */
    messageMetadata?: Record<string, unknown>
    /**
     * Hook 执行后注入的额外上下文
     * 来自 SessionStart/UserPromptSubmit hook 的 additionalContext
     * 会注入到消息中（历史消息之后，用户消息之前），最大化缓存命中
     */
    hookAdditionalContext?: string
    /**
     * 运行中注入的用户消息队列（Worker 内共享引用）
     * 新消息会 push 到此数组，每次 LLM 调用前检查并注入到 currentState
     */
    pendingInjectedMessages?: ChatMessage[]
}
