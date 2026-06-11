/**
 * 字段映射工具
 *
 * 统一处理配置文件（snake_case）和代码（camelCase）之间的字段命名差异
 * 支持从多种字段名中获取值，优先级：camelCase > snake_case > kebab-case
 */

/**
 * 从对象中获取字段值，支持多种命名风格
 *
 * @param obj - 源对象
 * @param camelCaseName - camelCase 字段名（优先匹配）
 * @param alternatives - 替代字段名数组（可选）
 * @returns 字段值，如果都不存在则返回 undefined
 */
export function getField<T = unknown>(
    obj: Record<string, unknown> | undefined | null,
    camelCaseName: string,
    alternatives?: readonly string[]
): T | undefined {
    if (!obj) return undefined

    // 1. 优先使用 camelCase（代码中的标准命名）
    if (camelCaseName in obj) {
        return obj[camelCaseName] as T
    }

    // 2. 尝试 snake_case 转换（配置文件中的命名）
    const snakeCaseName = camelToSnakeCase(camelCaseName)
    if (snakeCaseName in obj) {
        return obj[snakeCaseName] as T
    }

    // 3. 尝试提供的替代字段名
    if (alternatives) {
        for (const alt of alternatives) {
            if (alt in obj) {
                return obj[alt] as T
            }
        }
    }

    return undefined
}

/**
 * 智能获取字符串字段，处理多个可能的字段名
 *
 * 常用场景：systemPrompt/system_prompt, userDescription/user_description 等
 */
export function getStringField(
    obj: Record<string, unknown> | undefined | null,
    camelCaseName: string,
    alternatives?: string[]
): string {
    const value = getField<string>(obj, camelCaseName, alternatives)
    return value || ''
}

/**
 * camelCase 转 snake_case
 */
function camelToSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * snake_case 转 camelCase
 */
export function snakeToCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * 规范化字段名，统一转换为 camelCase
 *
 * @param fieldName - 输入字段名
 * @returns camelCase 格式的字段名
 */
export function normalizeFieldName(fieldName: string): string {
    // 如果已经是 camelCase，直接返回
    if (/^[a-z][a-zA-Z0-9]*$/.test(fieldName)) {
        return fieldName
    }

    // snake_case 转 camelCase
    if (fieldName.includes('_')) {
        return snakeToCamelCase(fieldName)
    }

    // kebab-case 转 camelCase
    if (fieldName.includes('-')) {
        return fieldName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    }

    return fieldName
}

/**
 * 批量映射对象的字段，将 snake_case 转换为 camelCase
 *
 * @param obj - 源对象
 * @returns 映射后的新对象
 */
export function mapFieldsToCamelCase<T = Record<string, unknown>>(obj: Record<string, unknown> | null | undefined): T {
    if (!obj) return {} as T

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
        const normalizedKey = normalizeFieldName(key)
        result[normalizedKey] = value
    }
    return result as T
}

// ==================== 常用字段映射配置 ====================

/**
 * Agent 定义的字段映射
 */
export const AGENT_FIELD_ALIASES = {
    systemPromptTemplate: ['systemPrompt', 'system_prompt', 'prompt', 'instructions'],
    userDescription: ['user_description', 'longDescription', 'long_description'],
    allowedTools: ['allowed_tools', 'tools'],
    disallowedTools: ['disallowed_tools', 'restricted_tools'],
    maxTurns: ['max_turns'],
    permissionMode: ['permission_mode', 'mode'],
    agentType: ['agent_type', 'type'],
    name: ['agent_name', 'title'],
    description: ['about', 'summary'],
    isolation: ['isolation_mode'],
    background: ['is_background', 'isBackground'],
    color: ['theme', 'theme_color'],
    model: ['model_name', 'modelName'],
    whenToUse: ['when_to_use', 'userDescription', 'user_description', 'trigger', 'triggerCondition', 'triggers'],
} as const

/**
 * Skill 定义的字段映射
 */
export const SKILL_FIELD_ALIASES = {
    userDescription: ['user_description', 'longDescription', 'long_description'],
    allowedTools: ['allowed_tools', 'tools'],
    whenToUse: ['when_to_use', 'trigger', 'triggerCondition', 'triggers'],
    skillDir: ['skill_dir', 'directory'],
} as const

/**
 * 从对象中获取 Agent 字段值（支持多种命名风格）
 */
export function getAgentField<T = unknown>(
    obj: Record<string, unknown> | undefined | null,
    fieldName: keyof typeof AGENT_FIELD_ALIASES
): T | undefined {
    const aliases = AGENT_FIELD_ALIASES[fieldName]
    return getField<T>(obj, fieldName as string, aliases)
}

/**
 * 从对象中获取 Skill 字段值（支持多种命名风格）
 */
export function getSkillField<T = unknown>(
    obj: Record<string, unknown> | undefined | null,
    fieldName: keyof typeof SKILL_FIELD_ALIASES
): T | undefined {
    const aliases = SKILL_FIELD_ALIASES[fieldName]
    return getField<T>(obj, fieldName as string, aliases)
}
