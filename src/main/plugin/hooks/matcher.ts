/**
 * Matcher 模块 - Hook 匹配逻辑
 * 
 * 基于 Claude Code 规范实现工具名和事件匹配：
 * - '*' - 匹配所有
 * - 精确匹配 - 'Bash', 'Write'
 * - 正则匹配 - '^file_', '\.ts$'
 * - 操作符匹配 - 'Edit|Write|MultiEdit'
 */

import type { HookEvent } from './types'

/**
 * 检查工具名是否匹配 matcher
 * 
 * @param matcher - 匹配器（'*', 'Bash', 'Edit|Write', '^file_', 等）
 * @param toolName - 工具名称
 * @returns 是否匹配
 */
export function matchesTool(matcher: string, toolName: string): boolean {
  // 全局匹配
  if (matcher === '*') return true

  // 精确匹配
  if (matcher === toolName) return true

  // 尝试正则匹配
  try {
    if (new RegExp(matcher).test(toolName)) return true
  } catch {
    // 不是有效正则，继续尝试其他方式
  }

  // 尝试 '|' 分割的多个匹配
  const parts = matcher.split('|').map(p => p.trim())
  if (parts.length > 1) {
    return parts.some(part => {
      try {
        return new RegExp(part).test(toolName)
      } catch {
        return part === toolName
      }
    })
  }

  return false
}

/**
 * 检查事件是否匹配 matcher
 * 
 * @param matcher - 匹配器（'*', 'PreToolUse', 'Tool.*', 等）
 * @param event - 事件名称
 * @returns 是否匹配
 */
export function matchesEvent(matcher: string, event: HookEvent): boolean {
  // 全局匹配
  if (matcher === '*') return true

  // 精确匹配
  if (matcher === event) return true

  // 尝试正则匹配
  try {
    if (new RegExp(matcher).test(event)) return true
  } catch {
    // 无效正则，忽略
  }

  // 尝试 '|' 分割的多个匹配
  const parts = matcher.split('|').map(p => p.trim())
  if (parts.length > 1) {
    return parts.some(part => {
      try {
        return new RegExp(part).test(event)
      } catch {
        return part === event
      }
    })
  }

  return false
}

/**
 * 检查文件路径是否匹配 matcher
 * 
 * @param matcher - 匹配器（'\.env$', '\.ts$', 'src/.*', 等）
 * @param filePath - 文件路径
 * @returns 是否匹配
 */
export function matchesFile(matcher: string, filePath: string): boolean {
  // 全局匹配
  if (matcher === '*') return true

  // 精确匹配
  if (matcher === filePath) return true

  // 尝试正则匹配
  try {
    if (new RegExp(matcher).test(filePath)) return true
  } catch {
    // 不是有效正则，忽略
  }

  // 尝试文件名匹配（只取 basename）
  const fileName = filePath.split(/[/\\]/).pop() || ''
  if (matcher === fileName) return true

  try {
    if (new RegExp(matcher).test(fileName)) return true
  } catch {
    // 无效正则
  }

  return false
}

/**
 * 验证 matcher 是否有效
 * 
 * @param matcher - 匹配器字符串
 * @returns 是否是有效的 matcher
 */
export function isValidMatcher(matcher: string): boolean {
  if (!matcher || matcher === '*') return true
  
  // 尝试作为正则表达式验证
  try {
    new RegExp(matcher)
    return true
  } catch {
    // 不是正则，检查是否是 '|' 分割的多个模式
    const parts = matcher.split('|').map(p => p.trim())
    for (const part of parts) {
      if (!part) continue
      try {
        new RegExp(part)
      } catch {
        // 如果不是有效正则，也不是有效的精确匹配
        return false
      }
    }
    return true
  }
}

/**
 * 解析 matcher，返回所有模式
 * 
 * @param matcher - 匹配器
 * @returns 模式数组
 */
export function parseMatcher(matcher: string): string[] {
  if (!matcher || matcher === '*') return []
  return matcher.split('|').map(p => p.trim()).filter(Boolean)
}

/**
 * 生成匹配描述（用于 UI 显示）
 * 
 * @param matcher - 匹配器
 * @param type - 类型 ('tool', 'event', 'file')
 * @returns 人类可读的描述
 */
export function describeMatcher(matcher: string, type: 'tool' | 'event' | 'file'): string {
  if (!matcher || matcher === '*') {
    return type === 'tool' ? '所有工具' : 
           type === 'event' ? '所有事件' : '所有文件'
  }

  const parts = parseMatcher(matcher)
  if (parts.length === 1) {
    const part = parts[0]
    // 检查是否是正则
    if (/[.*+?^${}()|[\]\\]/.test(part)) {
      return `正则: ${part}`
    }
    return part
  }

  return parts.join(' 或 ')
}
