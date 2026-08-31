/**
 * Agent 模板转换模块
 *
 * 将 AgentTemplate（注册表/配置层）转换为 AgentDefinition（运行时/过滤层）。
 * 被 agent 工具（子 Agent 派发）与 execution.ts（主会话命令模式）共用，
 * 保证两条路径的工具过滤行为一致。
 */

import type {AgentDefinition} from '@shared/agent'
import type {AgentTemplate} from '@shared/types'
import {agentRegistry} from './agentRegistry'

/**
 * 将 AgentTemplate 转换为 AgentDefinition
 *
 * source 使用 'user' 以确保 agent 工具不被 built-in 规则禁止。
 * AgentTemplate 没有 source 字段；built-in source 会额外禁止 agent 工具（防递归），
 * 本地 Agent 和插件 Agent 都不应该禁止 agent 工具，'user' 对所有场景安全。
 */
export function agentTemplateToDefinition(template: AgentTemplate): AgentDefinition {
    return {
        source: 'user',
        agentType: template.name,
        whenToUse: template.whenToUse || template.description || '',
        description: template.description || '',
        systemPromptTemplate: template.systemPrompt,
        renderedSystemPrompt: '',
        tools: template.allowedTools,
        disallowedTools: template.disallowedTools,
        tags: template.tags,
        model: template.model,
        permissionMode: template.permissionMode,
        maxTurns: template.maxTurns,
        isolation: template.isolation,
        requiredMcpServers: template.requiredMcpServers,
    }
}

/**
 * 从命令 ID（形如 "agent:xxx"）解析并构造 AgentDefinition。
 *
 * 用于主会话命令路径（Ctrl+K / /agent 命令）：命令模式下的工具过滤
 * 需要真实的 agentDefinition（tools/disallowedTools 白黑名单），否则
 * 会回退到 General 类型导致过滤失效（见设计文档 §2 根因分析）。
 *
 * 返回 undefined 表示该 commandId 不是 agent 命令、agent 不存在或已禁用，
 * 调用方应保持现状（不注入 agentDefinition）。
 */
export function resolveAgentDefinitionFromCommandId(
    commandId: string | undefined,
): AgentDefinition | undefined {
    if (!commandId || !commandId.startsWith('agent:')) return undefined
    const id = commandId.slice('agent:'.length)
    const template = agentRegistry.get(id) || agentRegistry.find(id)
    if (!template || !template.enabled) return undefined
    return agentTemplateToDefinition(template)
}

/**
 * 解析本轮应生效的 agentDefinition（优先本轮命令，其次缓存载荷跨轮携带的 commandId）。
 *
 * KV cache 一致性：agent: 命令轮的 agentDefinition 会收窄工具集；后续普通轮若退回
 * General 全量工具，tools 数组与前缀不一致 → prompt cache 在 tools 段断裂，cached_tokens
 * 归零（症状：命令轮后的第一条纯文本指令 0% 命中）。system prompt 缓存载荷记录了命令轮
 * commandId（controller 写入并跨轮携带），无新命令时从缓存恢复，使 tools 与命令轮一致——
 * 与 system 复用命令轮 prompt（cachedSystemPrompt core）的语义保持一致。
 *
 * @param messageCommandId 本轮消息携带的 commandId（Ctrl+K / /agent 命令），无则 undefined
 * @param cachedSystemPromptRaw DB system prompt 缓存原始 JSON（含 commandId），可能为 null
 */
export function resolveAgentDefinitionForTurn(
    messageCommandId: string | undefined,
    cachedSystemPromptRaw: string | null | undefined,
): AgentDefinition | undefined {
    const direct = resolveAgentDefinitionFromCommandId(messageCommandId)
    if (direct) return direct
    if (!cachedSystemPromptRaw) return undefined
    try {
        const cached = JSON.parse(cachedSystemPromptRaw)
        const commandId = cached?.commandId
        if (typeof commandId === 'string' && commandId.length > 0) {
            return resolveAgentDefinitionFromCommandId(commandId)
        }
    } catch {
        // 旧格式纯字符串缓存：无 commandId，保持 undefined
    }
    return undefined
}
