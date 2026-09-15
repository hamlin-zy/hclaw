/**
 * pluginStore — 插件管理状态（列表 / 真实计数 / 能力详情 / 版本下拉 / 三态）
 *
 * 承载原 PluginDialog 组件内的全部插件数据 useState，并集中插件动作。
 * - 列表/计数/详情/版本数据是插件域的权威状态，随动作一起下沉；
 * - 启停（toggle）走 applyOptimistic：先乐观改内存 → IPC → 失败回滚；
 * - 启停成功后**不再跨 store 直写** skill/agent store：主进程 enable/disable 已
 *   经 powerManager.refresh → capabilityHub.replaceAll → 广播 capability:changed，
 *   其余页面由 useCapabilityRefresh 自行重取（A 阶段口径）。
 * - 版本「元数据缓存」（current/latest/hasUpdate 红点）语义不同，仍由
 *   pluginUpdateStore 承担，此处只持有版本下拉所需的 tags/branches。
 */

import {create} from 'zustand'
import {applyOptimistic, toErrorMessage} from './applyOptimistic'

// ─── 类型（镜像主进程 PluginManifest / 能力详情） ──────────

export interface PluginManifest {
    name: string
    version?: string
    description?: string
    author?: { name: string; email?: string }
    repository?: string
    homepage?: string
    userConfig?: Record<string, {
        type: 'string' | 'number' | 'boolean'
        title?: string
        description?: string
        required?: boolean
        sensitive?: boolean
        default?: unknown
        min?: number
        max?: number
    }>
}

export interface PluginCapabilityDetails {
    commands?: Array<{
        id: string
        name: string
        description?: string
        args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
    }>
    skills?: Array<{
        name: string
        description: string
        allowedTools?: string[]
        userInvocable?: boolean
    }>
    agents?: Array<{
        name: string
        description: string
        type?: string
    }>
    mcpServers?: Array<{
        command: string
        args?: string[]
        env?: Record<string, string>
    }>
    userConfig?: Record<string, {
        type: string
        title?: string
        description?: string
        required?: boolean
    }>
}

export interface LoadedPlugin extends PluginCapabilityDetails {
    name: string
    source: string
    path: string
    manifest: PluginManifest
    enabled: boolean
    isBuiltin: boolean
}

/** 权威注册表（skillRegistry/agentRegistry/mcpService）给出的真实计数 */
export interface PluginRealCounts {
    skills: number
    agents: number
    mcps: number
}

/** 展开详情用的真实能力明细（按需从权威注册表拉取） */
export interface PluginCapabilityDetailMap {
    skills: Array<{ name: string; description?: string; userInvocable?: boolean; allowedTools?: string[] }>
    agents: Array<{ name: string; description?: string; type?: string }>
    mcps: Array<{ command: string; args?: string[]; env?: Record<string, string> }>
}

/** 版本下拉数据（tags/branches 列表） */
export interface PluginVersionData {
    tags: string[]
    branches: string[]
    current: string
    latest: string
    loading: boolean
    hasUpdate?: boolean
}

export type PluginActionResult = { success: true } | { success: false; error: string }
export type PluginVersionResult =
    | { success: true; versionInfo?: PluginVersionData }
    | { success: false; error: string }

/**
 * 把主进程 PluginError 转成人类可读字符串（保留原组件 getErrorMessage 的口径）。
 */
export function pluginErrorMessage(error: unknown): string {
    if (!error || typeof error === 'string') return String(error ?? '未知错误')
    const e = error as Record<string, any>
    if (e.message) return e.message
    switch (e.type) {
        case 'manifest-not-found': return `Manifest not found: ${e.path}`
        case 'manifest-invalid': return `Invalid manifest: ${e.errors?.join(', ')}`
        case 'plugin-not-found': return `Plugin not found: ${e.name}`
        case 'dependency-unsatisfied': return `Missing dependencies: ${e.deps?.join(', ')}`
        default: return e.type ? String(e.type) : toErrorMessage(error)
    }
}

interface PluginStore {
    plugins: LoadedPlugin[]
    realCounts: Record<string, PluginRealCounts>
    capabilityDetails: Record<string, PluginCapabilityDetailMap>
    versionData: Record<string, PluginVersionData>
    loading: boolean
    error: string | null
    initialized: boolean

