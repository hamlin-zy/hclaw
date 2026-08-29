/**
 * MCP 错误诊断会话的消息构建工具
 *
 * 目标：发给诊断 Agent 的配置 JSON 使用标准 mcpServers 格式
 * （与 Claude Code / Cursor 等兼容），并要求 Agent 以相同格式返回修正配置，
 * 保证"输入格式 → 输出格式"一致。
 */
import type {MCPServer} from '@shared/types'

export type McpDiagAction = 'enable' | 'reconnect' | 'test'

export const MCP_ACTION_LABELS: Record<McpDiagAction, string> = {
    enable: '启用',
    reconnect: '重新连接',
    test: '测试连接',
}

/** 将 MCPServer 转为标准 mcpServers JSON 字符串（name 提出去做 key） */
export function buildMcpServersConfigJson(server: MCPServer): string {
    const configObj: Record<string, unknown> = {transport: server.transport}
    if (server.command) configObj.command = server.command
    if (server.args && server.args.length > 0) configObj.args = server.args
    if (server.env && Object.keys(server.env).length > 0) configObj.env = server.env
    if (server.url) configObj.url = server.url
    if (server.headers && Object.keys(server.headers).length > 0) configObj.headers = server.headers
    if (server.cwd) configObj.cwd = server.cwd
    if (server.timeout) configObj.timeout = server.timeout
    if (server.autoApprove && server.autoApprove.length > 0) configObj.autoApprove = server.autoApprove
    if (server.denyList && server.denyList.length > 0) configObj.denyList = server.denyList
    if (server.userDescription) configObj.userDescription = server.userDescription

    return JSON.stringify({mcpServers: {[server.name]: configObj}}, null, 2)
}

/** 构建发送给诊断 Agent 的首条用户消息 */
export function buildMcpDiagMessage(server: MCPServer, action: McpDiagAction, errorMessage: string): string {
    const actionLabel = MCP_ACTION_LABELS[action]
    const configJson = buildMcpServersConfigJson(server)
    return [
        'MCP连接失败了，帮我检查一下：',
        '',
        '```json',
        configJson,
        '```',
        '',
        `操作: ${actionLabel}`,
        `报错信息：${errorMessage}`,
        '',
        '注意：以上配置是标准 mcpServers 格式。你分析问题后，给出的修正配置也必须使用完全相同的 mcpServers JSON 格式返回（根节点为 mcpServers，服务器名为 key）。',
    ].join('\n')
}
