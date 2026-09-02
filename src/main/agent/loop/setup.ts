/**
 * Agent 循环 — 运行前设置阶段
 *
 * 包含：
 * - 初始化运行环境（权限、工具配置）
 * - 命令上下文检测（/command 解析）
 * - 模型选择与适配器管理
 * - 工具过滤
 * - 系统提示词构建
 */

import type {AgentStreamEvent} from '../stream'
import type {ToolDefinitionForLLM} from '../tools/types'
import type {RunParams, TurnModelSelection} from './types'
import type {LoopState as AgentLoopState} from '../state'
import type {AgentDefinition} from '@shared/agent'
import type {CommandExecutionContext, HClawAgentType} from '@shared/types'
import {TEXT_MODEL_ROLES} from '@shared/types'
import type {ModelRole, RunMode} from '@shared/types'
import type {ModelOverride, ModelScheme, LLMProvider} from '@shared/types'
import type {ToolRegistry} from '../tools/registry'

import {container, DI_TOKENS} from '../common/container'
import {createLoopState} from '../state'
import {logger} from '../logger'
import {permissionEngine} from '../tools/permission'
import {permissionRulesManager} from '../permissions/permissionRule'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {extractTextContent} from '../utils/contentUtils'
import {parseCommandText} from './commandTextParser'
import {setAgentToolConfig} from '../tools/builtin/agentTool'
import {setSkillToolConfig} from '../tools/builtin/skillTool'
import {filterToolsForAgent} from '../tools/filter'
import {filterToolsByAgentType, getAgentToolRestrictions} from '../agentTypes/configs'
import {supportsImageInput} from '../modelCapability'
import {buildSystemPrompt as buildSystemPromptBase} from '../systemPrompt'
import {resolveModelConfig, resolveDirectModelConfig, selectModelForTaskWithRole} from '../model/modelSelector'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {resolveOverrideThinkingEffort} from '@shared/thinkingEffort'
import {getRoleDisplayName} from './helpers'
import {resolveEntityCommand} from '../entityCommandResolver'
import {createConversationRepository} from '../../repositories'

const toolRegistry: ToolRegistry = container.get<ToolRegistry>(DI_TOKENS.ToolRegistry)

// ─── 阶段 1：初始化运行环境 ────────────────────────────────

/**
 * 初始化 Agent 循环的运行环境
 * - 创建循环状态（loop state）
 * - 设置工作目录和权限引擎
 * - 设置权限模式（含 agentDefinition 覆盖）
 * - 设置工具模块级配置
 */
export async function* initializeRunEnvironment(
    params: RunParams,
): AsyncGenerator<AgentStreamEvent, {
    state: AgentLoopState
    getSettings: () => import('@shared/types').SystemSettings | undefined
    workingDir: string
}> {
    const {runtimeConfig, settings: initialSettings, agentDefinition} = params

    const getSettings = () => runtimeConfig?.settings ?? initialSettings
    const state = createLoopState(params.messages || [])
    const workingDir = runtimeConfigManager.getWorkingDir() || params.workingDir || ''

    permissionEngine.setWorkingDir(workingDir)

    const initialPermissionContext = await permissionRulesManager.getContext()
    let currentPermissionMode: RunMode = initialPermissionContext.mode

    if (agentDefinition?.permissionMode && agentDefinition.permissionMode !== currentPermissionMode) {
        await permissionRulesManager.applyUpdate({
            type: 'setMode',
            mode: agentDefinition.permissionMode,
        })
        yield {type: 'mode_change', mode: 'auto'}
    }

    setAgentToolConfig()
    setSkillToolConfig()

    return {state, getSettings, workingDir}
}

// ─── 阶段 2：检测命令执行上下文 ─────────────────────────────

/**
 * 检测用户消息是否以 / 开头，如果是则解析命令名和参数
 *
 * 简化方案：不需要 metadata，直接检查消息内容
 * - 检查最后一条用户消息是否以 / 开头
 * - 截取 / 到第一个空格之间的内容作为命令名
 * - 匹配现有的 agent/skill/command
 *
 * 注：/compact 命令及所有上下文压缩功能已移除（决策 2026-08，压缩相关代码已清理）。
 */
