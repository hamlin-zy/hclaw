/**
 * Agent Registry - Manages Agent template registration and lookup
 */

import type {AgentTemplate} from '@shared/types'
import type {ICapabilityRegistry} from '../common/registry'

class AgentRegistryImpl implements ICapabilityRegistry<AgentTemplate> {
    private agents: Map<string, AgentTemplate> = new Map()

    register(agent: AgentTemplate): void {
        this.agents.set(agent.id, agent)
    }

    unregister(agentId: string): void {
        this.agents.delete(agentId)
    }

    /** Remove all agents of the specified plugin */
    unregisterByPlugin(pluginName: string): number {
        const prefix = `plugin:${pluginName}`
        const toRemove = [...this.agents]
            .filter(([id, agent]) => id.startsWith(`${prefix}:`) || agent.tags?.some(tag => tag === prefix))
            .map(([id]) => id)
        toRemove.forEach(id => this.agents.delete(id))
        return toRemove.length
    }

    get(agentId: string): AgentTemplate | undefined {
        return this.agents.get(agentId)
    }

    getAll(): AgentTemplate[] {
        return Array.from(this.agents.values())
    }

    find(agentNameOrId: string): AgentTemplate | undefined {
        const agents = this.getAll()

        // Exact match ID
        let agent = agents.find(a => a.id === agentNameOrId)
        if (agent) return agent

        // Exact match name
        agent = agents.find(a => a.name === agentNameOrId)
        if (agent) return agent

        // Fuzzy match (ignore case and separator)
        const normalized = agentNameOrId.toLowerCase().replace(/[-_]/g, '')
        const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, '')
        const exactFuzzy = agents.find(a => {
            const normalizedName = normalize(a.name)
            const normalizedId = normalize(a.id)
            return normalizedName === normalized || normalizedId === normalized
        })
        if (exactFuzzy) return exactFuzzy

        // Prefix match（前缀匹配，双向：candidate 以输入为前缀，或输入以 candidate 为前缀）
        // LLM 常写 "Explore" 而实际注册名为 "Explore Agent"，反之亦然。
        // 空输入跳过（空串是任何串的前缀，会产生全量误匹配）
        const prefixMatches = normalized === '' ? [] : agents.filter(a => {
            const normalizedName = normalize(a.name)
            const normalizedId = normalize(a.id)
            return (normalizedName.startsWith(normalized) || normalized.startsWith(normalizedName)) ||
                (normalizedId.startsWith(normalized) || normalized.startsWith(normalizedId))
        })
        if (prefixMatches.length === 1) return prefixMatches[0]
        if (prefixMatches.length > 1) {
            // 多个前缀命中时选名称最长者（最具体）；长度相同仍多义 → undefined（调用方会列出候选）
            const sorted = [...prefixMatches].sort((a, b) => normalize(b.name).length - normalize(a.name).length)
            if (normalize(sorted[0].name).length > normalize(sorted[1].name).length) return sorted[0]
        }
        return undefined
    }

    getEnabled(): AgentTemplate[] {
        return this.getAll().filter(a => a.enabled)
    }

    /**
     * 同步插件启用/禁用状态
     * 插件 Agent 的 enabled 状态跟随插件，本地 Agent 使用自身的 enabled 字段
     */
    syncPluginStatus(pluginName: string, enabled: boolean): void {
        for (const agent of this.agents.values()) {
            const pluginTag = agent.tags?.find(tag => tag.startsWith('plugin:'))
            if (pluginTag?.replace('plugin:', '') === pluginName) {
                agent.enabled = enabled
            }
        }
    }

    /** Clear all agents */
    clear(): void {
        this.agents.clear()
    }
}

/** Global singleton */
export const agentRegistry = new AgentRegistryImpl()
