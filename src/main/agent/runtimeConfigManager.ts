/**
 * RuntimeConfigManager - 运行时配置统一管理器
 *
 * 职责：
 * 1. 统一管理 Agent 运行时所需的全部配置
 * 2. 提供各角色（主力/轻量/推理等）的 provider + model 快速获取
 * 3. 支持跨进程（主进程 ↔ Worker）实时同步
 *
 * 公共字段：
 * - 当前工作目录
 * - 当前模型方案
 * - 当前运行模式
 * - 当前系统设置
 *
 * 内部字段（便于 loop 快速获取）：
 * - 各角色的 provider 对象 + providerModel 对象
 *
 * 更新时机：
 * - 应用启动初始化
 * - 维护的参数发生更新、切换操作
 *
 * 使用方式：
 * - agent loop 中通过 getRuntimeConfig() 或 getRoleProvider(role) 获取
 */

import {logger} from './logger'
import type {LLMProvider, ModelRole, ModelScheme, RunMode, SystemSettings, WorkMode} from '@shared/types'
// WORK_MODE_TO_MODEL_ROLE 已废弃，映射逻辑内联在 getModelRoleForWorkMode() 中
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {setCurrentScheme as setModelScheme} from './model/modelSchemeManager'
import {getConfigBridge, setConfigBridge} from './common/configBridge'

// ─── 类型定义 ─────────────────────────────────────────────

/** 角色类型（统一使用 shared/types.ts 中的 ModelRole） */
export type ModelRoleType = ModelRole

/**
 * 角色对应的 Provider + Model 组合
 */
export interface RoleProviderInfo {
    role: ModelRoleType
    provider: LLMProvider | null
    modelId: string | null
    modelName: string | null
    /** 是否有效（provider 和 model 都存在且启用） */
    isValid: boolean
}

/**
 * 完整的运行时配置
 */
export interface RuntimeConfig {
    /** 工作目录 */
    workingDir: string
    /** 当前模型方案 */
    scheme: ModelScheme | null
    /** 当前运行模式 */
    mode: RunMode
    /** 当前系统设置 */
    settings: SystemSettings | null
    /** 版本号（用于变更检测） */
    version: number
    /** 最后更新时间 */
    updatedAt: number
}

/**
 * RuntimeConfigManager 配置项
 */
export interface RuntimeConfigOptions {
    /** 默认工作目录 */
    defaultWorkingDir?: string
    /** 默认权限模式 */
    defaultMode?: RunMode
}

/**
 * 序列化的配置数据（用于跨进程传递）
 */
export interface SerializedRuntimeConfig {
    workingDir: string
    scheme: ModelScheme | null
    providers: LLMProvider[]
    mode: RunMode
    settings: SystemSettings | null
    version: number
}

// ─── 默认配置 ─────────────────────────────────────────────

const DEFAULT_WORKING_DIR = ''
const DEFAULT_MODE: RunMode = 'safe'
const DEFAULT_WORK_MODE: WorkMode = 'primary'

// ─── 全局状态 ─────────────────────────────────────────────

let currentWorkingDir: string = DEFAULT_WORKING_DIR
let currentScheme: ModelScheme | null = null
let currentProviders: LLMProvider[] = []
let currentMode: RunMode = DEFAULT_MODE
let currentWorkMode: WorkMode = DEFAULT_WORK_MODE
let currentSettings: SystemSettings | null = null
let configVersion: number = 0
let lastUpdatedAt: number = Date.now()

// 角色 Provider 缓存
const roleProviderCache: Map<ModelRoleType, RoleProviderInfo> = new Map()

// 更新锁（防止并发更新）
let updateInProgress: boolean = false

// 配置变更监听器
type ConfigChangeListener = (config: RuntimeConfig) => void
const changeListeners: Set<ConfigChangeListener> = new Set()

// ─── 辅助函数 ─────────────────────────────────────────────

/**
 * 根据角色配置获取对应的 Provider 信息
 */
function resolveRoleProvider(
    roleConfig: { endpointId: string; modelId: string; enabled: boolean } | undefined,
    providers: LLMProvider[],
    role: ModelRoleType
): RoleProviderInfo {
    if (!roleConfig || !roleConfig.enabled || !roleConfig.endpointId) {
        return {role, provider: null, modelId: null, modelName: null, isValid: false}
    }

    const provider = providers.find(p => p.id === roleConfig.endpointId)
    if (!provider || !provider.enabled) {
        return {role, provider: null, modelId: null, modelName: null, isValid: false}
    }

    const model = provider.models.find(m => m.id === roleConfig.modelId)
    if (!model || !model.enabled) {
        return {role, provider: null, modelId: null, modelName: null, isValid: false}
    }

    return {
        role,
        provider,
        modelId: model.id,
        modelName: model.name,
        isValid: true,
    }
}

