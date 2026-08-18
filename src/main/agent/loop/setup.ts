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
import {buildSystemPrompt as buildSystemPromptBase} from '../systemPrompt'
import {renderSystemPrompt} from '../utils/promptRenderer'
import {resolveModelConfig, resolveDirectModelConfig, selectModelForTaskWithRole} from '../model/modelSelector'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
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
 * 注：/compact 命令已移除（决策：完全移除所有压缩功能），isCompactCommand 始终为 false。
 */
export async function detectCommandContext(params: RunParams): Promise<{
    commandContext: CommandExecutionContext | null
    isCompactCommand: boolean
}> {
    const {messages: initialMessages, onEvent} = params

    if (!initialMessages || initialMessages.length === 0) {
        return {commandContext: null, isCompactCommand: false}
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
        return {commandContext: null, isCompactCommand: false}
    }

    const messageContent = extractTextContent(lastUserMessage.content)

    // 解析命令文本（纯函数，见 commandTextParser.ts；支持换行/空格两种分隔）
    const parsed = parseCommandText(messageContent)
    if (!parsed) return {commandContext: null, isCompactCommand: false}
    const {commandName, commandArgs} = parsed

    // 辅助：统一构建 CommandExecutionContext + 日志 + 事件
    const emitCommandStart = (
        commandId: string,
        template: string,
        logSuffix: string,
        isCompactCommand: boolean,
    ): { commandContext: CommandExecutionContext; isCompactCommand: boolean } => {
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
        return {commandContext, isCompactCommand}
    }

    // 直接调用 CommandDispatcher 解析命令（不需要 IPC）
    try {
        const {CommandDispatcher} = await import('../../plugin/commands')
        const dispatcher = CommandDispatcher.getInstance()
        await dispatcher.refresh()

        const result = dispatcher.prepareMessageByName(commandName, commandArgs)

        if (result && result.template && result.commandId) {
            return emitCommandStart(result.commandId, result.template, '', false)
        }

        // ★ 兜底：skill / agent 注册表（复用 entityCommandResolver，与 ipc.ts 一致）
        const entityResult = resolveEntityCommand(commandName)
        if (entityResult) {
            return emitCommandStart(entityResult.commandId, entityResult.template, ' (entity)', false)
        }
    } catch (err) {
        logger.warn(`[AgentLoop] failed to resolve command /${commandName}:`, {error: String(err)})
    }

    return {commandContext: null, isCompactCommand: false}
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
 * 根据「显式 modelRole → 会话 override → auto 意图分析」三级决策选择模型
 * - 显式 modelRole（agentTool 子会话）：仅 3 文本角色且方案角色已启用配置才生效
 * - 会话 override：绕过角色直接解析该模型（directModel），失效则降级 auto + warning
 * - auto：意图分析为主，建议的模型未启用时 fallback 到 primary
 * - 图片消息：loop 始终使用工作模式模型，图片分析由 analyze_image 内置工具调用视觉理解模型处理
 */
export function* selectModelForTurn(
    analysis: {suggestedModel: ModelRole; complexity: string},
    schemeConfig: RunParams['schemeConfig'],
    sessionId?: string,
    modelRoleOverride?: ModelRole,
): Generator<AgentStreamEvent, TurnModelSelection> {
    const currentScheme = runtimeConfigManager.getScheme() || (schemeConfig?.scheme as ModelScheme | undefined) || null
    // 单次调用缓存（避免重复 getProviders()）：runtime 优先、schemeConfig 兜底（与原实现双路径等价）
    const runtimeProviders = runtimeConfigManager.getProviders()
    const providers: LLMProvider[] = runtimeProviders.length > 0
        ? runtimeProviders
        : ((schemeConfig?.providers as LLMProvider[] | undefined) || [])

    // ── 0. 显式 modelRole（agentTool 子会话）：仅 3 文本角色且方案角色已启用配置才生效 ──
    if (modelRoleOverride && ['primary', 'lightweight', 'reasoning'].includes(modelRoleOverride)) {
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
                }
            }
        }
        // 校验降级：角色未启用/未配置 → 落入后续步骤
    }

    // ── 1. 会话 override（子会话沿父链继承）──
    const override = sessionId ? findEffectiveOverride(sessionId) : null
    if (override) {
        if (providers.length > 0) {
            const direct = resolveDirectModelConfig(override.endpointId, override.modelId, providers)
            if (direct) {
                return {
                    modelConfig: direct,
                    schemeId: currentScheme?.id || null,
                    schemeName: currentScheme?.name || null,
                    suggestedRole: 'primary' as ModelRole, // 占位：override 不经角色
                    directModel: true,
                    providerName: direct._providerName,
                }
            }
        }
        // override 失效（服务商/模型已删除或禁用）→ 降级 auto + warning
        logger.warn(`[AgentLoop] 会话模型 override 失效（${override.endpointId}/${override.modelId}），降级 auto`)
        yield {type: 'warning', message: '会话指定的模型已失效，已切换为自动模式'}
    }

    // ── 2. auto 意图分析（移除手动分支，恒走 auto）──
    let suggestedRole: ModelRole = analysis.suggestedModel
    let modelSelectionReason = `auto模式·意图分析:${analysis.complexity}`

    if (currentScheme) {
        const roleConfig = getRoleConfig(currentScheme, analysis.suggestedModel)
        if (!roleConfig?.enabled) {
            logger.info(`[AgentLoop] auto模式：意图建议的${analysis.suggestedModel}模型未启用，fallback到primary`)
            suggestedRole = 'primary'
            modelSelectionReason += '(fallback→primary)'
        }
    }

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
        } else {
            logger.warn(`[AgentLoop] ${roleResult.role} 模型配置无法解析，fallback 到 primary`)
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

    return {modelConfig, schemeId, schemeName, suggestedRole, providerName: modelConfig._providerName}
}