export async function detectCommandContext(params: RunParams): Promise<{
    commandContext: CommandExecutionContext | null
}> {
    const {messages: initialMessages, onEvent} = params

    if (!initialMessages || initialMessages.length === 0) {
        return {commandContext: null}
    }

    // 从后往前找最后一条 user 消息
    let lastUserMessage: typeof initialMessages[0] | null = null
    for (let i = initialMessages.length - 1; i >= 0; i--) {
        if (initialMessages[i].role === 'user') {
            lastUserMessage = initialMessages[i]
            break
        }
    }

    if (!lastUserMessage) {
        return {commandContext: null}
    }

    const messageContent = extractTextContent(lastUserMessage.content)

    // 解析命令文本（纯函数，见 commandTextParser.ts；支持换行/空格两种分隔）
    const parsed = parseCommandText(messageContent)
    if (!parsed) return {commandContext: null}
    const {commandName, commandArgs} = parsed

    // 辅助：统一构建 CommandExecutionContext + 日志 + 事件
    const emitCommandStart = (
        commandId: string,
        template: string,
        logSuffix: string,
    ): { commandContext: CommandExecutionContext } => {
        const commandContext: CommandExecutionContext = {
            commandId,
            commandName,
            commandArgs,
            commandTemplate: template,
        }
        logger.info(`[AgentLoop] command mode${logSuffix}: /${commandName} ${commandArgs || ''}`)
        if (onEvent) {
            onEvent({
                type: 'command_start',
                commandId,
                commandName,
                commandArgs,
            })
        }
        return {commandContext}
    }

    // 直接调用 CommandDispatcher 解析命令（不需要 IPC）
    try {
        const {CommandDispatcher} = await import('../../plugin/commands')
        const dispatcher = CommandDispatcher.getInstance()
        await dispatcher.refresh()

        const result = dispatcher.prepareMessageByName(commandName, commandArgs)

        if (result && result.template && result.commandId) {
            return emitCommandStart(result.commandId, result.template, '')
        }

        // ★ 兜底：skill / agent 注册表（复用 entityCommandResolver，与 ipc.ts 一致）
        const entityResult = resolveEntityCommand(commandName)
        if (entityResult) {
            // 实体命令（skill/agent）不发 command_start 事件——它们的执行状态由
            // skill_start/skill_end 事件驱动的 SkillBubble 展示，避免与 CommandBadge 重复。
            logger.info(`[AgentLoop] command mode (entity): /${commandName} ${commandArgs || ''}`)
            return {
                commandContext: {
                    commandId: entityResult.commandId,
                    commandName,
                    commandArgs,
                    commandTemplate: entityResult.template,
                },
            }
        }
    } catch (err) {
        logger.warn(`[AgentLoop] failed to resolve command /${commandName}:`, {error: String(err)})
    }

    return {commandContext: null}
}

// ─── 模型选择 ──────────────────────────────────────────────

/** 沿 parentConvId 链向上查找最近的有效 override（agentTool 子会话继承父会话） */
function findEffectiveOverride(convId: string): ModelOverride | null {
    const repo = createConversationRepository()
    let current = convId
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
        visited.add(current)
        const ov = runtimeConfigManager.getOverride(current)
        if (ov) return ov
        try {
            const meta = repo.readMeta(current) as { parentConvId?: string } | null
            current = meta?.parentConvId || ''
        } catch {
            return null
        }
    }
    return null
}

/**
 * 根据「显式 modelRole → 会话 override → 默认 primary」三级决策选择模型
 * - 显式 modelRole（agentTool 子会话）：仅 3 文本角色且方案角色已启用配置才生效
 * - 会话 override：绕过角色直接解析该模型（directModel），失效则降级默认 primary + warning
 * - 默认：primary 角色（fallback 链 primary→lightweight→reasoning，见 modelSelector）
 * - 图片消息：loop 始终使用当前决策模型，图片分析由 analyze_image 内置工具调用视觉理解模型处理
 */
/**
 * 未显式指定 modelRole 时的默认起始角色：
 * 主会话 primary；agentTool 子会话（traceContext='subAgent'）lightweight。
 */
export function defaultRoleForTrace(traceContext?: string): ModelRole {
    return traceContext === 'subAgent' ? 'lightweight' : 'primary'
}

