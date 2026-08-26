/**
 * 工具过滤模块
 * 实现多层工具过滤链
 */

import type {AgentDefinition, AgentSource} from '@shared/agent'
import type {Tool} from './types'
import {resolveToolName, parseToolSpec} from './toolNameResolver'

export {parseToolSpec} from './toolNameResolver'

/**
 * 全局工具黑名单（所有 Agent 都不能使用）
 */
const GLOBAL_DISALLOWED_TOOLS = new Set<string>([
  'Skill',        // 技能工具由主 Agent 管理
])

/**
 * Built-in Agent 工具黑名单
 */
const BUILTIN_AGENT_DISALLOWED_TOOLS = new Set<string>([
  'agent',        // Built-in Agent 不能使用 Agent 工具（防止无限递归）
  'list_agents',  // F1：built-in 子代理不能委派，发现工具亦无意义
])

/**
 * 根据来源获取工具黑名单
 */
function getDisallowedToolsBySource(source: AgentSource): Set<string> {
  if (source === 'built-in') {
    return BUILTIN_AGENT_DISALLOWED_TOOLS
  }
  return new Set()
}

/**
 * 过滤工具列表
 * 多层过滤：全局 → Agent 类型 → Agent 黑名单 → Agent 白名单
 */
export function filterToolsForAgent(
  agent: AgentDefinition,
  availableTools: Tool[]
): Tool[] {
  // 第 1 层：全局黑名单
  let filtered = availableTools.filter(tool =>
    !GLOBAL_DISALLOWED_TOOLS.has(tool.name)
  )

  // 第 2 层：Agent 类型黑名单
  const sourceDisallowed = getDisallowedToolsBySource(agent.source)
  filtered = filtered.filter(tool =>
    !sourceDisallowed.has(tool.name)
  )

  // 预计算可用工具名列表，供 resolveToolName 使用
  const availableToolNames = filtered.map(t => t.name)

  // 第 3 层：Agent 级别黑名单
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    const disallowedSet = new Set(
      agent.disallowedTools
        .map(spec => resolveToolName(parseToolSpec(spec).toolName, availableToolNames))
        .filter((name): name is string => name !== undefined)
    )
    if (disallowedSet.size > 0) {
      filtered = filtered.filter(tool =>
        !disallowedSet.has(tool.name)
      )
    }
  }

  // 第 4 层：Agent 级别白名单
  if (agent.tools && agent.tools.length > 0) {
    // 检查是否为通配符
    if (agent.tools.length === 1 && agent.tools[0] === '*') {
      return filtered
    }

    const allowedSet = new Set(
      agent.tools
        .map(spec => resolveToolName(parseToolSpec(spec).toolName, availableToolNames))
        .filter((name): name is string => name !== undefined)
    )
    // 只有至少解析到一个有效工具时才过滤（全部解析失败 = 不注入任何工具，与旧行为一致）
    filtered = filtered.filter(tool =>
      allowedSet.has(tool.name)
    )
  }

  return filtered
}

/**
 * 解析工具列表（用于生成提示词）
 */
export function resolveToolNames(agent: AgentDefinition, availableTools: Tool[]): string[] {
  const filteredTools = filterToolsForAgent(agent, availableTools)
  return filteredTools.map(t => t.name)
}

/**
 * 格式化工具列表为可读字符串
 */
export function formatToolsForPrompt(tools: string[]): string {
  if (tools.length === 0) return '无'

  return tools.map(tool => {
    // 简化工具名称（移除 mcp__ 前缀）
    const name = tool.replace(/^mcp__/, '')
    return `- ${name}`
  }).join('\n')
}
