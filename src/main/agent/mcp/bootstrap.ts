/**
 * MCP 服务自举模块 — 启动时从文件加载配置，自动连接启用的 MCP 服务
 */

import path from 'path'
import fs from 'fs'
import {mcpService} from '../../services/mcpService'
import {mcpClient} from './client'
import {registerMCPTools} from './discovery'
import type {MCPServerConfig} from './types'
import {PluginRegistry} from '../../plugin/registry'
import {logger} from '../logger'

/** 单个服务启动超时（毫秒） */
const SERVER_START_TIMEOUT = 15_000
/** 每批并行启动的 MCP Server 数量 */
const BOOTSTRAP_BATCH_SIZE = 20
/** 批次之间的间隔（毫秒） */
const BOOTSTRAP_BATCH_DELAY = 50

// MCP 文件扫描：跳过隐藏目录和黑名单目录
const MCP_SKIP_DIRS = new Set(['docs', 'tests', 'node_modules', '.git', '.github', 'schemas', 'scripts', 'site'])

/**
 * 生成命令唯一标识
 * 用于检测多个插件或本地配置是否配置了相同的 MCP 服务
 */
function getCommandKey(config: MCPServerConfig): string {
    // 对于 stdio 传输，使用 command + args 作为唯一标识
    // 对于 http/sse 传输，使用 url 作为唯一标识
    if (config.transport === 'http' || config.transport === 'sse' || config.transport === 'websocket' || config.transport === 'streamable-http') {
        return `url:${config.url}`
    }
    const argsStr = config.args?.join(' ') || ''
    return `stdio:${config.command}:${argsStr}`
}

/**
 * 读取 MCP 服务器配置（从内存缓存）
 */
function loadMcpConfig(): Array<Record<string, unknown>> | null {
    try {
        const servers = mcpService.list()
        if (servers.length === 0) {
            return null
        }
        return servers.map(server => ({
            id: server.id,
            name: server.name,
            transport: server.transport,
            command: server.command,
            args: server.args,
            env: server.env,
            url: server.url,
            headers: server.headers,
            ...extractAdvancedFields(server),
            userDescription: server.userDescription,
            enabled: server.enabled,
        }))
    } catch (err: any) {
        return null
    }
}

/**
 * 提取 MCP 服务器的高级配置字段（cwd/timeout/autoApprove/denyList）
 * 消除多处重复的字段映射
 */
function extractAdvancedFields(server: any): {
    cwd?: string;
    timeout: number;
    autoApprove?: string[];
    denyList?: string[];
} {
    return {
        cwd: server.cwd as string | undefined,
        timeout: (server.timeout as number) ?? 60000,
        autoApprove: server.autoApprove as string[] | undefined,
        denyList: server.denyList as string[] | undefined,
    }
}

/**
 * 将共享 MCPServer 转换为 MCPServerConfig
 */
function toServerConfig(server: Record<string, unknown>): MCPServerConfig {
    // 插件 MCP 服务器的 enabled 状态由 mcps 表管理
    // bootstrapMcpServers() 中已经从 SQLite 读取了正确的 enabled 状态
    const enabled = (server.enabled as boolean) ?? true

    return {
        id: server.id as string,
        name: server.name as string,
        transport: (server.transport || server.type) as MCPServerConfig['transport'] || 'stdio',
        command: server.command as string | undefined,
        args: server.args as string[] | undefined,
        env: server.env as Record<string, string> | undefined,
        url: server.url as string | undefined,
        headers: server.headers as Record<string, string> | undefined,
        ...extractAdvancedFields(server),
        enabled,
        userDescription: server.userDescription as string | undefined,
        autoStart: true,
    }
}

/**
 * 解析 MCP 配置文件，提取服务器列表
 *
 * 内容校验规则（按优先级）：
 * 1. 根对象含 mcpServers key → { mcpServers: { name: { command, ... } } }
 * 2. 根对象是数组 → [{ command, args, transport, url, ... }]
 * 3. 根对象含 servers key 且是数组 → { servers: [{ command, ... }] }
 * 不满足以上条件返回空数组（非 MCP 配置文件）
 */