    /** 拉取插件列表 + 真实计数（首帧展示 loading，后续刷新静默替换） */
    loadPlugins: () => Promise<void>
    /** 按需拉取单个插件的真实能力明细（已缓存则跳过） */
    loadCapabilityDetails: (name: string) => Promise<void>
    /** 拉取版本下拉数据（tags/branches） */
    loadVersionInfo: (name: string, fallbackCurrent?: string) => Promise<void>
    /** 「同步版本」：只 fetch tags，不切换 */
    syncVersions: (name: string) => Promise<PluginVersionResult>
    /** 切换版本（git checkout + powerManager.refresh） */
    switchVersion: (name: string, ref: string) => Promise<PluginVersionResult>
    installPlugin: (url: string) => Promise<PluginActionResult>
    uninstallPlugin: (name: string) => Promise<PluginActionResult>
    /** 启用/禁用（乐观更新；成功后主进程广播 capability:changed） */
    togglePlugin: (name: string, enabled: boolean) => Promise<PluginActionResult>
    reloadPlugins: () => Promise<PluginActionResult>
    resetPlugin: (name: string) => Promise<PluginActionResult>
    clearError: () => void
}

const pluginApi = () => (window.electronAPI as any)?.plugin

/** 删除某插件的缓存条目（capabilityDetails / versionData 均为条目级创建、无删除路径，
 *  卸载/重置后须一并移除，否则残留条目会随 key 常驻）。 */
function dropPluginCaches(
    name: string,
    set: (fn: (s: PluginStore) => Partial<PluginStore>) => void,
): void {
    set((s) => {
        const capabilityDetails = {...s.capabilityDetails}
        const versionData = {...s.versionData}
        delete capabilityDetails[name]
        delete versionData[name]
        return {capabilityDetails, versionData}
    })
}

