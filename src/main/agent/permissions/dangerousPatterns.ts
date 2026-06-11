/**
 * 危险权限检测模块
 *
 * 参考Claude Code的危险权限检测机制：
 * - isDangerousBashPermission: 检测Bash工具的危险解释器模式
 * - isDangerousAgentPermission: 检测Agent工具的任意allow规则
 * - findDangerousPermissions: 查找所有危险规则
 *
 * 目的：防止Auto模式下自动批准危险操作绕过安全检查
 *
 * 设计简化：
 * - 不支持PowerShell（HClaw暂未实现）
 * - 保持单一规则源
 */

import type { PermissionRule, DangerousPermissionInfo } from '@shared/types'

/**
 * 危险Bash命令解释器模式
 * 参考CC的DANGEROUS_BASH_PATTERNS
 *
 * 这些模式允许执行任意代码，绕过classifier的安全评估
 */
const DANGEROUS_BASH_INTERPRETERS = [
  // Python相关
  'python', 'python3', 'python3.*',
  // Node.js相关
  'node', 'node.*',
  'npm', 'npx',
  // Ruby相关
  'ruby', 'ruby.*',
  'gem',
  // Perl相关
  'perl', 'perl.*',
  'cpan',
  // PHP相关
  'php', 'php.*',
  'composer',
  // Go相关
  'go', 'go.*',
  'go.*run',
  // Rust相关
  'rustc', 'cargo',
  'cargo.*run',
  // Java相关
  'java', 'java.*',
  'javac',
  // 包管理器
  'pip', 'pip3', 'pip3.*',
  // 任意代码执行
  'eval',
  'exec',
]

/**
 * 危险命令模式
 * 检测Shell命令中的危险模式。
 *
 * 单一真相源：此数组是系统中唯一的 DANGEROUS_COMMAND_PATTERNS 定义，
 * permissionEngine.ts 和 bashTool.ts 都从此导入。
 * 任何新增/修改危险模式都应在此处进行。
 */
export const DANGEROUS_COMMAND_PATTERNS = [
  // 根目录递归删除
  /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/(?:\*|(?:etc|bin|usr|lib|root|var|dev|boot|sys|proc|tmp)(?:\/|$)))/i,
  /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/\s*$/i,
  /rm\s+-rf\s+\/\s*$/i,
  /rm\s+-rf\s+\*\s*$/i,

  // Windows 系统目录删除
  /(?:del|rd|rmdir)\s+.*[a-z]:\\(?:\*|windows|system32)/i,
  /format\s+[a-z]:/i,

  // 磁盘覆写
  />\s*\/dev\/sd[a-z]/i,
  /mkfs\./,
  /dd\s+.*of=\/dev\//i,

  // 系统控制（硬拦截，不可绕过）
  /\b(?:shutdown|reboot|halt|init\s+0|poweroff)\b/i,
  /net\s+user\s+.*\/delete/i,
  /reg\s+delete/i,

  // Fork Bomb
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/i,
  /fork\(\);\s*while\(1\)/i,

  // 远程代码执行
  /curl\s+.*\|\s*(bash|sh|python)/i,
  /wget\s+.*\|\s*(bash|sh|python)/i,
]

/**
 * 安全的命令前缀白名单
 * 这些命令后跟任意参数都是相对安全的
 */
const SAFE_COMMAND_PREFIXES = [
  /^ls\b/,
  /^dir\b/i,
  /^cd\b/,
  /^pwd\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^find\b/,
  /^git\s+status/i,
  /^git\s+log/i,
  /^git\s+diff/i,
]

/**
 * 检查Bash权限是否危险
 *
 * 规则：如果权限规则允许任意解释器执行，则视为危险
 * - Bash (tool-level allow): 允许所有bash命令
 * - Bash(python:*): 允许所有python命令
 * - Bash(npm*): 允许所有npm命令
 *
 * @param toolName 工具名称（如 'bash', 'bash:python*'）
 * @param ruleContent 规则内容（如 'python:*', undefined表示tool-level）
 * @returns 是否危险
 */
export function isDangerousBashPermission(
  toolName: string,
  ruleContent?: string
): boolean {
  // 处理 bash:python* 格式
  if (toolName.startsWith('bash:')) {
    const pattern = toolName.slice(5)  // 去掉 'bash:' 前缀
    return isDangerousInterpreterPattern(pattern)
  }

  // 非bash工具，不危险
  if (toolName !== 'bash' && toolName !== 'bash:*') return false

  // Tool-level allow (Bash with no content) - 允许所有bash命令
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  // 检查具体模式
  return isDangerousInterpreterPattern(ruleContent)
}

/**
 * 检查是否为危险解释器模式
 *
 * @param pattern 规则模式（如 'python:*', 'npm*', undefined）
 * @returns 是否危险
 */