function parseMcpConfigFile(filePath: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(filePath)) return []

    try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(content)

        // 格式1: { mcpServers: { name: { command, ... } } }
        if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
            const mcpServers = parsed.mcpServers as Record<string, Record<string, unknown>>
            return Object.entries(mcpServers).map(([name, config]) => ({
                id: name,
                name,
                command: config.command,
                args: config.args,
                url: config.url,
                type: config.type,
                headers: config.headers,
                ...extractAdvancedFields(config),
                transport: config.transport || config.type || (config.url ? 'http' : 'stdio'),
            }))
        }

        // 格式2: 数组格式 [{ command, args, transport, url }]
        if (Array.isArray(parsed)) {
            // 内容校验：至少有一项包含 command/args/transport/url 之一
            const hasMcpFields = parsed.some((item: any) =>
                item.command || item.args || item.transport || item.url
            )
            if (hasMcpFields) return parsed
            return []
        }

        // 格式3: { servers: [...] }
        if (parsed?.servers && Array.isArray(parsed.servers)) {
            const hasMcpFields = parsed.servers.some((item: any) =>
                item.command || item.args || item.transport || item.url
            )
            if (hasMcpFields) return parsed.servers
            return []
        }

        return []
    } catch (_err: any) {
        return []
    }
}

/**
 * 为插件中的 MCP 服务器添加来源标记
 */
function tagPluginServer(server: Record<string, unknown>, pluginName: string, pluginPath: string): Record<string, unknown> {
    const originalId = server.id as string
    return {
        ...server,
        id: `plugin:${pluginName}:${originalId}`,
        _pluginName: pluginName,
        _pluginPath: pluginPath,
    }
}

/**
 * 从插件根目录查找所有含 "mcp" 的 .json 文件
 *
 * 规则：
 * - 文件名（不区分大小写）包含 "mcp" 且后缀为 .json
 * - 递归查找，跳过 . 开头的隐藏目录和黑名单目录
 * - 文件内容校验由 parseMcpConfigFile 负责
 */
function getPluginMcpConfigPaths(pluginPath: string): string[] {
    const mcpFiles: string[] = []

    function walk(dir: string): void {
        try {
            const entries = fs.readdirSync(dir, {withFileTypes: true})
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name)

                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.')) continue    // 跳过隐藏目录
                    if (MCP_SKIP_DIRS.has(entry.name)) continue // 跳过黑名单
                    if (entry.name === 'node_modules') continue
                    walk(fullPath)
                } else if (entry.isFile()) {
                    // 文件名含 mcp 且后缀为 .json
                    if (/mcp/i.test(entry.name) && entry.name.endsWith('.json')) {
                        mcpFiles.push(fullPath)
                    }
                }
            }
        } catch {
            // 无权限等静默跳过
        }
    }

    walk(pluginPath)
    return mcpFiles
}

/**
 * 从单个插件加载 MCP 服务器配置
 */
function loadMcpServersFromSinglePlugin(plugin: { name: string; path: string }): Array<Record<string, unknown>> {
    const servers: Array<Record<string, unknown>> = []
    const seen = new Set<string>()

    for (const configPath of getPluginMcpConfigPaths(plugin.path)) {
        const parsed = parseMcpConfigFile(configPath)
        if (parsed.length === 0) continue

        let added = 0
        for (const s of parsed.map(s => tagPluginServer(s, plugin.name, plugin.path))) {
            if (seen.has(s.id as string)) continue
            seen.add(s.id as string)
            servers.push(s)
            added++
        }

    }
    return servers
}

/**
 * 从所有已启用插件加载 MCP 服务器配置
 */
export function loadMcpServersFromPlugins(): Array<Record<string, unknown>> {
    const pluginRegistry = PluginRegistry.getInstance()
    return pluginRegistry.getEnabled().flatMap(plugin => loadMcpServersFromSinglePlugin(plugin))
}

/**
 * 从指定插件加载 MCP 服务器配置
 * 支持两种格式：
 * 1. mcp/servers.json - 标准格式
 * 2. .mcp.json - Claude Code 插件格式
 *
 * @param pluginName 插件名称
 * @returns MCP 服务器配置数组
 */
