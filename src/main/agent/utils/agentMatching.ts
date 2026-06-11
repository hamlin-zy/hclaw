/**
 * Agent 匹配工具
 *
 * 提供统一的 Agent 匹配逻辑，支持精确匹配和模糊匹配
 */

import type {AgentDefinition, UserAgentDefinition} from '@shared/agent'
import {logger} from '../logger'

/**
 * Agent 匹配选项
 */
export interface AgentMatchOptions {
    /** 请求的 agent 类型 */
    requestedType: string

    /** 是否记录警告日志 */
    logWarning?: boolean

    /** 额外的可用类型列表（用于日志） */
    availableTypes?: string[]
}

/**
 * Agent 匹配结果
 */
export interface AgentMatchResult {
    /** 匹配的 Agent 定义，未找到为 undefined */
    agent: AgentDefinition | undefined

    /** 匹配方式 */
    matchType: 'exact' | 'name' | 'partial' | 'none'

    /** 匹配的字段名 */
    matchedField: 'agentType' | 'name' | 'filename' | null
}

/**
 * 获取 Agent 的可显示名称（用于匹配）
 */
function getAgentDisplayName(agent: AgentDefinition): string {
    if (agent.source === 'user') {
        // UserAgentDefinition 有 filename
        const userAgent = agent as UserAgentDefinition
        return userAgent.filename || agent.agentType
    }
    return agent.agentType
}

/**
 * 获取 Agent 的 ID（用于部分匹配）
 */
function getAgentId(agent: AgentDefinition): string {
    if (agent.source === 'user') {
        const userAgent = agent as UserAgentDefinition
        return userAgent.filename || agent.agentType
    }
    return agent.agentType
}

/**
 * 在 Agent 列表中查找匹配的 Agent
 *
 * 支持三种匹配方式（按优先级）：
 * 1. 精确匹配 agentType（忽略大小写）
 * 2. 精确匹配 filename（对于 user agents，忽略大小写）
 * 3. 部分匹配（包含匹配，忽略大小写）
 *
 * @param activeAgents 可用的 Agent 定义列表
 * @param options 匹配选项
 * @returns 匹配结果
 */
export function findAgentByType(
    activeAgents: AgentDefinition[],
    options: AgentMatchOptions,
): AgentMatchResult {
    const {requestedType, logWarning = true, availableTypes} = options
    const normalizedType = requestedType.toLowerCase()

    // 方式 1: 精确匹配 agentType
    let agent = activeAgents.find(a => a.agentType?.toLowerCase() === normalizedType)
    if (agent) {
        return {agent, matchType: 'exact', matchedField: 'agentType'}
    }

    // 方式 2: 精确匹配 filename（仅对 user agents）
    agent = activeAgents.find(a => {
        if (a.source !== 'user') return false
        const userAgent = a as UserAgentDefinition
        return userAgent.filename?.toLowerCase() === normalizedType
    })
    if (agent) {
        return {agent, matchType: 'exact', matchedField: 'filename'}
    }

    // 方式 3: 部分匹配（检查 agentType 或 filename 是否包含）
    agent = activeAgents.find(a => {
        const displayName = getAgentDisplayName(a)
        const id = getAgentId(a)
        return displayName.toLowerCase().includes(normalizedType)
            || id.toLowerCase().includes(normalizedType)
    })
    if (agent) {
        return {agent, matchType: 'partial', matchedField: 'filename'}
    }

    // 没有找到匹配，记录警告
    if (logWarning && activeAgents.length > 0) {
        const types = availableTypes ?? activeAgents.map(a => a.agentType)
        logger.warn('[AgentMatching] no exact match for agentType', {
            requestedType,
            availableTypes: types,
        })
    }

    return {agent: undefined, matchType: 'none', matchedField: null}
}

/**
 * 查找单个匹配的 Agent（简化版，不记录日志）
 *
 * @param activeAgents 可用的 Agent 定义列表
 * @param requestedType 请求的 agent 类型
 * @returns 匹配的 Agent，未找到为 undefined
 */
export function findAgentByTypeSimple(
    activeAgents: AgentDefinition[],
    requestedType: string,
): AgentDefinition | undefined {
    return findAgentByType(activeAgents, {
        requestedType,
        logWarning: false,
    }).agent
}

/**
 * 查找所有可能匹配的 Agent（用于 UI 建议）
 *
 * @param activeAgents 可用的 Agent 定义列表
 * @param query 搜索查询
 * @param limit 最大返回数量
 * @returns 匹配的 Agent 列表（按相关度排序）
 */
export function findSimilarAgents(
    activeAgents: AgentDefinition[],
    query: string,
    limit: number = 5,
): AgentDefinition[] {
    const normalizedQuery = query.toLowerCase()

    // 计算相关度分数
    const scored = activeAgents.map(agent => {
        let score = 0
        const displayName = getAgentDisplayName(agent)
        const id = getAgentId(agent)

        // agentType 匹配得最高分
        if (agent.agentType?.toLowerCase() === normalizedQuery) {
            score = 3
        } else if (agent.agentType?.toLowerCase().includes(normalizedQuery)) {
            score = 2
        }

        // displayName 匹配
        if (displayName.toLowerCase() === normalizedQuery) {
            score = Math.max(score, 2)
        } else if (displayName.toLowerCase().includes(normalizedQuery)) {
            score = Math.max(score, 1)
        }

        // id 包含
        if (id.toLowerCase().includes(normalizedQuery)) {
            score = Math.max(score, 0.5)
        }

        return {agent, score}
    })

    // 按分数降序排序并返回前 limit 个
    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.agent)
}