function isDangerousInterpreterPattern(pattern: string): boolean {
  if (!pattern) return false

  const content = pattern.trim().toLowerCase()

  // 通配符匹配所有
  if (content === '*' || content === '*:*') return true

  // 检查危险解释器
  for (const interpreter of DANGEROUS_BASH_INTERPRETERS) {
    const lowerInterpreter = interpreter.toLowerCase()

    // 精确匹配：python
    if (content === lowerInterpreter) return true

    // 前缀匹配：python* 或 python:*
    if (content === `${lowerInterpreter}*` ||
        content === `${lowerInterpreter}:*`) return true

    // 包含通配符：python:* 允许所有python命令
    if (content.startsWith(`${lowerInterpreter}:`) ||
        content.startsWith(`${lowerInterpreter}*`)) {
      return true
    }

    // 包含空格：python -c '*' 允许任意代码执行
    if (content.startsWith(`${lowerInterpreter} -`) && content.endsWith('*')) {
      return true
    }
  }

  return false
}

/**
 * 检查命令是否匹配危险模式
 *
 * @param command 命令字符串
 * @returns 是否危险
 */
export function isDangerousCommandPattern(command: string): boolean {
  if (!command) return false

  const trimmed = command.trim()

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true
    }
  }

  return false
}

/**
 * 检查命令是否在安全白名单中
 *
 * @param command 命令字符串
 * @returns 是否安全
 */
export function isSafeCommandPrefix(command: string): boolean {
  if (!command) return false

  const trimmed = command.trim()

  for (const pattern of SAFE_COMMAND_PREFIXES) {
    if (pattern.test(trimmed)) {
      return true
    }
  }

  return false
}

/**
 * 检查Agent权限是否危险
 *
 * 规则：任何Agent allow规则都危险
 * 原因：Agent工具会启动sub-agent，如果自动批准则绕过sub-agent的安全评估
 *
 * @param toolName 工具名称
 * @param ruleContent 规则内容（对于Agent通常不重要）
 * @returns 是否危险
 */
export function isDangerousAgentPermission(
  toolName: string,
  ruleContent?: string
): boolean {
  const normalized = toolName.toLowerCase()

  // Agent工具本身
  if (normalized === 'agent' || normalized === 'agents' || normalized === 'task') {
    // Tool-level allow 或 任意allow规则都危险
    if (ruleContent === undefined || ruleContent === '' || ruleContent === '*') {
      return true
    }
    // 具体的subagent类型也危险（如 Agent(Plan), Agent(Explore)）
    // 因为它们也可能执行危险操作
    return true
  }

  return false
}

/**
 * 查找所有危险规则
 *
 * 遍历所有allow规则，检测是否为危险权限
 *
 * @param rules 权限规则列表
 * @returns 危险权限信息列表
 */
export function findDangerousPermissions(
  rules: PermissionRule[]
): DangerousPermissionInfo[] {
  const dangerous: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    // 只检查allow规则
    if (rule.action !== 'allow') continue

    // 提取工具名和内容
    let toolName = rule.tool
    let ruleContent: string | undefined = undefined

    if (toolName.includes(':')) {
      const parts = toolName.split(':')
      toolName = parts[0]!
      ruleContent = parts.slice(1).join(':')
    }

    // 检查Bash危险权限
    if (isDangerousBashPermission(toolName, ruleContent)) {
      const display = ruleContent ? `${toolName}(${ruleContent})` : `${toolName}(*)`
      dangerous.push({
        rule,
        reason: `${display} 会绕过安全检查，允许执行任意代码或脚本`
      })
      continue
    }

    // 检查Agent危险权限
    if (isDangerousAgentPermission(toolName, ruleContent)) {
      const display = ruleContent ? `${toolName}(${ruleContent})` : `${toolName}(*)`
      dangerous.push({
        rule,
        reason: `${display} 会自动批准sub-agent调用，绕过安全评估`
      })
      continue
    }
  }

  return dangerous
}

/**
 * 检查规则是否为过度宽泛的Bash allow规则
 *
 * 相当于YOLO模式，自动允许所有bash命令
 *
 * @param rule 权限规则
 * @returns 是否过度宽泛
 */
export function isOverlyBroadBashAllowRule(rule: PermissionRule): boolean {
  if (rule.action !== 'allow') return false

  const toolName = rule.tool.toLowerCase()

  // Bash tool-level allow (无内容限制)
  if (toolName === 'bash' || toolName === 'bash:*') {
    return true
  }

  // Bash(*) 模式
  if (toolName.startsWith('bash:') && rule.tool === 'bash:*') {
    return true
  }

  return false
}

/**
 * 格式化规则显示名称
 *
 * @param rule 权限规则
 * @returns 格式化后的显示名称
 */
export function formatRuleDisplay(rule: PermissionRule): string {
  if (rule.tool.includes(':')) {
    return rule.tool
  }
  return `${rule.tool}(*)`
}