/**
 * 更新角色 Provider 缓存
 * 动态缓存 scheme 中所有角色，按 role 字段作为 key
 * 支持内置角色（primary/lightweight/reasoning）和自定义角色
 */
function updateRoleProviderCache(): void {
    roleProviderCache.clear()
    if (!currentScheme) return

    for (const role of currentScheme.roles) {
        roleProviderCache.set(role.role as ModelRoleType, resolveRoleProvider(
            role,
            currentProviders,
            role.role as ModelRoleType
        ))
    }
}

/**
 * 触发配置变更通知
 */
function notifyChange(): void {
    configVersion++
    lastUpdatedAt = Date.now()

    const config = RuntimeConfigManager.getConfig()
    changeListeners.forEach(listener => {
        try {
            listener(config)
        } catch (err) {
            logger.error('[RuntimeConfigManager] 通知变更失败', {error: err})
        }
    })
}

// ─── RuntimeConfigManager ─────────────────────────────────

/**
 * 运行时配置管理器
 */
export class RuntimeConfigManager {
    /**
     * 初始化运行时配置
     * @param options 初始化选项
     */
    static initialize(options: RuntimeConfigOptions = {}): void {
        currentWorkingDir = options.defaultWorkingDir || DEFAULT_WORKING_DIR
        currentMode = options.defaultMode || DEFAULT_MODE
        currentSettings = null
        currentScheme = null
        currentProviders = []
        configVersion = 0
        lastUpdatedAt = Date.now()

        // 注册 ConfigBridge 实例，打破循环依赖
        setConfigBridge({
            getScheme: () => currentScheme,
            getProviders: () => currentProviders,
            onConfigChange: (cb) => {
                const listener: ConfigChangeListener = () => cb(getConfigBridge())
                changeListeners.add(listener)
                return () => changeListeners.delete(listener)
            },
        })

        // 初始化完成
    }

    /**
     * 获取完整的运行时配置
     */
    static getConfig(): RuntimeConfig {
        return {
            workingDir: currentWorkingDir,
            scheme: currentScheme,
            mode: currentMode,
            settings: currentSettings,
            version: configVersion,
            updatedAt: lastUpdatedAt,
        }
    }

    /**
     * 获取工作目录
     */
    static getWorkingDir(): string {
        return currentWorkingDir
    }

    /**
     * 设置工作目录
     */
    static setWorkingDir(dir: string): void {
        if (currentWorkingDir === dir) return
        currentWorkingDir = dir
        notifyChange()
    }

    /**
     * 获取当前模型方案
     */
    static getScheme(): ModelScheme | null {
        return currentScheme
    }

    /**
     * 获取当前 providers
     */
    static getProviders(): LLMProvider[] {
        return currentProviders
    }

    /**
     * 更新模型方案配置
     * @param schemeId 方案 ID
     * @param scheme 方案配置
     * @param providers 提供商列表
     */
    static updateScheme(
        schemeId: string,
        scheme: ModelScheme,
        providers: LLMProvider[]
    ): void {
        if (updateInProgress) {
            logger.warn('[RuntimeConfigManager] 更新正在进行中，跳过')
            return
        }

        updateInProgress = true
        try {
            // 验证 scheme 和 providers 匹配
            if (scheme.id !== schemeId) {
                logger.error('[RuntimeConfigManager] Scheme ID 不匹配', {expected: schemeId, actual: scheme.id})
                return
            }

            currentScheme = scheme
            currentProviders = providers
            updateRoleProviderCache()
            notifyChange()

            // 同时更新 modelSchemeManager（客户端缓存）
            setModelScheme(schemeId, scheme, providers)

            // 模型方案已更新
        } finally {
            updateInProgress = false
        }
    }

    /**
     * 获取当前权限模式
     */
    static getMode(): RunMode {
        return currentMode
    }

    /**
     * 设置权限模式
     */
    static setMode(mode: RunMode): void {
        if (currentMode === mode) return
        currentMode = mode
        notifyChange()
    }

    /**
     * 获取当前工作模式
     */
    static getWorkMode(): WorkMode {
        return currentWorkMode
    }

