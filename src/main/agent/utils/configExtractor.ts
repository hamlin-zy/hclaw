/**
 * 配置提取工具
 *
 * 提供统一的字段提取函数，消除重复的配置解析代码
 */

import type {AgentTemplate} from '@shared/types'

/**
 * Agent 配置的原始数据
 */
export interface RawAgentConfig {
    // 名称字段（支持多种命名）
    name?: unknown
    agent_name?: unknown

    // 描述字段（支持多种命名）
    description?: unknown
    about?: unknown

    // 用户描述字段（支持多种命名）
    user_description?: unknown
    userDescription?: unknown

    // 使用时机字段（支持多种命名）
    when_to_use?: unknown
    whenToUse?: unknown
    triggers?: unknown

    // 系统提示词字段（支持多种命名）
    system_prompt?: unknown
    instructions?: unknown
    prompt?: unknown

    // 标签字段
    tags?: unknown
    category?: unknown

    // 工具字段（支持多种命名）
    tools?: unknown
    allowed_tools?: unknown

    // 启用状态
    enabled?: unknown

    // ===== CC 兼容字段 =====
    model?: unknown
    disallowed_tools?: unknown
    disallowedTools?: unknown
    memory?: unknown
    isolation?: unknown
    permission_mode?: unknown
    permissionMode?: unknown
    max_turns?: unknown
    maxTurns?: unknown
    required_mcp_servers?: unknown
    requiredMcpServers?: unknown

    // 其他字段
    [key: string]: unknown
}

/**
 * 解析后的 Agent 配置
 */
export interface ParsedAgentConfig {
    /** Agent 名称 */
    name: string

    /** Agent 描述 */
    description: string

    /** 用户可见的描述 */
    userDescription: string | undefined

    /** 何时使用此 Agent */
    whenToUse: string | undefined

    /** 系统提示词 */
    systemPrompt: string

    /** 标签列表 */
    tags: string[]

    /** 允许的工具列表 */
    allowedTools: string[]

    /** 是否启用 */
    enabled: boolean

    // ===== CC 兼容字段 =====
    /** 模型覆盖 */
    model?: string
    /** 禁止的工具黑名单 */
    disallowedTools?: string[]
    /** 记忆作用域 */
    memory?: 'user' | 'project' | 'none'
    /** 隔离模式 */
    isolation?: 'worktree' | 'none'
    /** 权限模式覆盖 */
    permissionMode?: 'auto' | 'safe'
    /** 最大轮次 */
    maxTurns?: number
    /** 必需的 MCP 服务器 */
    requiredMcpServers?: string[]
}

/**
 * 配置解析选项
 */
export interface ParseAgentConfigOptions {
    /** 默认名称（当 name 字段为空时使用） */
    defaultName: string

    /**
     * 来源类型：
     * - 'local': 本地 agent，使用文件中的 enabled 字段，默认为 true
     * - 'plugin': 插件 agent，enabled 由插件启用状态决定
     */
    source?: 'local' | 'plugin'

    /**
     * 插件启用状态（仅 plugin 来源使用）
     * 插件 agent 的 enabled 由此参数决定
     */
    pluginEnabled?: boolean
}

/**
 * 解析原始配置对象，提取标准化的 Agent 配置
 *
 * 支持多种字段命名约定：
 * - name / agent_name
 * - description / about
 * - user_description / userDescription
 * - when_to_use / whenToUse
 * - system_prompt / instructions / prompt
 * - tools / allowed_tools
 *
 * @param raw 原始配置对象
 * @param systemPrompt 系统提示词（如果不在 raw 中）
 * @param options 解析选项
 * @returns 解析后的配置对象，如果 name 为空则返回 null
 */