export function* selectModelForTurn(
    schemeConfig: RunParams['schemeConfig'],
    sessionId?: string,
    modelRoleOverride?: ModelRole,
    defaultRole: ModelRole = 'primary',
): Generator<AgentStreamEvent, TurnModelSelection> {
    const currentScheme = runtimeConfigManager.getScheme() || (schemeConfig?.scheme as ModelScheme | undefined) || null
    // 单次调用缓存（避免重复 getProviders()）：runtime 优先、schemeConfig 兜底（与原实现双路径等价）
    const runtimeProviders = runtimeConfigManager.getProviders()
    const providers: LLMProvider[] = runtimeProviders.length > 0
        ? runtimeProviders
        : ((schemeConfig?.providers as LLMProvider[] | undefined) || [])

    // ── 0. 显式 modelRole（agentTool 子会话）：仅文本角色且方案角色已启用配置才生效 ──
    if (modelRoleOverride && TEXT_MODEL_ROLES.includes(modelRoleOverride)) {
        const roleConfig = currentScheme && getRoleConfig(currentScheme, modelRoleOverride)
        if (roleConfig?.enabled && roleConfig.endpointId && roleConfig.modelId && providers.length > 0) {
            const resolved = resolveModelConfig(roleConfig, providers)
            if (resolved) {
                return {
                    modelConfig: resolved,
                    schemeId: currentScheme?.id || null,
                    schemeName: currentScheme?.name || null,
                    suggestedRole: modelRoleOverride,
                    providerName: resolved._providerName,
                    providerId: resolved._providerId,
                }
            }
        }
        // 校验降级：角色未启用/未配置 → 落入后续步骤
    }

    // ── 1. 会话 override（子会话沿父链继承）──
    const override = sessionId ? findEffectiveOverride(sessionId) : null
    if (override) {
        if (providers.length > 0) {
            // 会话级思考强度：override 显式值 → 方案角色匹配继承 → auto 兜底
            const effort = resolveOverrideThinkingEffort(override, currentScheme)
            const direct = resolveDirectModelConfig(override.endpointId, override.modelId, providers, effort)
            if (direct) {
                return {
                    modelConfig: direct,
                    schemeId: currentScheme?.id || null,
                    schemeName: currentScheme?.name || null,
                    suggestedRole: 'primary' as ModelRole, // 占位：override 不经角色
                    directModel: true,
                    providerName: direct._providerName,
                    providerId: direct._providerId,
                }
            }
        }
        // override 失效（服务商/模型已删除或禁用）→ 降级默认 primary + warning
        logger.warn(`[AgentLoop] 会话模型 override 失效（${override.endpointId}/${override.modelId}），降级默认 primary`)
        yield {type: 'warning', message: '会话指定的模型已失效，已切换为主力模型'}
    }

    // ── 2. 默认：按 defaultRole 起始的降级链选择 ──
    // - 主会话默认 primary（P→L→R）；agentTool 子会话（未显式 modelRole）默认 lightweight（L→P→R）
    // - 显式 modelRole 未生效（角色未启用/未配置）时同样按其起始角色降级（如 R→P→L）
    const requestedRole: ModelRole = modelRoleOverride ?? defaultRole
    let suggestedRole: ModelRole = requestedRole
    const modelSelectionReason = modelRoleOverride
        ? `显式角色 ${suggestedRole} 未生效，按其降级链选择`
        : `默认 ${defaultRole === 'lightweight' ? '轻量模型(lightweight)' : '主力模型(primary)'}（降级链起始）`

    logger.info(`[AgentLoop] 模型选择：${modelSelectionReason} → ${suggestedRole}`)

    let modelConfig = {provider: 'custom', model: ''} as import('../model/types').ModelConfig
    let schemeId: string | null = null
    let schemeName: string | null = null

    if (currentScheme && providers.length > 0) {
        const roleResult = selectModelForTaskWithRole(currentScheme, 'main', {suggestedModel: suggestedRole})
        const resolved = resolveModelConfig(roleResult.config, providers)
        if (resolved) {
            modelConfig = resolved
            schemeId = currentScheme.id
            schemeName = currentScheme.name
            // suggestedRole 标注实际生效角色（降级后与请求角色不同）
            suggestedRole = roleResult.role
        } else {
            // selectModelForTaskWithRole 已含 fallback 链；此处兜底（provider 缺失等）
            logger.warn(`[AgentLoop] ${roleResult.role} 模型配置无法解析，尝试 primary`)
            const primaryResolved = resolveModelConfig(
                selectModelForTaskWithRole(currentScheme, 'main', {suggestedModel: 'primary'}).config,
                providers,
            )
            if (primaryResolved) modelConfig = primaryResolved
        }
        if (resolved && roleResult.role !== suggestedRole) {
            const warnMsg = `${modelSelectionReason}，实际使用「${getRoleDisplayName(roleResult.role)}」模型`
            logger.warn(`[AgentLoop] model-fallback: ${warnMsg}`)
            yield {type: 'warning', message: warnMsg}
        }
    }

    return {modelConfig, schemeId, schemeName, suggestedRole, providerName: modelConfig._providerName, providerId: modelConfig._providerId}
}

// ─── 工具过滤 ──────────────────────────────────────────────

/**
 * ★ 400 降级专用：能力过滤前、白名单后的完整工具列表。
 * 封装 filterTools 的 agent/type 过滤（不含能力过滤），供降级恢复。
 */
export async function filterToolsForDegrade(
    agentDefinition: AgentDefinition | undefined,
    agentType: string,
): Promise<ToolDefinitionForLLM[]> {
    let availableToolDefinitions = await toolRegistry.getToolDefinitions()

    if (agentDefinition) {
        const allTools = toolRegistry.getAll()
        const filteredTools = filterToolsForAgent(agentDefinition, allTools)
        const filteredToolNames = new Set(filteredTools.map(t => t.name))
        availableToolDefinitions = availableToolDefinitions.filter(def => filteredToolNames.has(def.name))
    } else {
        const toolRestrictions = getAgentToolRestrictions(agentType as HClawAgentType)
        availableToolDefinitions = filterToolsByAgentType(availableToolDefinitions, toolRestrictions)
    }

    return availableToolDefinitions
}

