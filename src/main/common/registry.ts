/**
 * 统一的能力注册表接口
 *
 * 目的：
 * - 统一 Agent、Skill、MCP 等能力的注册表 API
 * - 提供通用的插件状态同步机制
 * - 便于扩展新的能力类型
 */

/**
 * 能力项的基础接口
 */
export interface ICapabilityItem {
    id: string
    enabled: boolean
    pluginName?: string
    tags?: string[]
}

/**
 * 统一的能力注册表接口
 */
export interface ICapabilityRegistry<T extends ICapabilityItem> {
    /**
     * 注册一个能力项
     */
    register(item: T): void

    /**
     * 注销指定 ID 的能力项
     */
    unregister(id: string): void

    /**
     * 注销指定插件的所有能力项
     * @returns 被注销的数量
     */
    unregisterByPlugin(pluginName: string): number

    /**
     * 获取指定 ID 的能力项
     */
    get(id: string): T | undefined

    /**
     * 获取所有能力项
     */
    getAll(): T[]

    /**
     * 获取所有启用的能力项
     */
    getEnabled(): T[]

    /**
     * 清空所有能力项
     */
    clear(): void

    /**
     * 同步插件启用/禁用状态
     * @param pluginName 插件名称
     * @param enabled 是否启用
     */
    syncPluginStatus(pluginName: string, enabled: boolean): void

    /**
     * 根据名称或 ID 查找能力项（支持模糊匹配）
     */
    find(nameOrId: string): T | undefined
}