// ─── 工具过滤 ──────────────────────────────────────────────

/**
 * 获取并过滤工具列表
 * - agentDefinition 模式：按 agent 工具配置过滤
 * - 普通模式：按 agentType 限制过滤
 */
export async function filterTools(
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
    isCompactCommand: boolean
    /** 数据库缓存的系统提示词，无新指令时直接复用，跳过完整构建 */
    cachedSystemPrompt?: string | null
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
        isCompactCommand,
        cachedSystemPrompt,
    } = params

    const availToolNames = availableToolDefinitions.map(def => def.name)

    // ★ 缓存命中：无新命令且 DB 有缓存 → 跳过整个构建
    if (!commandContext && !isCompactCommand && cachedSystemPrompt) {
        logger.info('[AgentLoop] cache hit: reusing cached system prompt')
        return cachedSystemPrompt
    }

    if (isCompactCommand && commandContext) {
        logger.info('[AgentLoop] compact command: overrode systemPrompt with compact template only')
        return commandContext.commandTemplate
    }

    if (commandContext) {
        const isAgentCommand = commandContext.commandId.startsWith('agent:')
        if (isAgentCommand) {
            const envInfo = [
                '## 环境信息',
                `- **工作目录**: ${workingDir}`,
                `- **权限模式**: ${currentPermissionMode}`,
                ...(availToolNames.length > 0 ? [`- **可用工具**: ${availToolNames.join(', ')}`] : []),
            ].join('\n')
            const prompt = `${commandContext.commandTemplate}\n\n${envInfo}`
            logger.info('[AgentLoop] agent command + minimal context')
            return customInstructions ? `${prompt}\n\n## 自定义指令\n\n${customInstructions}` : prompt
        } else {
            const basePrompt = await buildSystemPromptBase({
                workingDir,
                tools: availableToolDefinitions,
                permissionMode: currentPermissionMode,
                customInstructions,
                agentType: agentType as HClawAgentType,
                agentTemplates,
                taskDescription: '',
            })
            logger.info('[AgentLoop] command + full system context (template sent as separate block)')
            return basePrompt
        }
    }

    if (agentDefinition) {
        const prompt = renderSystemPrompt(agentDefinition.systemPromptTemplate, {
            availableTools: availToolNames,
            permissionMode: currentPermissionMode,
            workingDir,
            agentType: agentDefinition.agentType,
        })
        return customInstructions ? `${prompt}\n\n${customInstructions}` : prompt
    }

    return buildSystemPromptBase({
        workingDir,
        tools: availableToolDefinitions,
        permissionMode: currentPermissionMode,
        customInstructions,
        agentType: agentType as HClawAgentType,
        agentTemplates,
        taskDescription: '',
    })
}
