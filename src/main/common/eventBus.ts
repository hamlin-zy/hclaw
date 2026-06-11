/**
 * 事件总线 - 用于解耦插件管理和能力管理
 *
 * 使用场景：
 * - 插件启用/禁用时，自动通知各能力注册表
 * - 插件安装/卸载时，自动触发能力重新加载
 */

export type EventHandler<T = any> = (data: T) => void | Promise<void>

export class EventBus {
    private listeners: Map<string, Set<EventHandler>> = new Map()

    /**
     * 订阅事件
     */
    on(event: string, handler: EventHandler): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set())
        }
        this.listeners.get(event)!.add(handler)
    }

    /**
     * 取消订阅
     */
    off(event: string, handler: EventHandler): void {
        this.listeners.get(event)?.delete(handler)
    }

    /**
     * 发布事件
     */
    async emit(event: string, data: any): Promise<void> {
        const handlers = this.listeners.get(event)
        if (handlers) {
            for (const handler of handlers) {
                try {
                    await handler(data)
                } catch (err) {
                    // Error in event handler
                }
            }
        }
    }

    /**
     * 移除事件的所有监听器
     */
    removeAllListeners(event: string): void {
        this.listeners.delete(event)
    }

    /**
     * 清空所有监听器
     */
    clear(): void {
        this.listeners.clear()
    }
}

/**
 * 全局事件总线实例
 */
export const eventBus = new EventBus()

/**
 * 插件相关事件类型
 */
export const PluginEvents = {
    /** 插件已启用 */
    ENABLED: 'plugin:enabled',
    /** 插件已禁用 */
    DISABLED: 'plugin:disabled',
    /** 插件已安装 */
    INSTALLED: 'plugin:installed',
    /** 插件已卸载 */
    UNINSTALLED: 'plugin:uninstalled',
    /** 插件配置已更新 */
    CONFIG_UPDATED: 'plugin:config-updated',
} as const

/**
 * 能力相关事件类型
 */
export const CapabilityEvents = {
    /** 能力已加载 */
    LOADED: 'capability:loaded',
    /** 能力已刷新 */
    REFRESHED: 'capability:refreshed',
    /** 能力注册表已清空 */
    CLEARED: 'capability:cleared',
} as const

/**
 * MCP 相关事件类型
 */
export const MCPThemeEvents = {
    /** MCP 工具已刷新 */
    TOOLS_REFRESHED: 'mcp:tools-refreshed',
} as const
