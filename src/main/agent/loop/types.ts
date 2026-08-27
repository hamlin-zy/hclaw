/**
 * Agent 循环控制器 — 类型定义
 */

import type {ChatMessage, ModelConfig} from '../model/types'
import type {AgentStreamEvent} from '../stream'
import type {LoopState as AgentLoopState} from '../state'
import type {
    AgentTemplate,
    HClawAgentType,
    MCPServer
} from '@shared/types'
import type {ModelRole} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'
import type {LlmTraceContextKind} from '@shared/types/llmTrace'

// ─── 控制器内部类型 ────────────────────────────────────

export interface TurnModelSelection {
    modelConfig: ModelConfig
    schemeId: string | null
    schemeName: string | null
    suggestedRole: ModelRole
    /** providers 表服务商名（providers.name，人类可读），用于 agent_start 事件展示 */
    providerName?: string
    /** 模型由会话 override 直接指定（绕过角色路由），适配器直接以该 config 创建 */
    directModel?: boolean
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
    ttftMs?: number
    decodeMs?: number
    tokensPerSecond?: number
    llmDuration: number
    adapter: any
    currentProvider: string
    currentModel: string
    currentConfigSource: string
    currentSchemeName: string | null
    /** providers 表服务商名（providers.name），供用量统计按服务商展示人类可读名 */
    providerName: string
    /** mid-loop 交接门已注入交接指令（auto-handoff）；controller 应在工具执行后强制结束本轮 */
    handoffRequested?: boolean
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
    /** 会话 ID */
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
    /** LLM 归因来源（显式声明，缺省回退 'main'） */
    traceContext?: LlmTraceContextKind
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
    /** 显式指定模型角色（agentTool 子会话专用；primary/lightweight/reasoning） */
    modelRole?: ModelRole
    /**
     * 运行中注入的用户消息队列（Worker 内共享引用）
     * 新消息会 push 到此数组，每次 LLM 调用前检查并注入到 currentState
     */
    pendingInjectedMessages?: ChatMessage[]
}