    /**
     * 设置工作模式
     */
    static setWorkMode(mode: WorkMode): void {
        if (currentWorkMode === mode) return
        currentWorkMode = mode
        notifyChange()
    }

    /**
     * 根据工作模式获取对应的模型角色
     * - auto 模式：使用 primary 作为兜底
     * - 其他：从 scheme 的 roles 中按 role 查找
     */
    static getModelRoleForWorkMode(): ModelRole {
        if (currentWorkMode === 'auto') return 'primary'
        if (currentScheme) {
            const matched = currentScheme.roles.find(r => r.role === currentWorkMode)
            if (matched) return matched.role as ModelRole
        }
        return 'primary'
    }

    /**
     * 根据工作模式获取对应的模型配置
     */
    static getModelConfigForWorkMode(): RoleProviderInfo {
        const role = this.getModelRoleForWorkMode()
        return this.getRoleProvider(role)
    }

    /**
     * 获取系统设置
     */
    static getSettings(): SystemSettings | null {
        return currentSettings
    }

    /**
     * 更新系统设置
     */
    static updateSettings(settings: SystemSettings): void {
        currentSettings = settings
        notifyChange()
        // 系统设置已更新
    }

    /**
     * 根据角色类型获取 Provider 和 Model 信息
     * @param role 角色类型或名称字符串
     * @param fallbackToPrimary 如果找不到指定角色是否回退到 primary
     * @returns Provider 信息
     */
    static getRoleProvider(role: ModelRoleType | string, fallbackToPrimary = true): RoleProviderInfo {
        const fromCache = roleProviderCache.get(role as ModelRoleType)
        if (fromCache) return fromCache
        const empty: RoleProviderInfo = {
            role: role as ModelRoleType,
            provider: null,
            modelId: null,
            modelName: null,
            isValid: false
        }
        return fallbackToPrimary ? (roleProviderCache.get('primary') || empty) : empty
    }

    /**
     * 获取指定角色的 Provider 信息（回退到 primary）
     */
    static getPrimaryProvider(): RoleProviderInfo {
        return this.getRoleProvider('primary')
    }

    static getLightweightProvider(): RoleProviderInfo {
        return this.getRoleProvider('lightweight')
    }

    static getReasoningProvider(): RoleProviderInfo {
        return this.getRoleProvider('reasoning')
    }

    /**
     * 获取当前版本号（用于变更检测）
     */
    static getVersion(): number {
        return configVersion
    }

    /**
     * 添加配置变更监听器
     */
    static addChangeListener(listener: ConfigChangeListener): void {
        changeListeners.add(listener)
    }

    /**
     * 移除配置变更监听器
     */
    static removeChangeListener(listener: ConfigChangeListener): void {
        changeListeners.delete(listener)
    }

    /**
     * 序列化配置（用于跨进程传递）
     */
    static serialize(): SerializedRuntimeConfig {
        return {
            workingDir: currentWorkingDir,
            scheme: currentScheme,
            providers: currentProviders,
            mode: currentMode,
            settings: currentSettings,
            version: configVersion,
        }
    }

    /**
     * 从序列化数据恢复配置（用于 Worker 进程初始化）
     */
    static deserialize(data: SerializedRuntimeConfig): void {
        currentWorkingDir = data.workingDir
        currentScheme = data.scheme
        currentProviders = data.providers
        currentMode = data.mode
        currentSettings = data.settings
        configVersion = data.version
        lastUpdatedAt = Date.now()

        updateRoleProviderCache()

        // 配置已同步
    }

    /**
     * 更新运行时配置（用于 Worker 进程接收主进程广播）
     */
    static syncFromMain(data: {
        scheme?: { id: string; scheme: ModelScheme; providers: LLMProvider[] }
        mode?: RunMode
        workMode?: WorkMode
        workingDir?: string
        settings?: SystemSettings
    }): void {
        if (data.scheme) {
            currentScheme = data.scheme.scheme
            currentProviders = data.scheme.providers
            updateRoleProviderCache()
        }
        if (data.mode !== undefined) {
            currentMode = data.mode
        }
        if (data.workMode !== undefined) {
            currentWorkMode = data.workMode
        }
        if (data.workingDir !== undefined) {
            currentWorkingDir = data.workingDir
        }
        if (data.settings !== undefined) {
            currentSettings = data.settings
        }
        notifyChange()
    }
}

// ─── 导出 ─────────────────────────────────────────────────

export {RuntimeConfigManager as runtimeConfigManager}
