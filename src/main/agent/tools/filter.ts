/**
 * 工具过滤模块
 * 实现多层工具过滤链
 */

import type {AgentDefinition, AgentSource} from '@shared/agent'
import type {Tool} from './types'

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
])

/**
 * 工具名别名表：将 Claude Code / Codex 等外部平台的惯用工具名映射到 HClaw 实际工具名。
 *
 * 为什么需要：everything-claude-code 等插件中的 Agent 定义使用 Claude Code 的工具名约定
 * （如 Read / Write / Edit / Bash / Grep / Glob），与 HClaw 的实际工具名不一致。
 * 通过此别名表 + 忽略大小写的模糊匹配，子 Agent 无需手动传 tools 参数即可正常工作。
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  // Claude Code 命名约定 (key 统一小写，查找时忽略大小写)
  // 仅保留需要映射到不同名称的条目；与 HClaw 同名的工具由步骤1精确匹配或步骤3大小写忽略匹配覆盖
  'read': 'file_read',
  'write': 'file_write',
  'edit': 'file_edit',
}

/**
 * 将 Agent 定义中的工具名解析为 HClaw 实际工具名。
 *
 * 解析优先级：
 *   1. 精确匹配（HClaw 原生工具名，向后兼容）
 *   2. 别名表查找（Claude Code / Codex → HClaw）
 *   3. 忽略大小写模糊匹配（兜底）
 *
 * 返回 undefined 表示该工具名无法解析到任何已注册工具。
 */
function resolveToolName(
  specName: string,
  availableToolNames: string[],
): string | undefined {
  // 1. 精确匹配
  if (availableToolNames.includes(specName)) {
    return specName
  }

  // 2. 别名表查找（key 已统一小写，忽略输入大小写）
  const alias = TOOL_NAME_ALIASES[specName.toLowerCase()]
  if (alias && availableToolNames.includes(alias)) {
    return alias
  }

  // 3. 忽略大小写模糊匹配
  const lowerName = specName.toLowerCase()
  const match = availableToolNames.find(t => t.toLowerCase() === lowerName)
  return match
}

/**
 * 解析工具规范
 * 例如: "bash:always" → { toolName: "bash", rule: "always" }
 */
export interface ParsedToolSpec {
  toolName: string
  rule?: string
}

export function parseToolSpec(spec: string): ParsedToolSpec {
  const parts = spec.split(':')
  return {
    toolName: parts[0]!,
    rule: parts[1],
  }
}

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
