/**
 * 消息相关的工具函数
 */

import type {ToolCall} from '@shared/types'
import {truncate} from '../../../lib/format'
import {isMcpToolName} from '@shared/utils/mcpShortId'

/**
 * 将值转换为字符串，失败返回 null
 */
export function toStringOrNull(val: unknown): string | null {
    if (typeof val === 'string') return val
    if (val && typeof val === 'object') return JSON.stringify(val)
    return null
}

/**
 * 格式化工具参数，过滤内部字段
 */
export function formatToolArgs(args: Record<string, unknown>): string {
    const cleaned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
        if (key === 'reason') continue
        cleaned[key] = value
    }
    return Object.keys(cleaned).length > 0
        ? JSON.stringify(cleaned, null, 2)
        : '(无参数)'
}

/**
 * 获取工具调用的摘要信息（简短，用于行内显示）
 */
export function getToolSummary(tc: ToolCall): string | null {
    const args = tc.arguments as any
    if (!args) return null

    if (tc.name === 'analyze_image') return null // 特殊处理
    if (tc.name.startsWith('file_') || tc.name === 'glob' || tc.name === 'grep') {
        const pathStr = toStringOrNull(args.filePath) || toStringOrNull(args.path) || toStringOrNull(args.pattern)
        return pathStr ? truncate(pathStr, 60) : null
    }
    if (tc.name === 'bash') {
        const cmdStr = toStringOrNull(args.command)
        return cmdStr ? truncate(cmdStr, 60) : null
    }
    if (isMcpToolName(tc.name)) {
        for (const field of ['thought', 'query', 'command', 'url', 'filePath', 'pattern', 'text']) {
            const v = args[field]
            if (v && typeof v === 'string') return truncate(v, 60)
        }
        const keys = Object.keys(args).filter((k) => k !== 'reason')
        if (keys.length > 0) return keys.slice(0, 3).join(', ')
    }
    return null
}

/**
 * 获取工具调用的参数摘要（简短，用于芯片/标签显示）
 */
export function getToolArgSummary(tc: ToolCall): string | null {
    const args = tc.arguments as any
    if (!args) return null
    if (tc.name.startsWith('file_') || tc.name === 'glob' || tc.name === 'grep') {
        return truncate(toStringOrNull(args.filePath) || toStringOrNull(args.path) || toStringOrNull(args.pattern) || '', 50)
    }
    if (tc.name === 'bash') return truncate(toStringOrNull(args.command) || '', 50)
    if (isMcpToolName(tc.name)) {
        for (const field of ['thought', 'query', 'command', 'url', 'filePath', 'pattern', 'text']) {
            const v = args[field]
            if (v && typeof v === 'string') return truncate(v, 50)
        }
    }
    return null
}

/**
 * 获取工具调用的详细参数信息（用于展开区域展示）
 */
export function getToolDetail(tc: ToolCall): string | null {
    const args = tc.arguments as any
    if (!args) return null
    if (tc.name === 'bash') return toStringOrNull(args.command)
    if (tc.name.startsWith('file_') || tc.name === 'glob' || tc.name === 'grep') {
        return toStringOrNull(args.filePath) || toStringOrNull(args.path) || toStringOrNull(args.pattern)
    }
    if (tc.name === 'analyze_image') return toStringOrNull(args.imagePath) || toStringOrNull(args.prompt)
    if (isMcpToolName(tc.name)) {
        const cleaned: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(args)) if (k !== 'reason') cleaned[k] = v
        return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned, null, 2) : null
    }
    return null
}

/**
 * 从工具调用中解析 Agent 显示名称
 *
 * 优先级：arguments.agent (用户指定的 Agent 名称) > taskDescription > arguments.task
 */
export function resolveAgentDisplayName(tc: ToolCall): string | null {
    if (tc.name !== 'agent') return null
    const args = tc.arguments as Record<string, unknown> | null
    if (typeof args?.agent === 'string') return args.agent
    return tc.taskDescription ?? (typeof args?.task === 'string' ? args.task : null)
}

/**
 * 判断给定的显示名是否对应一个 agent 工具调用
 */
export function isAgentDisplayName(displayName: string, toolCalls: ToolCall[]): boolean {
    return toolCalls.some(tc => {
        if (tc.name !== 'agent') return false
        const resolved = resolveAgentDisplayName(tc)
        // displayName === 'agent' 是 fallback 名称，当 resolveAgentDisplayName 返回 null 时使用
        return resolved === displayName || (!resolved && displayName === 'agent')
    })
}

/**
 * 获取工具调用的简短描述（用于交错渲染中的原因展示）
 */
export function getToolDescription(tc: ToolCall): string | null {
    const args = tc.arguments as any
    if (!args) return null

    if (tc.name === 'file_read' || tc.name === 'file_write' || tc.name === 'file_edit') {
        const path = toStringOrNull(args.filePath) || toStringOrNull(args.path)
        const action = tc.name === 'file_read' ? '查看' : tc.name === 'file_write' ? '写入' : '编辑'
        return path ? `${action} ${truncate(path, 50)}` : null
    }
    if (tc.name === 'glob') {
        const pattern = toStringOrNull(args.pattern)
        return pattern ? `搜索 ${truncate(pattern, 50)}` : null
    }
    if (tc.name === 'grep') {
        const pattern = toStringOrNull(args.pattern)
        return pattern ? `搜索 "${truncate(pattern, 40)}"` : null
    }
    if (tc.name === 'bash') {
        const cmd = toStringOrNull(args.command)
        return cmd ? `执行命令: ${truncate(cmd, 50)}` : null
    }
    if (isMcpToolName(tc.name)) {
        const keyFields = ['thought', 'query', 'command', 'url', 'filePath', 'pattern', 'text']
        for (const field of keyFields) {
            if (args[field]) return truncate(String(args[field]), 60)
        }
    }
    return null
}
