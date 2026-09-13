/**
 * MCP 插件服务器加载 — 从已启用插件的目录扫描并解析 MCP 配置
 */

import path from 'path'
import fs from 'fs'
import {PluginRegistry} from '../../plugin/registry'

// MCP 文件扫描：跳过隐藏目录和黑名单目录
const MCP_SKIP_DIRS = new Set(['docs', 'tests', 'node_modules', '.git', '.github', 'schemas', 'scripts', 'site'])

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

        for (const s of parsed.map(s => tagPluginServer(s, plugin.name, plugin.path))) {
            if (seen.has(s.id as string)) continue
            seen.add(s.id as string)
            servers.push(s)
        }
    }
    return servers
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

    return loadMcpServersFromSinglePlugin(plugin)
}
