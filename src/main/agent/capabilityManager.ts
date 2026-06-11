/**
 * CapabilityManager - 能力管理器
 *
 * 职责：
 * 1. 统一管理 Agent、Skill、MCP 能力的生命周期
 * 2. 提供能力序列化/反序列化，用于 Worker 通信
 * 3. 维护能力与插件的映射关系
 *
 * 架构：
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    CapabilityManager                        │
 * │  - PowerManager (加载能力)                                  │
 * │  - CapabilitySerializer (序列化能力)                         │
 * │  - CapabilityMapper (维护映射)                              │
 * └─────────────────────────────────────────────────────────────┘
 */

import type {EnabledPower} from './powerManager'
import {powerManager} from './powerManager'
import {type SerializableCapabilities, serializeCapabilities,} from '../common/capabilitySerializer'
import {capabilityMapper} from '../common/capabilityMapper'
import {logger} from './logger'

/**
 * 能力管理器类
 * 提供统一的能力管理和序列化接口
 */
class CapabilityManagerImpl {
    /**
     * 初始化能力（主进程调用）
     */
    async initialize(pluginEnabledMap?: Record<string, boolean>): Promise<void> {
        await powerManager.initialize(pluginEnabledMap)
    }

    /**
     * 刷新能力（插件状态变更后调用）
     */
    async refresh(): Promise<void> {
        await powerManager.refresh()
    }

    /**
     * 获取所有启用的能力
     */
    async getEnabledPower(): Promise<EnabledPower> {
        return powerManager.getAllEnabledPower()
    }

    /**
     * 序列化能力列表（用于传递给 Worker）
     */
    async serializeForWorker(): Promise<SerializableCapabilities> {
        const power = await this.getEnabledPower()

        // 调试日志：确认插件技能是否包含在序列化结果中
        const pluginSkills = power.skills.filter(s => s.pluginName)
        const localSkills = power.skills.filter(s => !s.pluginName)
        logger.debug('[CapabilityManager]', {
            action: 'serializeForWorker',
            agents: power.agents.length,
            skills: power.skills.length,
            localSkills: localSkills.length,
            pluginSkills: pluginSkills.length
        })

        return serializeCapabilities(power)
    }

    /**
     * 获取能力映射统计
     */
    getMappingStats(): { pluginCount: number; capabilityCount: number } {
        return capabilityMapper.getStats()
    }

    /**
     * 获取插件的所有能力
     */
    getCapabilitiesByPlugin(pluginName: string): string[] {
        return capabilityMapper.getCapabilitiesByPlugin(pluginName)
    }

    /**
     * 获取能力所属的插件
     */
    getPluginByCapability(capabilityId: string): string | undefined {
        return capabilityMapper.getPluginByCapability(capabilityId)
    }
}

/** 全局实例 */
export const capabilityManager = new CapabilityManagerImpl()

/**
 * 在 Worker 中直接应用序列化后的能力
 * 不再需要重新加载，只需将能力注册到对应的注册表
 */
export async function applySerializedCapabilitiesInWorker(
    capabilities: SerializableCapabilities
): Promise<void> {
    const {agentRegistry} = await import('./agentRegistry')
    const {skillRegistry} = await import('./skills')

    // 调试日志：统计插件技能
    const pluginSkills = capabilities.skills.filter(s => s.pluginName)
    const localSkills = capabilities.skills.filter(s => !s.pluginName)
    logger.debug('[CapabilityManager]', {
        action: 'applySerializedCapabilitiesInWorker',
        agents: capabilities.agents.length,
        skills: capabilities.skills.length,
        localSkills: localSkills.length,
        pluginSkills: pluginSkills.length
    })

    // 注册 Agents
    for (const agent of capabilities.agents) {
        agentRegistry.register(agent)
    }

    // 注册 Skills
    for (const skill of capabilities.skills) {
        skillRegistry.register(skill as any)
    }

    // 验证注册结果
    const registeredSkills = skillRegistry.getAll()
    const registeredPluginSkills = registeredSkills.filter(s => s.pluginName)
    logger.debug('[CapabilityManager]', {
        action: 'skillRegistryAfterApply',
        totalSkills: registeredSkills.length,
        pluginSkills: registeredPluginSkills.length
    })

}
