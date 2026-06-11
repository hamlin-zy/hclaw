/**
 * 能力序列化器
 *
 * 用于将能力列表序列化为可传递的数据格式，
 * 主要用于 Worker 线程中，避免 Worker 重复加载能力。
 */

import type {AgentTemplate} from '@shared/types'
import type {SkillDefinition} from '../agent/skills/types'
import type {MCPServerState} from '../agent/mcp/types'
import type {EnabledPower} from '../agent/powerManager'

/**
 * 可序列化的能力配置（用于传递给 Worker）
 */
export interface SerializableCapabilities {
    /** 启用的 Agent 模板列表 */
    agents: AgentTemplate[]
    /** 启用的 Skill 定义列表 */
    skills: SerializableSkill[]
    /** 启用的 MCP 服务器状态列表 */
    mcps: SerializableMCPServer[]
}

/**
 * 可序列化的 Skill 定义（移除不可序列化的字段）
 */
export interface SerializableSkill {
    id: string
    name: string
    description?: string
    content?: string
    enabled: boolean
    pluginName?: string
    paths?: string[]
    source?: string
    tags?: string[]
    loadedAt?: number
    /** 技能目录路径（支持扩展目录结构） */
    skillDir?: string
    /** 文件路径 */
    filePath?: string
    /** 用户自定义描述 */
    userDescription?: string
}

/**
 * 可序列化的 MCP 服务器状态
 */
export interface SerializableMCPServer {
    id: string
    name: string
    status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'stopped' | 'reconnecting'
    enabled: boolean
    tools: Array<{
        name: string
        description: string
        inputSchema: Record<string, unknown>
    }>
    userDescription?: string
    pluginName?: string
}

/**
 * 序列化能力列表
 * 将 EnabledPower 转换为可序列化的格式
 */
export function serializeCapabilities(power: EnabledPower): SerializableCapabilities {
    return {
        agents: power.agents,
        skills: power.skills.map(serializeSkill),
        mcps: power.mcps.map(serializeMCPServer),
    }
}

/**
 * 序列化单个 Skill
 */
export function serializeSkill(skill: SkillDefinition): SerializableSkill {
    return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        enabled: skill.enabled,
        pluginName: skill.pluginName,
        paths: skill.paths,
        source: skill.source,
        loadedAt: (skill as any).loadedAt,
        skillDir: skill.skillDir,
        filePath: skill.filePath,
        userDescription: skill.userDescription,
    }
}

/**
 * 序列化单个 MCP 服务器
 */
export function serializeMCPServer(server: MCPServerState): SerializableMCPServer {
    return {
        id: server.config?.id || 'unknown',
        name: server.config?.name || 'unknown',
        status: server.status,
        enabled: server.status === 'connected',
        tools: server.tools.map(tool => ({
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema || {},
        })),
        pluginName: extractPluginName(server.config?.id || ''),
    }
}

/**
 * 从 serverId 提取插件名称
 */
function extractPluginName(serverId: string): string | undefined {
    const match = serverId.match(/^mcp_([^_]+)_.+/)
    return match ? match[1] : undefined
}

/**
 * 反序列化能力列表
 * 将 SerializableCapabilities 转换回能力对象
 */
export function deserializeCapabilities(data: SerializableCapabilities): SerializableCapabilities {
    // SerializableCapabilities 本身就是可序列化的格式
    // 这里只做类型转换
    return data
}

/**
 * 在 Worker 中应用序列化后的能力
 * 直接使用传递来的能力列表，无需重新加载
 */
export function applyCapabilitiesInWorker(capabilities: SerializableCapabilities): {
    agents: AgentTemplate[]
    skills: SerializableSkill[]
    mcps: SerializableMCPServer[]
} {
    return {
        agents: capabilities.agents,
        skills: capabilities.skills,
        mcps: capabilities.mcps,
    }
}
