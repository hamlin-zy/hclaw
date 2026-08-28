/**
 * Agent Loop — 核心推理循环
 *
 * 入口文件，委托给 AgentLoopController 处理
 *
 * AsyncGenerator 流式输出，while(true) 循环调用 LLM + 执行工具。
 * 工具执行前经权限引擎（permissionEngine）检查。
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
import type {HClawAgentType, ModelRole} from '@shared/types'
import type {LlmTraceContextKind} from '@shared/types/llmTrace'
import type {AgentDefinition} from '@shared/agent'
import {permissionEngine} from './tools/permission'
import {setAgentToolConfig} from './tools/builtin/agentTool'
import {setSkillToolConfig} from './tools/builtin/skillTool'
import {permissionRulesManager} from './permissions/permissionRule'
import {runtimeConfigManager} from './runtimeConfigManager'

// ─── 参数 ──────────────────────────────────────────────

export interface AgentLoopParams {
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
  /** LLM 归因来源（显式声明：main/subAgent/background；缺省回退 'main'） */
  traceContext?: LlmTraceContextKind
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
  /** 显式指定模型角色（agentTool 子会话专用；primary/lightweight/reasoning） */
  modelRole?: ModelRole
  /**
   * 运行中注入的用户消息队列（Worker 内共享引用）
   * 新消息会 push 到此数组，Controller 在每轮 LLM 调用前检查并注入到 currentState
   */
  pendingInjectedMessages?: ChatMessage[]
  /** LLM 循环检测静默指纹队列（渲染端"这是误判"经 worker 传入；gate 逐轮 shift 消费） */
  pendingSilences?: string[]
}

// ─── 模式切换事件 ────────────────────────────────────────

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
): AsyncGenerator<AgentStreamEvent | ModeChangeEvent> {
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
    modelRole,
    traceContext,
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

  // 创建 LLMCaller（adapter 管理；重试配置由 execute.ts 按 settings 读取）
  const llmCaller = new LLMCaller()

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
    // 传递运行中注入的用户消息队列
    pendingInjectedMessages: params.pendingInjectedMessages,
    // 传递 LLM 循环检测静默指纹队列
    pendingSilences: params.pendingSilences,
    modelRole,
    traceContext,
  })
}
