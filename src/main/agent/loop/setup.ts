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
import type {ToolContext, ToolDefinitionForLLM} from '../tools/types'
import type {ChatMessage} from '../model/types'
import type {RunParams, TurnModelSelection} from './types'
import type {LoopState as AgentLoopState} from '../state'
import type {AgentDefinition} from '@shared/agent'
import type {CommandExecutionContext, HClawAgentType} from '@shared/types'
import type {ModelRole, RunMode, WorkMode} from '@shared/types'
import type {ToolRegistry} from '../tools/registry'

import {container, DI_TOKENS} from '../common/container'
import {createLoopState} from '../state'
import {logger} from '../logger'
import {permissionEngine} from '../tools/permission'
import {permissionRulesManager} from '../permissions/permissionRule'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {extractTextContent} from '../utils/contentUtils'
import {setAgentToolConfig} from '../tools/builtin/agentTool'
import {setSkillToolConfig} from '../tools/builtin/skillTool'
import {filterToolsForAgent} from '../tools/filter'
import {filterToolsByAgentType, getAgentToolRestrictions} from '../agentTypes/configs'
import {buildSystemPrompt as buildSystemPromptBase} from '../systemPrompt'
import {renderSystemPrompt} from '../utils/promptRenderer'
import {getCurrentSchemeInfo} from '../model/index'
import {resolveModelConfig, selectModelForTaskWithRole} from '../model/modelSelector'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {getSchemeVersion} from '../model/modelSchemeManager'
import {getRoleDisplayName} from './helpers'
import {resolveEntityCommand} from '../entityCommandResolver'

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

    if (!messageContent.trim().startsWith('/')) {
        return {commandContext: null, isCompactCommand: false}
    }

    const spaceIndex = messageContent.indexOf(' ')
    const commandPart = spaceIndex === -1
        ? messageContent.trim()
        : messageContent.slice(0, spaceIndex).trim()

    const commandName = commandPart.slice(1)
    const commandArgs = spaceIndex === -1
        ? undefined
        : messageContent.slice(spaceIndex + 1).trim() || undefined

    if (!commandName) {
        return {commandContext: null, isCompactCommand: false}
    }

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

/**
 * 根据工作模式和意图分析结果选择模型
 * - auto 模式：意图分析为主，建议的模型未启用时 fallback 到 primary
 * - 其他模式：使用工作模式映射到对应角色
 * - 图片消息：loop 始终使用工作模式模型，图片分析由 analyze_image 内置工具调用视觉理解模型处理
 */