export const usePluginStore = create<PluginStore>((set, get) => ({
    plugins: [],
    realCounts: {},
    capabilityDetails: {},
    versionData: {},
    loading: true,
    error: null,
    initialized: false,

    loadPlugins: async () => {
        // 首帧 loading，后续（刷新 / capability:changed）静默替换，避免列表卸载重建
        if (!get().initialized) set({loading: true})
        try {
            const api = pluginApi()
            const list = await api?.list?.()
            const counts = await api?.getRealCounts?.()
            set({
                plugins: Array.isArray(list) ? (list as LoadedPlugin[]) : [],
                realCounts: (counts as Record<string, PluginRealCounts>) || {},
                error: null,
                initialized: true,
            })
        } catch (err) {
            set({error: toErrorMessage(err)})
        } finally {
            set({loading: false})
        }
    },

    loadCapabilityDetails: async (name) => {
        if (get().capabilityDetails[name]) return
        try {
            const details = await pluginApi()?.getCapabilityDetails?.(name)
            if (details) {
                set((s) => ({capabilityDetails: {...s.capabilityDetails, [name]: details}}))
            }
        } catch {
            // 详情拉取失败不阻塞列表：降级到 PluginLoader 的简化快照（plugin.skills/agents/mcpServers）
        }
    },

    loadVersionInfo: async (name, fallbackCurrent) => {
        set((s) => {
            const prev = s.versionData[name]
            if (prev && !prev.loading) return s
            return {
                versionData: {
                    ...s.versionData,
                    [name]: {
                        tags: [],
                        branches: [],
                        current: prev?.current || fallbackCurrent || '',
                        latest: '',
                        loading: true,
                    },
                },
            }
        })
        try {
            const versions = await pluginApi()?.getVersions?.(name)
            if (versions) {
                set((s) => ({versionData: {...s.versionData, [name]: {...versions, loading: false}}}))
            }
        } catch {
            // 版本下拉不可用即可（不阻塞页面），保留 loading 占位由重试兜底
            set((s) => ({versionData: {...s.versionData, [name]: {...s.versionData[name], loading: false}}}))
        }
    },

    syncVersions: async (name) => {
        try {
            const result = await pluginApi()?.syncVersions?.(name)
            if (result?.versionInfo) {
                set((s) => ({versionData: {...s.versionData, [name]: {...result.versionInfo, loading: false}}}))
                return {success: true, versionInfo: result.versionInfo}
            }
            return {success: false, error: '同步失败'}
        } catch (err) {
            return {success: false, error: toErrorMessage(err)}
        }
    },

    switchVersion: async (name, ref) => {
        try {
            const result = await pluginApi()?.switchVersion?.(name, ref)
            if (result?.success) {
                if (result.versionInfo) {
                    set((s) => ({versionData: {...s.versionData, [name]: {...result.versionInfo, loading: false}}}))
                }
                // 主进程 powerManager.refresh 会广播 capability:changed，这里补齐本页列表
                await get().loadPlugins()
                return {success: true, versionInfo: result.versionInfo}
            }
            return {success: false, error: pluginErrorMessage(result?.error)}
        } catch (err) {
            return {success: false, error: toErrorMessage(err)}
        }
    },

    installPlugin: async (url) => {
        try {
            const result = await pluginApi()?.install?.(url)
            if (result?.success) {
                // 新插件的能力广播由主进程发出，其它页自取；本页刷新列表
                await get().loadPlugins()
                return {success: true}
            }
            return {success: false, error: result?.error ? pluginErrorMessage(result.error) : '安装失败'}
        } catch (err) {
            return {success: false, error: toErrorMessage(err)}
        }
    },

    uninstallPlugin: async (name) => {
        try {
            const result = await pluginApi()?.uninstall?.(name)
            if (result?.success) {
                // 卸载成功后该插件的能力明细/版本数据条目不应残留（条目级创建、无删除路径）
                dropPluginCaches(name, set)
                await get().loadPlugins()
                return {success: true}
            }
            return {success: false, error: pluginErrorMessage(result?.error)}
        } catch (err) {
            return {success: false, error: toErrorMessage(err)}
        }
    },

    togglePlugin: async (name, enabled) => {
        // applyOptimistic 的 snapshot 是「回滚副作用」函数（失败时调用），
        // 需在 mutate 前捕获前值，不能写成惰性 getter。
        const prev = get().plugins
        const result = await applyOptimistic<{ success: boolean }>({
            snapshot: () => {
                set({plugins: prev})
            },
            mutate: () => set((s) => ({
                plugins: s.plugins.map((p) => (p.name === name ? {...p, enabled} : p)),
            })),
            persist: async () => {
                const api = pluginApi()
                const r = enabled ? await api?.enable?.(name) : await api?.disable?.(name)
                if (!r?.success) {
                    throw new Error(r?.error
                        ? pluginErrorMessage(r.error)
                        : (enabled ? '启用插件失败' : '禁用插件失败'))
                }
                return r
            },
        })

        if (!result.ok) return {success: false, error: result.error}

        // 主进程 enable/disable 已 powerManager.refresh → capabilityHub.replaceAll → capability:changed，
        // skills/agents 等由其它页 useCapabilityRefresh 自取，此处不做跨 store 直写。
        await get().loadPlugins()
        return {success: true}
    },

    reloadPlugins: async () => {
        try {
            const result = await pluginApi()?.reload?.()
            if (result?.success) {
                if (Array.isArray(result.plugins)) {
                    set({plugins: result.plugins as LoadedPlugin[], error: null})
                } else {
                    await get().loadPlugins()
                }
                return {success: true}
            }
            const error = result?.error ? pluginErrorMessage(result.error) : '刷新插件失败'
            set({error})
            return {success: false, error}
        } catch (err) {
            const error = toErrorMessage(err)
            set({error})
            return {success: false, error}
        }
    },

    resetPlugin: async (name) => {
        try {
            const result = await pluginApi()?.reset?.(name)
            if (result?.success) {
                // 重置即抹掉该插件的本地改动，缓存的能力明细/版本数据条目一并移除
                dropPluginCaches(name, set)
                await get().loadPlugins()
                return {success: true}
            }
            return {success: false, error: pluginErrorMessage(result?.error)}
        } catch (err) {
            return {success: false, error: toErrorMessage(err)}
        }
    },

    clearError: () => set({error: null}),
}))
