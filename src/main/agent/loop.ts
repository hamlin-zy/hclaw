/**
 * Agent Loop — 核心推理循环
 *
 * 入口文件，委托给 AgentLoopController 处理
 *
 * AsyncGenerator 流式输出，while(true) 循环调用 LLM + 执行工具。
 * Hook 系统在工具执行前后拦截，支持 beforeToolCall/afterToolCall。
 *
 * 模型方案支持：
 * - 优先从全局模型方案管理器获取配置（支持运行时动态切换）
 * - 如果全局管理器无配置，回退到参数中的 schemeConfig
 * - 如果 schemeConfig 也没有，使用 modelConfig 兜底
 */

import type {ChatMessage, ModelConfig} from './model/types'
import type {AgentStreamEvent} from './stream'
import {LLMCaller} from './loop/llmCaller'
import {ToolExecutor} from './loop/toolExecutor'
import {AgentLoopController} from './loop/controller'
import type {HClawAgentType, IntentAnalysisResult} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'
import type {ToolRegistry} from './tools/registry'
import type {SkillRegistryImpl} from './skills/registry'
import {container, DI_TOKENS} from './common/container'
import {permissionEngine} from './tools/permission'
import {setAgentToolConfig} from './tools/builtin/agentTool'
import {setSkillToolConfig} from './tools/builtin/skillTool'
import {permissionRulesManager} from './permissions/permissionRule'
import {runtimeConfigManager} from './runtimeConfigManager'

// ─── 参数 ──────────────────────────────────────────────

export interface AgentLoopParams {
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
  mcpServers?: import('@shared/types').MCPServer[]
  agentTemplates?: import('@shared/types').AgentTemplate[]
  requestConfirmation?: (message: string) => Promise<'allow' | 'always' | 'deny'>
  askUserQuestion?: (question: string, options?: string[], multiSelect?: boolean) => Promise<string>
  channelSend?: (channelId: string, toUser: string, text: string, contextToken?: string, fileType?: string) => Promise<{ success: boolean; error?: string }>
  conversationTitle?: string
  onEvent?: (event: any) => void
  /** 方案更新 Promise，用于在 LLM 调用前等待方案切换完成 */
  schemeUpdatePromise?: () => Promise<void>
  /** 新增：Agent 定义（支持动态 Agent 系统） */
  agentDefinition?: AgentDefinition
  /** 运行时配置引用（用于检查 pendingCompact 等状态） */
  runtimeConfig?: {
    pendingCompact?: boolean
    settings?: import('@shared/types').SystemSettings
  }
  /** 消息元数据（如命令模板等），用于 Agent Loop 识别命令模式 */
  messageMetadata?: Record<string, unknown>
  /**
   * Hook 执行后注入的额外上下文
   * 来自 SessionStart/UserPromptSubmit hook 的 additionalContext
   * 会注入到消息中（历史消息之后，用户消息之前），最大化缓存命中
   */
  hookAdditionalContext?: string
  /**
   * 运行中注入的用户消息队列（Worker 内共享引用）
   * 新消息会 push 到此数组，Controller 在每轮 LLM 调用前检查并注入到 currentState
   */
  pendingInjectedMessages?: ChatMessage[]
}

// ─── 意图分析事件 ────────────────────────────────────────

export interface IntentAnalyzedEvent {
    type: 'intent_analyzed'
    result: IntentAnalysisResult
}

export interface ModeChangeEvent {
    type: 'mode_change'
  mode: 'auto'
}

// ─── Agent Loop 入口 ───────────────────────────────────

/**
 * Agent Loop 主入口
 *
 * 委托给 AgentLoopController 处理，保留向后兼容的接口
 */
export async function* agentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentStreamEvent | IntentAnalyzedEvent | ModeChangeEvent> {
  const {
    messages: initialMessages,
    modelConfig,
    workingDir: initialWorkingDir,
    maxTurns = 500,
    customInstructions,
    skills,
    abortSignal,
    schemeConfig,
    agentType = 'General',
    agentTemplates,
    conversationTitle = '',
    onEvent,
    schemeUpdatePromise,
    agentDefinition,
    runtimeConfig,
    settings: initialSettings,
    requestConfirmation,
    askUserQuestion,
    channelSend,
    messageMetadata,
    hookAdditionalContext,
  } = params

  // 使用动态更新的 settings（而非解构时捕获的静态引用）
  const getSettings = () => runtimeConfig?.settings ?? initialSettings

  // 设置权限引擎的工作目录
  const workingDir = runtimeConfigManager.getWorkingDir() || initialWorkingDir || ''
  permissionEngine.setWorkingDir(workingDir)

  // 权限模式管理
  const initialPermissionContext = await permissionRulesManager.getContext()
  let currentPermissionMode: import('@shared/types').RunMode = initialPermissionContext.mode

  if (agentDefinition && agentDefinition.permissionMode) {
    const targetMode = agentDefinition.permissionMode
    if (targetMode !== currentPermissionMode) {
      await permissionRulesManager.applyUpdate({
        type: 'setMode',
        mode: targetMode
      })
      currentPermissionMode = targetMode
      yield {type: 'mode_change', mode: 'auto'}
    }
  }

  // 设置工具模块级配置
  setAgentToolConfig()
  setSkillToolConfig()

  // 创建 LLMCaller
  const llmCaller = new LLMCaller({
    maxRetries: getSettings()?.agent.retryCount ?? 10,
    initialDelay: getSettings()?.agent.initialRetryDelay ?? 5000,
    maxDelay: getSettings()?.agent.maxRetryDelay ?? 120_000,
  })

  // 创建 ToolExecutor
  const toolExecutor = new ToolExecutor()

  // 创建 Controller
  const controller = new AgentLoopController(llmCaller, toolExecutor)

  // 运行循环
  yield* controller.run({
    sessionId: params.sessionId,
    messages: initialMessages,
    modelConfig,
    settings: getSettings(),
    workingDir: initialWorkingDir,
    maxTurns,
    customInstructions,
    skills,
    abortSignal,
    schemeConfig,
    agentType,
    mcpServers: params.mcpServers,
    agentTemplates,
    requestConfirmation,
    askUserQuestion,
    channelSend,
    conversationTitle,
    onEvent,
    schemeUpdatePromise,
    agentDefinition,
    runtimeConfig,
    // 将消息元数据传递给 controller
    messageMetadata,
    // 传递 Hook additionalContext（SessionStart/UserPromptSubmit hook 返回）
    hookAdditionalContext,
    // 传递运行中注入的用户消息队列
    pendingInjectedMessages: params.pendingInjectedMessages,
  })
}