export function* selectModelForTurn(
    analysis: {suggestedModel: ModelRole; complexity: string},
    schemeConfig: RunParams['schemeConfig'],
): Generator<AgentStreamEvent, TurnModelSelection> {
    const currentWorkMode = runtimeConfigManager.getWorkMode()

    let suggestedRole: ModelRole = 'primary'
    let modelSelectionReason: string = ''

    if (currentWorkMode === 'auto') {
        suggestedRole = analysis.suggestedModel
        modelSelectionReason = `auto模式·意图分析:${analysis.complexity}`

        const currentScheme = runtimeConfigManager.getScheme()
        if (currentScheme) {
            const roleConfig = getRoleConfig(currentScheme, analysis.suggestedModel)
            if (!roleConfig?.enabled) {
                logger.info(`[AgentLoop] auto模式：意图建议的${analysis.suggestedModel}模型未启用，fallback到primary`)
                suggestedRole = 'primary'
                modelSelectionReason += '(fallback→primary)'
            }
        }
    } else {
        suggestedRole = runtimeConfigManager.getModelRoleForWorkMode()
        const currentScheme = runtimeConfigManager.getScheme()
        modelSelectionReason = `工作模式:${getRoleDisplayName(currentScheme, currentWorkMode)}`
    }

    logger.info(`[AgentLoop] 模型选择：${modelSelectionReason} → ${suggestedRole}`)

    let modelConfig = {provider: 'custom', model: ''} as import('../model/types').ModelConfig
    let schemeId: string | null = null
    let schemeName: string | null = null

    const schemeInfo = getCurrentSchemeInfo()
    if (schemeInfo.id && schemeInfo.name) {
        schemeId = schemeInfo.id
        schemeName = schemeInfo.name

        const currentScheme = runtimeConfigManager.getScheme()
        const providers = runtimeConfigManager.getProviders()
        if (currentScheme && providers.length > 0) {
            const roleResult = selectModelForTaskWithRole(currentScheme, 'main', {suggestedModel: suggestedRole})
            const resolved = resolveModelConfig(roleResult.config, providers)
            if (resolved) {
                modelConfig = resolved
            } else {
                logger.warn(`[AgentLoop] ${roleResult.role} 模型配置无法解析，fallback 到 primary`)
                const primaryResolved = resolveModelConfig(
                    selectModelForTaskWithRole(currentScheme, 'main', {suggestedModel: 'primary'}).config,
                    providers,
                )
                if (primaryResolved) modelConfig = primaryResolved
            }
            if (resolved && roleResult.role !== suggestedRole) {
                const warnMsg = `${modelSelectionReason}，实际使用「${getRoleDisplayName(currentScheme, roleResult.role)}」模型`
                logger.warn(`[AgentLoop] model-fallback: ${warnMsg}`)
                yield {type: 'warning', message: warnMsg}
            }
        }
    } else if (schemeConfig && schemeConfig.scheme && Array.isArray(schemeConfig.providers)) {
        const roleResult = selectModelForTaskWithRole(schemeConfig.scheme, 'main', {suggestedModel: suggestedRole})
        const resolved = resolveModelConfig(roleResult.config, schemeConfig.providers)
        if (resolved) {
            modelConfig = resolved
            schemeId = schemeConfig.scheme.id
            schemeName = schemeConfig.scheme.name
        }
        if (resolved && roleResult.role !== suggestedRole) {
            const warnMsg = `${modelSelectionReason}，实际使用「${getRoleDisplayName(schemeConfig.scheme, roleResult.role)}」模型`
            logger.warn(`[AgentLoop] model-fallback: ${warnMsg}`)
            yield {type: 'warning', message: warnMsg}
        }
    }

    return {modelConfig, schemeId, schemeName, suggestedRole}
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

// ─── 适配器状态检查 ────────────────────────────────────────

/**
 * 检查是否需要重建适配器
 */
export function checkAdapterNeedsRecreate(
    adapter: any,
    lastSchemeVersion: number | null,
    lastWorkMode: WorkMode,
): boolean {
    if (!adapter) return true
    const newVersion = getSchemeVersion().version
    if (lastSchemeVersion !== null && newVersion !== lastSchemeVersion) return true
    const currentWorkMode = runtimeConfigManager.getWorkMode()
    return lastWorkMode !== currentWorkMode
}

/**
 * 重建模型适配器
 */
export async function* recreateAdapter(
    params: RunParams,
    modelConfig: import('../model/types').ModelConfig,
    workModeRole: ModelRole,
): AsyncGenerator<AgentStreamEvent, {
    adapter: any
    providerType: string
    modelId: string
    configSource: string
    schemeName: string | null
}> {
    if (params.schemeUpdatePromise) {
        await params.schemeUpdatePromise()
    }

    let resolvedConfig = modelConfig
    try {
        const schemeInfo = getCurrentSchemeInfo()
        if (schemeInfo.id && schemeInfo.name) {
            const currentScheme = runtimeConfigManager.getScheme()
            const providers = runtimeConfigManager.getProviders()
            if (currentScheme && providers.length > 0) {
                const roleResult = selectModelForTaskWithRole(currentScheme, 'main', {suggestedModel: workModeRole})
                const resolved = resolveModelConfig(roleResult.config, providers)
                if (resolved) resolvedConfig = resolved
            }
        }
    } catch (resolveErr) {
        logger.warn(
            `[AgentLoop] re-resolve-model-config failed: ${(resolveErr as Error)?.message}, using existing config`,
        )
    }

    try {
        const {createAdapterForContext} = await import('../model/index')
        const result = await createAdapterForContext(
            'main',
            {suggestedModel: workModeRole as any},
            resolvedConfig,
        )
        return {
            adapter: result.adapter,
            providerType: result.providerType,
            modelId: result.modelId,
            configSource: result.configSource,
            schemeName: result.schemeName || null,
        }
    } catch (error) {
        const err = error as Error
        logger.error(`[AgentLoop] create-adapter-failed: ${err?.message}`)
        if (!resolvedConfig?.provider || !resolvedConfig?.model) {
            throw new Error('Cannot create adapter: no valid config.')
        }
        const {createModelAdapter} = await import('../model/index')
        return {
            adapter: createModelAdapter(resolvedConfig),
            providerType: resolvedConfig.provider,
            modelId: resolvedConfig.model,
            configSource: 'fallback',
            schemeName: null,
        }
    }
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
