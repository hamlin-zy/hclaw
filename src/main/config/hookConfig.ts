import path from 'path'
import fs from 'fs'
import {getHclawDir} from '../config'

/** Hook 配置类型 */
export interface HookConfigEntry {
    type: string
    command: string
    timeout: number
    enabled: boolean
    source: string
    pluginName: string | null
    events?: string[]
    description?: string
    shell?: string
    matcher?: string
    url?: string
    method?: string
    body?: string
    prompt?: string
    [key: string]: unknown
}

/** 运行时 Hook 定义 */
export interface HookDefinition {
    id: string
    name: string
    description: string
    events: string[]
    config: Record<string, unknown>
    enabled: boolean
    source: 'builtin' | 'user' | 'plugin'
    pluginName?: string
    createdAt: number
    updatedAt: number
}

/** 获取 hooks.json 文件路径 */
export function getHookConfigPath(): string {
    return path.join(getHclawDir(), 'hooks.json')
}

/**
 * 从 name 哈希派生稳定 id
 */
export function hashName(name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        const char = name.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
    }
    return `hook-${Math.abs(hash).toString(36)}`
}

/** JSON 条目中属于顶层而非 config 的键 */
const TOP_LEVEL_KEYS = new Set(['enabled', 'source', 'pluginName', 'events', 'description'])

/** 从 JSON map 解析为 HookDefinition[] */
function parseHooks(raw: Record<string, HookConfigEntry>): HookDefinition[] {
    const now = Date.now()
    return Object.entries(raw).map(([name, entry]) => {
        const config: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(entry)) {
            if (!TOP_LEVEL_KEYS.has(key) && value !== undefined) {
                config[key] = value
            }
        }
        return {
            id: hashName(name),
            name,
            description: entry.description || '',
            events: entry.events || [],
            config,
            enabled: entry.enabled ?? true,
            source: (entry.source as 'builtin' | 'user' | 'plugin') || 'user',
            pluginName: entry.pluginName || undefined,
            createdAt: now,
            updatedAt: now,
        }
    })
}

/** 将 HookDefinition[] 序列化为 JSON map */
function serializeHooks(hooks: HookDefinition[]): Record<string, unknown> {
    const map: Record<string, unknown> = {}
    for (const h of hooks) {
        map[h.name] = {
            ...(h.config as object),
            enabled: h.enabled,
            source: h.source,
            pluginName: h.pluginName || null,
            events: h.events,
            description: h.description,
        }
    }
    return {hooks: map}
}

/**
 * 读取 Hook 配置（仅从 JSON 文件）
 */
export function readHookConfig(): HookDefinition[] {
    const jsonPath = getHookConfigPath()

    if (!fs.existsSync(jsonPath)) return []

    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
        const hooks = raw.hooks || {}
        return parseHooks(hooks)
    } catch (err) {
        console.error('[hookConfig] parse failed:', err)
        return []
    }
}

/**
 * 写入 Hook 配置
 */
export function writeHookConfig(hooks: HookDefinition[]): boolean {
    try {
        const jsonPath = getHookConfigPath()
        const data = serializeHooks(hooks)
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8')

        // 触发 ConfigChange Hook
        import('../plugin/hooks').then(({hookExecutor}) => {
            hookExecutor.execute('ConfigChange', {
                sessionId: 'system',
                configKey: 'hooks',
                configValue: {count: hooks.length},
            }).catch(() => {})
        }).catch(() => {})

        return true
    } catch (err) {
        console.error('[hookConfig] write failed:', err)
        return false
    }
}

/**
 * 获取插件 hook 的启用状态
 */
export function getPluginHookEnabled(pluginName: string, hookId: string): boolean {
    const hooks = readHookConfig()
    const hook = hooks.find(h => h.id === hookId && h.pluginName === pluginName)
    if (!hook) return true
    return hook.enabled
}

/**
 * 同步插件 hooks 到 JSON 配置
 *
 * 使用 hashName(name) 作为 ID 以兼容 parseHooks 的 ID 生成逻辑，
 * 确保插件 hook 被首次写入后，后续同步能正确识别并跳过（避免覆盖用户修改）。
 */
export function syncPluginHooks(
    pluginName: string,
    hooks: Array<{ id: string; name: string; description: string; events: string[]; config: Record<string, unknown> }>
): void {
    const existing = readHookConfig()
    const existingIds = new Set(existing.filter(h => h.pluginName === pluginName).map(h => h.id))
    const now = Date.now()

    for (const hook of hooks) {
        // 使用 hash-based ID 以兼容 parseHooks 的 ID 生成逻辑
        const hashId = hashName(hook.name)
        if (existingIds.has(hashId)) continue
        existing.push({
            id: hashId,
            name: hook.name,
            description: hook.description || '',
            events: hook.events || [],
            config: hook.config,
            enabled: true,
            source: 'plugin',
            pluginName,
            createdAt: now,
            updatedAt: now,
        })
    }

    // 使用 hash-based ID 进行清理，确保不会错误移除用户修改过的 hook
    const currentIds = new Set(hooks.map(h => hashName(h.name)))
    const filtered = existing.filter(h => h.pluginName !== pluginName || currentIds.has(h.id))
    writeHookConfig(filtered)
}

/**
 * 删除插件的所有 hooks
 */
export function deletePluginHooks(pluginName: string): void {
    const existing = readHookConfig()
    const filtered = existing.filter(h => h.pluginName !== pluginName)
    writeHookConfig(filtered)
}
