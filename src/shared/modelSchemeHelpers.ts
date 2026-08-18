/**
 * ModelScheme 辅助函数
 *
 * 提供统一访问 ModelScheme 的辅助函数。
 */

import type {ModelRole, ModelRoleConfig, ModelScheme, ModelSchemeRole} from './types'

/**
 * 检查 scheme 是否使用 roles 数组结构
 */
export function hasRolesArray(scheme: unknown): scheme is ModelScheme {
    return Array.isArray((scheme as ModelScheme)?.roles)
}

/**
 * 从 scheme 中获取指定角色的配置
 */
export function getRoleFromScheme(
    scheme: ModelScheme,
    role: string
): ModelSchemeRole | undefined {
    return scheme.roles.find((r) => r.role === role)
}

/**
 * 获取角色配置
 * 返回 ModelRoleConfig 格式以便统一处理
 */
export function getRoleConfig(
    scheme: ModelScheme,
    role: string
): ModelRoleConfig | undefined {
    const roleObj = scheme.roles.find((r) => r.role === role)
    return roleObj ? {
        endpointId: roleObj.endpointId,
        modelId: roleObj.modelId,
        enabled: roleObj.enabled,
        thinkingEffort: roleObj.thinkingEffort,
    } : undefined
}

/**
 * 更新 scheme 中指定角色的配置
 */
export function updateRoleInScheme(
    scheme: ModelScheme,
    role: string,
    updates: Partial<Omit<ModelSchemeRole, 'id' | 'role'>>
): ModelScheme {
    return {
        ...scheme,
        roles: scheme.roles.map((r) =>
            r.role === role ? {...r, ...updates, id: r.id, role: r.role} : r
        ),
    }
}

/**
 * 获取方案的主要角色配置
 */
export function getPrimaryRoleConfig(
    scheme: ModelScheme
): ModelRoleConfig | undefined {
    return getRoleConfig(scheme, 'primary')
}

/**
 * 获取默认启用的角色配置（用于 fallback）
 */
export function getEnabledRole(
    scheme: ModelScheme,
    preferredRole: ModelRole
): ModelRoleConfig | undefined {
    const config = getRoleConfig(scheme, preferredRole)
    if (config?.enabled) return config

    // Fallback to primary
    return getRoleConfig(scheme, 'primary')
}

/**
 * 获取完整的角色列表
 */
export function getAllRoles(scheme: ModelScheme): ModelSchemeRole[] {
    return scheme.roles
}

/**
 * 创建默认角色列表
 */
export function createDefaultRoles(): ModelSchemeRole[] {
    return DEFAULT_ROLES.map(r => ({...r, id: crypto.randomUUID()}))
}

const DEFAULT_ROLES: Omit<ModelSchemeRole, 'id'>[] = [
    {role: 'primary', endpointId: '', modelId: '', modelType: 'text', enabled: true},
    {role: 'lightweight', endpointId: '', modelId: '', modelType: 'text', enabled: false},
    {role: 'reasoning', endpointId: '', modelId: '', modelType: 'text', enabled: false, thinkingEffort: 'auto'},
    {role: 'image_understanding', endpointId: '', modelId: '', modelType: 'image', enabled: false},
    {role: 'audio_understanding', endpointId: '', modelId: '', modelType: 'voice', enabled: false},
    {role: 'video_understanding', endpointId: '', modelId: '', modelType: 'video', enabled: false},
]

// ─── 模型角色显示信息 ─────────────────────────────────────

export const MODEL_ROLE_INFO: Record<ModelRole, { name: string; description: string; icon: string }> = {
    primary: {name: '主力模型', description: '主力模型 · 常规任务执行 · 复杂任务兜底', icon: '🎯'},
    lightweight: {name: '轻量模型', description: '轻量模型 · 简单对话 · 后台轻量任务', icon: '💬'},
    reasoning: {name: '推理模型', description: '推理模型 · 复杂任务规划 · 深度推理分析', icon: '🧠'},
    image_understanding: {
        name: '图像理解',
        description: '分析图片内容。需配置支持 OpenAI 兼容视觉接口（image_url 输入）的模型，配置后启用 analyze_image 工具。',
        icon: '📷'
    },
    audio_understanding: {
        name: '音频理解',
        description: '分析音频内容。需配置支持 OpenAI 兼容音频接口（input_audio 输入）的模型，配置后启用 speech_to_text 工具。',
        icon: '🎧'
    },
    video_understanding: {
        name: '视频理解',
        description: '视频内容分析。需配置支持 OpenAI 兼容视频接口（video_url / 抽帧图片列表输入）的模型，预留供未来视频分析工具使用。',
        icon: '🎬'
    },
}

/** 获取模型角色的显示信息 */
export function getModelRoleInfo(role: ModelRole): { name: string; description: string; icon: string } {
    return MODEL_ROLE_INFO[role] || {name: role, description: '', icon: '❓'}
}

/**
 * 从 ModelSchemeRole 对象解析显示信息
 * 优先使用 role 对象上的自定义字段，fallback 到 MODEL_ROLE_INFO 默认值
 */
export function resolveRoleDisplay(role: ModelSchemeRole): { name: string; description: string; icon: string } {
    const defaults = MODEL_ROLE_INFO[role.role as ModelRole]
    return {
        name: role.displayName || defaults?.name || role.role,
        description: role.description || defaults?.description || '',
        icon: role.icon || defaults?.icon || '❓',
    }
}