export function parseAgentConfig(
    raw: RawAgentConfig,
    systemPrompt: string,
    options: ParseAgentConfigOptions,
): ParsedAgentConfig | null {
    const {defaultName, source = 'local', pluginEnabled = true} = options

    // 提取名称
    const name = extractString(raw, 'name', 'agent_name') || defaultName
    if (!name) {
        return null
    }

    // 提取描述
    const description = extractString(raw, 'description', 'about') || ''

    // 提取用户描述
    const userDescription = extractString(raw, 'user_description', 'userDescription')

    // 提取使用时机（when_to_use, whenToUse, triggers）
    const whenToUse = extractString(raw, 'when_to_use', 'whenToUse') ||
        extractTriggersString(raw.triggers)

    // 提取系统提示词
    const resolvedSystemPrompt = extractString(raw, 'system_prompt', 'instructions', 'prompt') || systemPrompt

    // 提取标签
    const tags = parseStringArray(raw, 'tags')
    if (tags.length === 0 && typeof raw.category === 'string') {
        tags.push(raw.category)
    }

    // 提取工具列表
    const allowedTools = parseStringArray(raw, 'tools')
    if (allowedTools.length === 0) {
        allowedTools.push(...parseStringArray(raw, 'allowed_tools'))
    }

    // 解析启用状态
    // 插件 agent：enabled 由传入的 pluginEnabled 决定
    // 本地 agent：使用配置文件中的 enabled 字段，默认为 true
    const enabled = source === 'plugin'
        ? pluginEnabled
        : ((raw.enabled as boolean) ?? true)

    // ===== CC 兼容字段提取 =====
    const model = extractString(raw, 'model')
    const disallowedTools = parseStringArray(raw, 'disallowed_tools')
    if (disallowedTools.length === 0) {
        disallowedTools.push(...parseStringArray(raw, 'disallowedTools'))
    }
    const memory = extractEnum(raw, 'memory', ['user', 'project', 'none'])
    const isolation = extractEnum(raw, 'isolation', ['worktree', 'none'])
    const permissionMode = extractEnum(raw, 'permission_mode', 'permissionMode', ['auto', 'safe'])
    const maxTurns = extractNumber(raw, 'max_turns') ?? extractNumber(raw, 'maxTurns')
    const requiredMcpServers = parseStringArray(raw, 'required_mcp_servers')
    if (requiredMcpServers.length === 0) {
        requiredMcpServers.push(...parseStringArray(raw, 'requiredMcpServers'))
    }

    return {
        name,
        description,
        userDescription,
        whenToUse,
        systemPrompt: resolvedSystemPrompt,
        tags,
        allowedTools,
        enabled,

        // CC 兼容字段
        model,
        disallowedTools,
        memory,
        isolation,
        permissionMode,
        maxTurns,
        requiredMcpServers,
    }
}

/**
 * 从原始配置构建 AgentTemplate
 *
 * @param id Agent ID
 * @param raw 原始配置对象
 * @param systemPrompt 系统提示词
 * @param options 解析选项
 * @returns AgentTemplate 对象，如果解析失败则返回 null
 */
export function buildAgentTemplateFromRaw(
    id: string,
    raw: RawAgentConfig,
    systemPrompt: string,
    options: ParseAgentConfigOptions,
): AgentTemplate | null {
    const parsed = parseAgentConfig(raw, systemPrompt, options)
    if (!parsed) {
        return null
    }

    return {
        id: `local-${id}`,
        name: parsed.name,
        description: parsed.description,
        userDescription: parsed.userDescription,
        whenToUse: parsed.whenToUse,
        systemPrompt: parsed.systemPrompt,
        enabled: parsed.enabled,
        tags: parsed.tags,
        allowedTools: parsed.allowedTools,
        createdAt: Date.now(),
        updatedAt: Date.now(),

        // ===== CC 兼容字段透传 =====
        model: parsed.model,
        disallowedTools: parsed.disallowedTools,
        isolation: parsed.isolation,
        permissionMode: parsed.permissionMode,
        maxTurns: parsed.maxTurns,
        requiredMcpServers: parsed.requiredMcpServers,
    }
}

/**
 * 提取字符串值（尝试多个可能的字段名）
 *
 * @param obj 原始对象
 * @param keys 尝试的字段名列表
 * @returns 第一个找到的非空字符串值，或 undefined
 */
function extractString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = obj[key]
        if (typeof value === 'string' && value.trim()) {
            return value.trim()
        }
    }
    return undefined
}