/**
 * 获取并过滤工具列表
 * - agentDefinition 模式：按 agent 工具配置过滤
 * - 普通模式：按 agentType 限制过滤
 * - ★ 能力驱动过滤：主模型支持图片输入时，analyze_image 无需暴露（图片直达主模型）
 * @param baseTools 已完成的 agent/type 过滤结果（filterToolsForDegrade 输出），
 *   传入可避免重复获取工具定义与过滤（controller 同时需要两版列表）
 */
export async function filterTools(
    agentDefinition: AgentDefinition | undefined,
    agentType: string,
    modelId: string,
    baseTools?: ToolDefinitionForLLM[],
): Promise<ToolDefinitionForLLM[]> {
    const preCapability = baseTools ?? await filterToolsForDegrade(agentDefinition, agentType)

    // ★ 能力驱动过滤（精确名匹配，不误伤 MCP 前缀工具）
    if (supportsImageInput(modelId)) {
        return preCapability.filter(d => d.name !== 'analyze_image')
    }

    return preCapability
}

// ─── 系统提示词构建 ────────────────────────────────────────

export interface BuildSystemPromptParams {
    commandContext: CommandExecutionContext | null
    agentDefinition: AgentDefinition | undefined
    workingDir: string
    availableToolDefinitions: ToolDefinitionForLLM[]
    currentPermissionMode: RunMode
    customInstructions: string | undefined
    agentType: string
    agentTemplates: import('@shared/types').AgentTemplate[] | undefined
    /** 数据库缓存的系统提示词，无新指令时直接复用，跳过完整构建 */
    cachedSystemPrompt?: string | null
    /**
     * 当前 system 签名（f(workingDir, agentType, agentDefinition, customInstructions)），
     * 由 controller 计算并写入缓存载荷。缓存复用守卫：签名一致才复用。
     */
    cacheSignature?: string | null
    /** 缓存载荷中记录的构建时签名；与 cacheSignature 不一致 → 强制重建 */
    cachedSignature?: string | null
}

export async function buildSystemPrompt(params: BuildSystemPromptParams): Promise<string> {
    const {
        commandContext,
        agentDefinition,
        workingDir,
        availableToolDefinitions,
        currentPermissionMode,
        customInstructions,
        agentType,
        agentTemplates,
        cachedSystemPrompt,
        cacheSignature,
        cachedSignature,
    } = params

    // ★ 缓存命中：无新命令、DB 有缓存、且 system 签名（agentType / agentDefinition /
    //   customInstructions / workingDir）与缓存构建时一致 → 跳过整个构建。
    //   日期/权限模式已移出 system，签名不含它们，system 可跨天、跨权限模式复用。
    if (!commandContext && cachedSystemPrompt && cacheSignature != null && cacheSignature === cachedSignature) {
        logger.info('[AgentLoop] cache hit: reusing cached system prompt')
        return cachedSystemPrompt
    }

    // ★ 缓存稳定：system 文本与当前命令类型无关。命令模板（含 agent: 命令）
    //   一律通过 CT 用户消息（buildCommandTaskContent）注入消息流，不得提升进
    //   system 参数——否则会改变 anthropicAdapter 唯一 cache_control 断点的
    //   system 内容，导致供应商前缀缓存命中率归零。
    // 通用稳定 base system；命令类与其共用（system 文本与命令类型无关）。
    // 仅定义一次，两处复用，避免调用参数重复。
    // agentTypeOverride：agentDefinition 路径强制 'General'（agent 专属模板由 CT
    // 消息承载，见 controller），保证 system 与切换的 agent 无关 → 前缀缓存稳定。
    const buildBase = (agentTypeOverride?: string) => buildSystemPromptBase({
        workingDir,
        tools: availableToolDefinitions,
        permissionMode: currentPermissionMode,
        customInstructions,
        agentType: (agentTypeOverride ?? agentType) as HClawAgentType,
        agentTemplates,
        taskDescription: '',
    })

    if (commandContext) {
        logger.info('[AgentLoop] command + stable base system context (template sent via CT message)')
        return buildBase()
    }

    if (agentDefinition) {
        // ★ 方案 A：不再把 agentDefinition.systemPromptTemplate 渲染进 system——
        // system 收敛到稳定 base（与 commandContext/兜底一致），agent 专属模板
        // 由 controller 以 <command-task> 用户消息注入。切换 agent 不再破坏
        // anthropicAdapter 唯一 cache_control 断点（system[0]）。
        logger.info('[AgentLoop] agentDefinition + stable base system (template sent via CT message)')
        return buildBase('General')
    }

    return buildBase()
}
