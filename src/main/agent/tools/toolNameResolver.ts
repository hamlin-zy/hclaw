/**
 * 工具名解析模块
 *
 * 将 Claude Code / Codex 等外部平台的惯用工具名映射到 HClaw 实际工具名。
 * 被 filterToolsForAgent（agent 级过滤）与 filterToolsByAgentType（类型级过滤）共用。
 *
 * 为什么需要：everything-claude-code 等插件中的 Agent 定义使用 Claude Code 的工具名约定
 * （如 Read / Write / Edit / Bash / Grep / Glob），与 HClaw 的实际工具名不一致。
 */

/**
 * 工具名别名表：key 统一小写，查找时忽略输入大小写。
 * 仅保留需要映射到不同名称的条目；与 HClaw 同名的工具由 resolveToolName 的
 * 精确匹配或大小写忽略匹配覆盖。
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  'read': 'file_read',
  'write': 'file_write',
  'edit': 'file_edit',
  'notebookedit': 'notebook_edit',
  'todowrite': 'task_create',
  'todoread': 'task_list',
  'todoupdate': 'task_update',
  'task': 'agent',
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
export function resolveToolName(
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
