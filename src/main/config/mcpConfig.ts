import path from 'path'
import fs from 'fs'
import {getHclawDir} from '../config'
import type {McpServer} from '../../shared/types/mcp'

/** 获取 mcp.json 文件路径 */
export function getMcpConfigPath(): string {
    return path.join(getHclawDir(), 'mcp.json')
}

/** mcp.json 中每条记录的输入格式 */
interface McpServerInput {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    transport?: string
    enabled?: boolean
    cwd?: string
    timeout?: number
    autoApprove?: string[]
    denyList?: string[]
    userDescription?: string
}

/**
 * 从 name 哈希派生稳定的 id
 */
function hashName(name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        const char = name.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
    }
    return `mcp-${Math.abs(hash).toString(36)}`
}

/** 从 JSON map 解析为 McpServer[]（补全默认值） */
function parseMcpServers(raw: Record<string, McpServerInput>): McpServer[] {
    return Object.entries(raw).map(([name, entry]) => ({
        id: hashName(name),
        name,
        transport: entry.transport || (entry.url ? 'streamable-http' : 'stdio'),
        command: entry.command || '',
        args: entry.args || [],
        env: entry.env || {},
        url: entry.url || '',
        headers: entry.headers || {},
        cwd: entry.cwd || '',
        timeout: entry.timeout ?? 60000,
        autoApprove: entry.autoApprove || [],
        denyList: entry.denyList || [],
        userDescription: entry.userDescription || '',
        enabled: entry.enabled ?? true,
    }))
}

/** 将 McpServer[] 序列化为 JSON map（只写用户服务器，不写插件服务器） */
function serializeMcpServers(servers: McpServer[]): Record<string, unknown> {
    const map: Record<string, unknown> = {}
    for (const s of servers) {
        if (s.id.startsWith('plugin:')) continue // 插件服务器留在插件目录
        map[s.name] = {
            command: s.command,
            args: s.args,
            env: s.env,
            url: s.url,
            headers: s.headers || {},
            enabled: s.enabled,
            cwd: s.cwd || '',
            timeout: s.timeout ?? 60000,
            autoApprove: s.autoApprove || [],
            denyList: s.denyList || [],
            userDescription: s.userDescription || '',
        }
    }
    return {mcpServers: map}
}

// ─── 插件 MCP 覆盖配置管理 ───────────────────────────────

/** 插件 MCP 的用户覆盖字段（叠加在插件目录配置之上） */
export interface PluginMcpOverride {
    enabled?: boolean
    name?: string
    transport?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    cwd?: string
    timeout?: number
    autoApprove?: string[]
    denyList?: string[]
    userDescription?: string
}

/** 读取插件 MCP 覆盖配置 */
function readMcpPluginOverrides(): Record<string, PluginMcpOverride> {
    const jsonPath = getMcpConfigPath()
    if (!fs.existsSync(jsonPath)) return {}
    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
        return raw.pluginMcpServers || {}
    } catch {
        return {}
    }
}

/** 获取插件 MCP 服务器的覆盖配置 */
export function getMcpPluginOverride(serverId: string): PluginMcpOverride | null {
    const overrides = readMcpPluginOverrides()
    return overrides[serverId] || null
}

/** 获取插件 MCP 服务器的启用状态（默认 true） */
export function getMcpPluginEnabled(serverId: string): boolean {
    const overrides = readMcpPluginOverrides()
    return overrides[serverId]?.enabled ?? true
}

/** 设置插件 MCP 服务器的覆盖配置（合并写入，不会删除未提供的字段） */
export function setMcpPluginOverride(serverId: string, override: Partial<PluginMcpOverride>): boolean {
    try {
        const jsonPath = getMcpConfigPath()
        let raw: any = {}
        if (fs.existsSync(jsonPath)) {
            try {
                raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
            } catch {
            }
        }
        if (!raw.pluginMcpServers) raw.pluginMcpServers = {}
        // 合并现有覆盖和新的覆盖
        raw.pluginMcpServers[serverId] = {...raw.pluginMcpServers[serverId], ...override}
        // 清理空值字段
        const cleaned: Record<string, any> = {}
        for (const [k, v] of Object.entries(raw.pluginMcpServers[serverId])) {
            if (v !== undefined && v !== null) cleaned[k] = v
        }
        raw.pluginMcpServers[serverId] = cleaned
        fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf-8')
        return true
    } catch (err) {
        console.error('[mcpConfig] setMcpPluginOverride failed:', err)
        return false
    }
}

/** 获取插件 MCP 服务器的完整 McpServer 对象（插件目录配置 + 用户覆盖合并） */
export function mergePluginOverride(
    pluginServer: Record<string, unknown>,
    override: PluginMcpOverride | null
): McpServer {
    const id = pluginServer.id as string
    const name = override?.name || (pluginServer.name as string) || id
    return {
        id,
        name,
        transport: (override as any)?.transport || (pluginServer.transport as string) || (pluginServer.type as string) || 'stdio',
        command: override?.command || (pluginServer.command as string) || '',
        args: override?.args || (pluginServer.args as string[]) || [],
        env: override?.env || (pluginServer.env as Record<string, string>) || {},
        url: override?.url || (pluginServer.url as string) || '',
        headers: override?.headers || (pluginServer.headers as Record<string, string>) || {},
        cwd: override?.cwd || (pluginServer.cwd as string) || '',
        timeout: override?.timeout ?? (pluginServer.timeout as number) ?? 60000,
        autoApprove: override?.autoApprove || (pluginServer.autoApprove as string[]) || [],
        denyList: override?.denyList || (pluginServer.denyList as string[]) || [],
        userDescription: override?.userDescription || (pluginServer.userDescription as string) || '',
        enabled: override?.enabled ?? true,
    }
}

/**
 * 读取 MCP 配置（仅从 JSON 文件）
 */
export function readMcpConfig(): McpServer[] {
    const jsonPath = getMcpConfigPath()

    if (!fs.existsSync(jsonPath)) return []

    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
        const servers = raw.mcpServers || {}
        return parseMcpServers(servers)
    } catch (err) {
        console.error('[mcpConfig] parse failed:', err)
        return []
    }
}

/**
 * 写入 MCP 配置（只写用户服务器，保留插件覆盖配置）
 */
export function writeMcpConfig(servers: McpServer[]): boolean {
    try {
        const jsonPath = getMcpConfigPath()
        // 读取现有 pluginMcpServers 覆盖配置（保留插件启用状态）
        let pluginMcp = {}
        if (fs.existsSync(jsonPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
                pluginMcp = existing.pluginMcpServers || {}
            } catch {
            }
        }
        const data = serializeMcpServers(servers) as Record<string, unknown>
        data.pluginMcpServers = pluginMcp
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8')
        return true
    } catch (err) {
        console.error('[mcpConfig] write failed:', err)
        return false
    }
}
