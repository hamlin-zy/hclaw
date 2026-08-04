/**
 * 用户命令消息解析 — 从消息中提取能力徽章所需的命令上下文
 *
 * 从 UserCommandBubble 抽取的纯函数模块，便于独立测试（无 React 依赖）。
 *
 * 纯渲染层使用：只读消息的 commandId / commandArgs / content，
 * 不修改消息内容，不影响 Agent Loop 的命令识别（detectCommandContext）。
 *
 * ★ 降级路径（历史消息兼容）：
 *   早期版本持久化时未保留 commandId（见 messageBlockHelper.ts 修复记录），
 *   导致从 DB 加载的旧 /能力 消息无法渲染徽章。当 commandId 缺失时，
 *   若 content 首行命中已知能力名（knownNames 参数），仍渲染为徽章，
 *   类型由命中集合推断；否则返回 null（保持纯文本，避免误渲染普通文本）。
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

/** 已知能力名集合（渲染层降级校验用，缺省为空 → 不启用降级） */
export interface KnownCapabilities {
    skills?: string[]
    agents?: string[]
    userCommands?: string[]
}

/**
 * 同步解析用户消息的命令上下文（无异步、无 IPC）
 *
 * 命令消息文本格式：/能力\n任务内容（Ctrl+K 换行）或 /能力 任务内容（手动输入空格）
 * 显示名取第一行的 /名称，任务内容优先从文本提取；commandId 仅用于类型判定。
 * commandId / commandArgs 可能位于顶层（DB 加载时 metadata 展开）或 metadata（内存消息）。
 */
export function parseUserCommandContext(
    message: {
        commandId?: string
        commandArgs?: string
        content?: string
        metadata?: Record<string, unknown>
    },
    known?: KnownCapabilities,
): UserCommandContext | null {
    const commandId = message.commandId || (message.metadata?.commandId as string | undefined)

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

    // ── 降级路径：commandId 缺失（历史消息）但文本命中已知能力名 → 仍渲染徽章 ──
    if (!commandId && nameMatch) {
        const name = nameMatch[1]
        const caps = known ?? {}
        if (caps.skills?.includes(name)) {
            return {commandName: name, commandArgs: argsFromText, type: 'skill'}
        }
        if (caps.agents?.includes(name)) {
            return {commandName: name, commandArgs: argsFromText, type: 'agent'}
        }
        if (caps.userCommands?.includes(name)) {
            return {commandName: name, commandArgs: argsFromText, type: 'user'}
        }
        // 未命中任何已知能力 → 不渲染徽章，保持纯文本
        return null
    }

    // commandId 缺失且非命令文本（或以 / 开头但未命中已知能力）→ 不渲染徽章
    if (!commandId) return null

    // 有文本 → 名称/任务内容以文本为准；否则兜底用 commandId/commandArgs
    const commandName = nameMatch ? nameMatch[1] : (commandId.split(':').pop() || commandId)
    const commandArgs = argsFromText ?? (message.commandArgs || (message.metadata?.commandArgs as string | undefined) || undefined)

    return {
        commandName,
        commandArgs,
        type: inferTypeFromCommandId(commandId),
    }
}
