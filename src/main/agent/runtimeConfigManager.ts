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
import type {LLMProvider, ModelRole, ModelScheme, RunMode, SystemSettings} from '@shared/types'
import type {ModelOverride} from '@shared/types'
import {setCurrentScheme as setModelScheme} from './model/modelSchemeManager'
import {getConfigBridge, setConfigBridge} from './common/configBridge'
// Task 5 override 状态机的会话仓库工厂：统一从 repositories barrel 导入，
// 避免运行时双路径解析（mock 工厂优先 + 类兜底）带来的维护脆弱性。
import {createConversationRepository} from '../repositories'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'

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

// ─── 全局状态 ─────────────────────────────────────────────

let currentWorkingDir: string = DEFAULT_WORKING_DIR
let currentScheme: ModelScheme | null = null
let currentProviders: LLMProvider[] = []
let currentMode: RunMode = DEFAULT_MODE
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

    // ─── 会话级模型 override ─────────────────────────────────

    /** 会话 → override 内存缓存（null=显式 auto；无 key=未加载） */
    private static sessionOverrides = new Map<string, ModelOverride | null>()

    /** 读取指定会话的 override：内存缓存 → 懒加载 DB（缺省 null=auto） */
    static getOverride(convId: string): ModelOverride | null {
        const cached = this.sessionOverrides.get(convId)
        if (cached !== undefined) return cached
        let stored: ModelOverride | null = null
        try {
            const meta = createConversationRepository().readMeta(convId) as { modelOverride?: ModelOverride | null } | null
            stored = meta?.modelOverride ?? null
        } catch {
            stored = null
        }
        this.sessionOverrides.set(convId, stored)
        return stored
    }

    /**
     * 设置会话 override：更新会话内存缓存 + 落库，通知变更。
     * 仅主进程（UI 会话 / 渠道 / worker 定时任务会话创建固化）调用。
     */
    static setOverride(convId: string, override: ModelOverride | null): void {
        this.sessionOverrides.set(convId, override)
        try {
            createConversationRepository().updateMeta(convId, {modelOverride: override ?? null} as any)
        } catch (err) {
            logger.warn('[RuntimeConfigManager] setOverride 持久化失败', {error: String(err), convId})
        }
        notifyChange()
    }

    /**
     * 主进程同步到 worker 的入口：仅更新内存 Map。
     * 会话 override 已由主进程固化到 DB，worker 侧不得重复落库。
     */
    static applyOverrideFromMain(convId: string, override: ModelOverride | null): void {
        this.sessionOverrides.set(convId, override)
    }

    // ─── 会话级权限模式（与会话级 model override 同构） ───────────────

    /** 会话 → 权限模式内存缓存（无 key=未加载） */
    private static sessionPermissionModes = new Map<string, RunMode>()

    /**
     * 读取指定会话的权限模式：内存缓存 → 懒加载 meta.permissionMode
     * → 回退全局 system_settings.permission_mode → 'safe'。
     * 回退值不缓存：全局默认是活值，缓存会固化快照使无覆盖会话永不跟随全局变更。
     */
    static getConvPermissionMode(convId: string): RunMode {
        const cached = this.sessionPermissionModes.get(convId)
        if (cached !== undefined) return cached
        let stored: RunMode | null = null
        try {
            const meta = createConversationRepository().readMeta(convId) as { permissionMode?: RunMode | null } | null
            stored = meta?.permissionMode ?? null
        } catch {
            stored = null
        }
        if (stored) {
            this.sessionPermissionModes.set(convId, stored)
            return stored
        }
        // 回退全局默认（system_settings.permission_mode 是全局权威）
        // 回退值不缓存：全局默认是「活」值，缓存会固化为快照，使无覆盖会话在 worker
        // 重启后永不跟随全局默认变更（与「全局默认=启动时快照来源」的设计语义矛盾）
        let globalMode: RunMode = 'safe'
        try {
            const raw = systemSettingsRepo.get('permission_mode')
            if (raw === 'auto' || raw === 'safe') globalMode = raw
        } catch {
            // 读取失败保持 'safe'
        }
        return globalMode
    }

    /**
     * 设置会话权限模式：更新内存缓存 + 落库 meta，通知变更。
     * 仅主进程（UI 会话切换 / 渠道会话创建固化）调用。
     * 注意：不写 system_settings.permission_mode（全局默认保持权威）。
     */
    static setConvPermissionMode(convId: string, mode: RunMode): void {
        this.sessionPermissionModes.set(convId, mode)
        try {
            createConversationRepository().updateMeta(convId, {permissionMode: mode} as any)
        } catch (err) {
            logger.warn('[RuntimeConfigManager] setConvPermissionMode 持久化失败', {error: String(err), convId})
        }
        notifyChange()
    }

    /**
     * 主进程同步到 worker 的入口：仅更新内存 Map。
     * 会话模式已由主进程固化到 DB，worker 侧不得重复落库。
     */
    static applyConvPermissionModeFromMain(convId: string, mode: RunMode): void {
        this.sessionPermissionModes.set(convId, mode)
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