export function loadMcpServersFromPlugin(pluginName: string): Array<Record<string, unknown>> {
    const pluginRegistry = PluginRegistry.getInstance()
    const plugin = pluginRegistry.get(pluginName)
    if (!plugin) return []

    const servers = loadMcpServersFromSinglePlugin(plugin)
    // loaded from plugin
    return servers
}

/**
 * 启动单个 MCP 服务（带超时兜底）
 */
async function tryStartServer(config: MCPServerConfig): Promise<boolean> {
    try {
        await Promise.race([
            mcpClient.startServer(config),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('启动超时')), SERVER_START_TIMEOUT)
            ),
        ])

        // 注册工具
        const _registered = registerMCPTools(config.id)
        return true
    } catch (err: any) {
        return false
    }
}

/**
 * MCP 服务自举入口
 *
 * 在应用启动时异步调用，不阻塞主流程。
 * 自动启动所有 enabled 的 MCP 服务并建立连接。
 */
export async function bootstrapMcpServers(): Promise<void> {
    // 确保 Service 初始化完成（幂等调用，等待即可）
    await mcpService.initialize()

    // 只加载用户服务器（插件服务器由 powerManager 管理）
    const allServers = loadMcpConfig() || []

    if (allServers.length === 0) {
        return
    }

    // 过滤启用的服务（包括插件服务器）
    const enabledServers = allServers.filter(s => {
        return s.enabled !== false
    })

    if (enabledServers.length === 0) {
        return
    }

    // 命令去重映射: commandKey -> serverId
    // 用于检测多个插件或本地配置是否配置了相同的 MCP 服务
    const commandToServerId: Map<string, string> = new Map()

    // 分批启动，每批 BOOTSTRAP_BATCH_SIZE 个，避免瞬间拉起大量子进程
    const results: PromiseSettledResult<{
        id: string; name: string; success: boolean; skipped: boolean
    }>[] = []

    for (let batchStart = 0; batchStart < enabledServers.length; batchStart += BOOTSTRAP_BATCH_SIZE) {
        const batch = enabledServers.slice(batchStart, batchStart + BOOTSTRAP_BATCH_SIZE)
        const batchResults = await Promise.allSettled(
            batch.map(async (server) => {
                const config = toServerConfig(server)

                // 生成命令唯一标识（用于去重）
                const commandKey = getCommandKey(config)

                // 检查是否有相同命令已经在运行或已成功启动
                const existingServerId = commandToServerId.get(commandKey)
                if (existingServerId) {
                    return {id: config.id, name: config.name, success: true, skipped: true}
                }

                // 检查是否已连接（幂等性）
                if (mcpClient.isConnected(config.id)) {
                    commandToServerId.set(commandKey, config.id)
                    return {id: config.id, name: config.name, success: true, skipped: true}
                }

                // 检查连接状态，避免在连接中或冷却期内重复触发
                const serverState = mcpClient.getServer(config.id)
                const currentStatus = serverState?.status
                const lastErrorTime = (serverState as any)?.lastErrorTime || 0

                // 如果正在连接中，跳过本次尝试
                if (currentStatus === 'connecting' || currentStatus === 'reconnecting') {
                    return {id: config.id, name: config.name, success: false, skipped: true}
                }

                // 本次应用启动期间已失败 → 不再重试（除非用户手动禁用再启用）
                if (lastErrorTime > 0) {
                    return {id: config.id, name: config.name, success: false, skipped: true}
                }

                const success = await tryStartServer(config)
                // 如果启动成功，记录命令到 serverId 的映射，用于后续去重
                if (success) {
                    commandToServerId.set(commandKey, config.id)
                }
                return {id: config.id, name: config.name, success, skipped: false}
            })
        )
        results.push(...batchResults)

        // 批次间插入延迟，避免 CPU/IO 洪峰
        if (batchStart + BOOTSTRAP_BATCH_SIZE < enabledServers.length) {
            await new Promise(r => setTimeout(r, BOOTSTRAP_BATCH_DELAY))
        }
    }

    // 统计结果
    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.success).length
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length

    // MCP connection results are logged individually by client.ts
}