/**
 * 安全地解析字符串数组
 *
 * @param obj 原始对象
 * @param key 字段名
 * @returns 字符串数组
 */
function parseStringArray(obj: Record<string, unknown>, key: string): string[] {
    const value = obj[key]
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string')
    }
    return []
}

/**
 * 提取可选的字符串值
 *
 * @param raw 原始配置对象
 * @param keys 尝试的字段名列表
 * @returns 第一个找到的非空字符串值，或 undefined
 */
export function extractOptionalString(
    raw: RawAgentConfig,
    ...keys: string[]
): string | undefined {
    return extractString(raw, ...keys)
}

/**
 * 提取必填的字符串值
 *
 * @param raw 原始配置对象
 * @param keys 尝试的字段名列表
 * @param fieldName 字段名（用于错误信息）
 * @returns 第一个找到的非空字符串值
 * @throws 如果所有字段都为空
 */
export function extractRequiredString(
    raw: RawAgentConfig,
    keys: string[],
    fieldName: string,
): string {
    const value = extractString(raw, ...keys)
    if (!value) {
        throw new Error(`Missing required field: ${keys.join(' or ')} (${fieldName})`)
    }
    return value
}

/**
 * 提取布尔值
 *
 * @param raw 原始配置对象
 * @param key 字段名
 * @param defaultValue 默认值
 * @returns 布尔值
 */
export function extractBoolean(
    raw: RawAgentConfig,
    key: string,
    defaultValue: boolean = false,
): boolean {
    const value = raw[key]
    if (typeof value === 'boolean') {
        return value
    }
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true'
    }
    if (typeof value === 'number') {
        return value !== 0
    }
    return defaultValue
}

/**
 * 提取数字值
 *
 * @param raw 原始配置对象
 * @param key 字段名
 * @param defaultValue 默认值
 * @returns 数字值
 */
export function extractNumber(
    raw: RawAgentConfig,
    key: string,
    defaultValue?: number,
): number | undefined {
    const value = raw[key]
    if (typeof value === 'number' && !isNaN(value)) {
        return value
    }
    if (typeof value === 'string') {
        const parsed = parseFloat(value)
        if (!isNaN(parsed)) {
            return parsed
        }
    }
    return defaultValue
}

/**
 * 提取枚举值
 * 支持 snake_case 和 camelCase 字段名
 *
 * @param raw 原始配置对象
 * @param keys 尝试的字段名列表
 * @param validValues 合法的枚举值列表
 * @returns 第一个匹配的枚举值，或 undefined
 */
function extractEnum<T extends string>(
    raw: RawAgentConfig,
    ...keysAndValues: [...string[], T[]]
): T | undefined {
    const validValues = keysAndValues[keysAndValues.length - 1] as T[]
    const keys = keysAndValues.slice(0, -1) as string[]
    for (const key of keys) {
        const value = raw[key]
        if (typeof value === 'string' && validValues.includes(value as T)) {
            return value as T
        }
    }
    return undefined
}

/**
 * 提取标签数组（带去重）
 *
 * @param raw 原始配置对象
 * @param keys 尝试的字段名列表
 * @returns 去重后的字符串数组
 */
export function extractTags(raw: RawAgentConfig, ...keys: string[]): string[] {
    const tags = new Set<string>()
    for (const key of keys) {
        const value = raw[key]
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string' && item.trim()) {
                    tags.add(item.trim())
                }
            }
        }
    }
    return Array.from(tags)
}

/**
 * 从 triggers 字段提取字符串值
 * 支持字符串、字符串数组、多行字符串格式
 */
function extractTriggersString(triggers: unknown): string | undefined {
    if (triggers === undefined || triggers === null) {
        return undefined
    }

    // 如果是字符串，直接返回
    if (typeof triggers === 'string') {
        const trimmed = triggers.trim()
        return trimmed.length > 0 ? trimmed : undefined
    }

    // 如果是数组，合并为字符串
    if (Array.isArray(triggers)) {
        const parts = triggers
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            .map(t => t.trim())
        return parts.length > 0 ? parts.join(', ') : undefined
    }

    return undefined
}
