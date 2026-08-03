/**
 * 用户命令消息解析 — 从消息中提取能力徽章所需的命令上下文
 *
 * 从 UserCommandBubble 抽取的纯函数模块，便于独立测试（无 React 依赖）。
 *
 * 纯渲染层使用：只读消息的 commandId / commandArgs / content，
 * 不修改消息内容，不影响 Agent Loop 的命令识别（detectCommandContext）。
 */

export type CapabilityType = 'skill' | 'agent' | 'user' | 'plugin'

export interface UserCommandContext {
    /** 能力显示名（不含 / 前缀） */
    commandName: string
    /** 任务内容 */
    commandArgs?: string
    /** 能力类型：skill / agent / user(自定义命令) / plugin(插件命令) */
    type: CapabilityType
}

/** 从 commandId 推断能力类型（skill: / agent: / user: / 其他视为 plugin） */
export function inferTypeFromCommandId(commandId: string): CapabilityType {
    if (commandId.startsWith('skill:')) return 'skill'
    if (commandId.startsWith('agent:')) return 'agent'
    if (commandId.startsWith('user:')) return 'user'
    return 'plugin'
}

/**
 * 同步解析用户消息的命令上下文（无异步、无 IPC）
 *
 * 命令消息文本格式：/能力\n任务内容（Ctrl+K 换行）或 /能力 任务内容（手动输入空格）
 * 显示名取第一行的 /名称，任务内容优先从文本提取；commandId 仅用于类型判定。
 * commandId / commandArgs 可能位于顶层（DB 加载时 metadata 展开）或 metadata（内存消息）。
 */
export function parseUserCommandContext(message: {
    commandId?: string
    commandArgs?: string
    content?: string
    metadata?: Record<string, unknown>
}): UserCommandContext | null {
    const commandId = message.commandId || (message.metadata?.commandId as string | undefined)
    if (!commandId) return null

    const content = typeof message.content === 'string' ? message.content.trim() : ''
    const lines = content.split('\n')
    const firstLine = lines[0]?.trim() ?? ''
    const nameMatch = firstLine.match(/^\/(\S+)/)

    // 任务内容提取：优先多行（Ctrl+K 换行分隔），其次单行空格分隔（手动输入）
    const argsFromText = nameMatch
        ? (lines.length > 1
            ? lines.slice(1).join('\n').trim() || undefined
            : firstLine.slice(nameMatch[1].length + 1).trim() || undefined)
        : undefined

    // 有文本 → 名称/任务内容以文本为准；否则兜底用 commandId/commandArgs
    const commandName = nameMatch ? nameMatch[1] : (commandId.split(':').pop() || commandId)
    const commandArgs = argsFromText ?? (message.commandArgs || (message.metadata?.commandArgs as string | undefined) || undefined)

    return {
        commandName,
        commandArgs,
        type: inferTypeFromCommandId(commandId),
    }
}
