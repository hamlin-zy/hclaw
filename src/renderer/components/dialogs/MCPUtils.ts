export const TRANSPORT_COLORS: Record<string, string> = {
    stdio: 'bg-blue-50 text-blue-400 border-blue-100',
    sse: 'bg-green-50 text-green-500 border-green-100',
    http: 'bg-yellow-50 text-yellow-500 border-yellow-100',
    websocket: 'bg-purple-50 text-purple-500 border-purple-100',
    'streamable-http': 'bg-indigo-50 text-indigo-500 border-indigo-100',
}

export function transportColorClasses(transport: string): string {
    return TRANSPORT_COLORS[transport] || 'bg-gray-50 text-gray-400 border-gray-100'
}

/**
 * 生成 MCP 配置 JSON（两种格式，用 --- 分隔）
 *
 * 上半部分：标准 mcpServers 格式（可直接用于 claude_desktop_config.json / mcp.json）
 * 下半部分：轻量配置对象（仅当前服务的核心配置字段）
 */
export function buildMcpConfigJson(server: { name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; cwd?: string; timeout?: number; autoApprove?: string[]; denyList?: string[] }): string {
    const config: Record<string, unknown> = {}

    if (server.transport === 'stdio' || server.transport === 'websocket') {
        if (server.command) config.command = server.command
        if (server.args && server.args.length > 0) config.args = server.args
        if (server.env && Object.keys(server.env).length > 0) config.env = server.env
    } else {
        // sse / http / streamable-http
        if (server.url) config.url = server.url
        if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers
    }

    if (server.transport !== 'stdio' && server.transport !== 'websocket') {
        config.transport = server.transport
    }
    if (server.cwd) config.cwd = server.cwd
    if (server.timeout !== undefined && server.timeout > 0) config.timeout = server.timeout
    if (server.autoApprove && server.autoApprove.length > 0) config.autoApprove = server.autoApprove
    if (server.denyList && server.denyList.length > 0) config.denyList = server.denyList

    // 格式 A：标准 mcpServers 格式
    const standardFormat: Record<string, unknown> = {
        mcpServers: {
            [server.name]: config,
        },
    }

    // 格式 B：轻量配置对象（含名称和传输方式）
    const lightFormat: Record<string, unknown> = {
        name: server.name,
        transport: server.transport,
        ...config,
    }

    return JSON.stringify(standardFormat, null, 2) + '\n---\n' + JSON.stringify(lightFormat, null, 2)
}

export function statusDotClasses(status: string, enabled?: boolean): string {
    if (enabled === false) return 'bg-gray-300'
    switch (status) {
        case 'connected':
            return 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.3)]'
        case 'error':
            return 'bg-red-500'
        case 'connecting':
        case 'reconnecting':
            return 'bg-yellow-300 animate-pulse'
        default:
            return 'bg-gray-300'
    }
}
