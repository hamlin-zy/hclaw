/**
 * 能力映射器 - 维护插件与能力之间的关系
 *
 * 目的：
 * - 清晰记录每个插件提供了哪些能力（Agent/Skill/MCP）
 * - 便于批量操作（如禁用插件时禁用所有相关能力）
 * - 避免依赖 tags 中的 plugin:xxx 解析
 */

export class CapabilityMapper {
    /** 插件名称 -> 能力 ID 列表 */
    private pluginToCapabilities: Map<string, string[]> = new Map()
    /** 能力 ID -> 插件名称 */
    private capabilityToPlugin: Map<string, string> = new Map()

    /**
     * 记录能力属于哪个插件
     * @param pluginName 插件名称（如果是本地能力，可以传 null 或 'local'）
     * @param capabilityId 能力 ID
     */
    trackCapability(pluginName: string | undefined, capabilityId: string): void {
        if (!pluginName) {
            // 本地能力，不追踪
            return
        }

        // pluginToCapabilities 映射
        if (!this.pluginToCapabilities.has(pluginName)) {
            this.pluginToCapabilities.set(pluginName, [])
        }
        const capList = this.pluginToCapabilities.get(pluginName)!
        if (!capList.includes(capabilityId)) {
            capList.push(capabilityId)
        }

        // capabilityToPlugin 映射
        this.capabilityToPlugin.set(capabilityId, pluginName)
    }

    /**
     * 获取插件提供的所有能力 ID
     */
    getCapabilitiesByPlugin(pluginName: string): string[] {
        return this.pluginToCapabilities.get(pluginName) || []
    }

    /**
     * 获取能力所属的插件名称
     */
    getPluginByCapability(capabilityId: string): string | undefined {
        return this.capabilityToPlugin.get(capabilityId)
    }

    /**
     * 移除插件及其所有能力映射
     * @returns 被移除的能力 ID 数量
     */
    removePlugin(pluginName: string): number {
        const capabilities = this.pluginToCapabilities.get(pluginName)
        if (!capabilities) return 0

        // 清除 capabilityToPlugin 映射
        for (const capId of capabilities) {
            this.capabilityToPlugin.delete(capId)
        }

        // 清除 pluginToCapabilities 映射
        this.pluginToCapabilities.delete(pluginName)

        return capabilities.length
    }

    /**
     * 移除单个能力的映射
     */
    removeCapability(capabilityId: string): void {
        const pluginName = this.capabilityToPlugin.get(capabilityId)
        if (!pluginName) return

        // 从 pluginToCapabilities 中移除
        const capList = this.pluginToCapabilities.get(pluginName)
        if (capList) {
            const index = capList.indexOf(capabilityId)
            if (index > -1) {
                capList.splice(index, 1)
            }
        }

        // 从 capabilityToPlugin 中移除
        this.capabilityToPlugin.delete(capabilityId)
    }

    /**
     * 获取所有插件名称
     */
    getAllPlugins(): string[] {
        return Array.from(this.pluginToCapabilities.keys())
    }

    /**
     * 获取所有能力 ID
     */
    getAllCapabilities(): string[] {
        return Array.from(this.capabilityToPlugin.keys())
    }

    /**
     * 清空所有映射
     */
    clear(): void {
        this.pluginToCapabilities.clear()
        this.capabilityToPlugin.clear()
    }

    /**
     * 获取统计信息
     */
    getStats(): { pluginCount: number; capabilityCount: number } {
        return {
            pluginCount: this.pluginToCapabilities.size,
            capabilityCount: this.capabilityToPlugin.size,
        }
    }
}

/**
 * 全局能力映射器实例
 */
export const capabilityMapper = new CapabilityMapper()
