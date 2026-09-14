/**
 * 插件归属（Plugin Ownership）—— 能力归属与启用判定的唯一权威实现。
 *
 * 判定「一条能力属于哪个插件 / 该插件是否启用 / 该能力是否启用」。
 * 规范插件 ID = `manifest.name`（= plugins 表 name 列）；目录名 `${name}@{source}`
 * 与路径仅作定位，加载时一次性映射到 manifest.name。
 *
 * 启用判定优先级（唯一实现）：
 *   1. 插件禁用 → 强制 off（对所有能力类型，含 command）
 *   2. 单条能力 override 表值（agent_overrides / skill_overrides / command_overrides）
 *   3. 文件 / manifest 默认值
 *
 * 核心判定为纯函数；PluginRegistry 与 override 读取经 OwnershipDeps 薄适配层注入，
 * 单测可替换依赖。
 */

import {PluginRegistry} from '../plugin/registry'
import {getDatabase} from '../repositories/sqlite'

export type CapabilityKind = 'agent' | 'skill' | 'command'

export interface CapabilityIdentity {
    kind: CapabilityKind
    id: string
    /** agent 归属线索：`plugin:<name>` 标签 */
    tags?: string[]
    /** skill / command 的直接插件名；command 传 null 视为文件命令（无插件归属） */
    pluginName?: string | null
    /** 文件 / manifest 中的默认启用态，缺省视为 true */
    fileEnabled?: boolean
}

export interface Ownership {
    pluginName: string | null
    pluginEnabled: boolean
    capabilityEnabled: boolean
}

/** 依赖适配层：PluginRegistry / SQLite 读取集中于此，单测可替换 */
export interface OwnershipDeps {
    getDisabledNames(): Set<string>
    getOverrideEnabled(kind: CapabilityKind, id: string): boolean | undefined
}

const PLUGIN_TAG_PREFIX = 'plugin:'

// ─── 纯函数（可独立测试） ──────────────────────────────────

/**
 * 从能力身份中解析插件归属（返回规范插件 ID）。
 *
 * - agent：取 tag `plugin:<name>`（插件 agent 扫描时必带该 tag，见
 *   agentLoader.scanAgentsFromPlugin 的 extraTags；真实插件 agent id 形如
 *   `${manifest.name}:${prefix}`，故不再用 id 前缀兜底）
 * - skill / command：取入参 `pluginName`（command 为 null 表示文件命令）
 */
export function extractPluginName(input: CapabilityIdentity): string | null {
    switch (input.kind) {
        case 'agent': {
            const tag = input.tags?.find(t => t.startsWith(PLUGIN_TAG_PREFIX))
            if (tag) {
                const name = tag.slice(PLUGIN_TAG_PREFIX.length)
                if (name) return name
            }
            return null
        }
        case 'skill':
        case 'command':
            return input.pluginName ?? null
    }
}

/**
 * 按判定优先级计算启用态（纯函数）：
 * 插件禁用 > override 表值 > 文件/manifest 默认值。
 */
export function applyEnablement(
    pluginName: string | null,
    pluginDisabled: boolean,
    overrideEnabled: boolean | undefined,
    fileEnabled: boolean | undefined,
): Ownership {
    const pluginEnabled = !pluginDisabled
    let capabilityEnabled: boolean
    if (!pluginEnabled) {
        capabilityEnabled = false
    } else if (overrideEnabled !== undefined) {
        capabilityEnabled = overrideEnabled
    } else {
        capabilityEnabled = fileEnabled ?? true
    }
    return {pluginName, pluginEnabled, capabilityEnabled}
}

/**
 * 解析一条能力的归属与启用态。
 * @param deps 依赖适配层，缺省读取 PluginRegistry + SQLite override 表
 */
export function resolve(
    input: CapabilityIdentity,
    deps: OwnershipDeps = createSqliteOwnershipDeps(),
): Ownership {
    const pluginName = extractPluginName(input)
    const pluginDisabled = pluginName !== null && deps.getDisabledNames().has(pluginName)
    const overrideEnabled = deps.getOverrideEnabled(input.kind, input.id)
    return applyEnablement(pluginName, pluginDisabled, overrideEnabled, input.fileEnabled)
}

// ─── 默认依赖适配层（SQLite + PluginRegistry） ─────────────

const OVERRIDE_TABLES: Record<CapabilityKind, { table: string; column: string }> = {
    agent: {table: 'agent_overrides', column: 'agent_id'},
    skill: {table: 'skill_overrides', column: 'skill_id'},
    command: {table: 'command_overrides', column: 'command_id'},
}

function readOverrideMap(kind: CapabilityKind): Map<string, boolean> {
    const result = new Map<string, boolean>()
    try {
        const {table, column} = OVERRIDE_TABLES[kind]
        const rows = getDatabase()
            .prepare(`SELECT ${column} AS id, enabled FROM ${table}`)
            .all() as Array<{ id: string; enabled: number }>
        for (const row of rows) result.set(row.id, row.enabled === 1)
    } catch {
        // 读取失败视为无覆盖
    }
    return result
}

/**
 * 构造默认依赖：插件禁用集合取自 PluginRegistry，override 表按 kind 惰性读取并
 * 在同一次操作内复用快照（避免逐条查库）。
 */
export function createSqliteOwnershipDeps(): OwnershipDeps {
    const overrideCache = new Map<CapabilityKind, Map<string, boolean>>()
    return {
        getDisabledNames: () => PluginRegistry.getInstance().getDisabledNames(),
        getOverrideEnabled: (kind, id) => {
            let map = overrideCache.get(kind)
            if (!map) {
                map = readOverrideMap(kind)
                overrideCache.set(kind, map)
            }
            return map.get(id)
        },
    }
}
