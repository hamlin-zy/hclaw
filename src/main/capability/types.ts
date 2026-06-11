/**
 * CapabilityHub — 统一能力中心类型定义
 *
 * CapabilityHub 是系统中所有「可用能力」的统一注册与查询中心。
 * 它将分散在 skillRegistry、agentRegistry、CommandDispatcher 中的能力
 * 抽象为统一的 CapabilityEntry，提供：
 *   - 单一写入入口（幂等注册）
 *   - 插件状态变更的批量同步
 *   - 统一查询接口（按类型/来源/启用状态过滤）
 *
 * 设计原则：
 *   - Hub 不关心持久化（overrides 等由 Loader 层负责）
 *   - Hub 只维护内存状态 + 索引
 *   - Hub 通过 EventEmitter 通知订阅者状态变更
 */

/** 能力类型 */
export type CapabilityType = 'skill' | 'agent' | 'command'

/** 能力来源 */
export type CapabilitySource = 'builtin' | 'user' | 'plugin'

/** 统一能力条目 */
export interface CapabilityEntry {
    /** 全局唯一标识，如 "superpowers:code-reviewer" */
    id: string
    /** 展示名称 */
    name: string
    /** 描述文本（用于搜索和展示） */
    description: string
    /** 能力类型 */
    type: CapabilityType
    /** 来源 */
    source: CapabilitySource

    /** 归属插件名称（仅 source='plugin' 时有值） */
    pluginName?: string
    /** 插件实际启用状态（仅 source='plugin' 时有值）。
     *  独立于 enabled 字段——enabled 可能被用户 override 覆盖，
     *  pluginEnabled 始终反映插件的真实状态 */
    pluginEnabled?: boolean

    /** 最终启用状态（Loader 层已合并 overrides） */
    enabled: boolean

    /** 能力内容 */
    content?: string
    /** 允许的工具白名单 */
    allowedTools?: string[]

    // ── 命令特有字段 ──
    /** 是否有参数占位符 ($ARGUMENTS) */
    hasArgs?: boolean

    /** 预计算的搜索文本（name + description 拼接，小写） */
    searchText: string
}

/** 查询过滤器 */
export interface CapabilityFilter {
    /** 按类型过滤，不传 = 全部 */
    types?: CapabilityType[]
    /** 按来源过滤，不传 = 全部 */
    sources?: CapabilitySource[]
    /** 按启用状态过滤，不传 = 全部 */
    enabled?: boolean
    /** 按插件名过滤，不传 = 全部 */
    pluginName?: string
}

/** Hub 统计信息 */
export interface CapabilityStats {
    total: number
    enabled: number
    byType: Record<CapabilityType, number>
    bySource: Record<CapabilitySource, number>
}

/** 插件分组视图（用于 SkillsDialog 的"插件"标签） */
export interface PluginGroup {
    name: string
    enabled: boolean
    entries: CapabilityEntry[]
}
