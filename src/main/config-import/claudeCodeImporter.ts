import fs from 'fs'
import path from 'path'
import {readMcpConfig, writeMcpConfig} from '../config/mcpConfig'
import type {HookDefinition} from '../config/hookConfig'
import {readHookConfig, writeHookConfig} from '../config/hookConfig'
import type {McpServer} from '../../shared/types/mcp'
import {logger} from '../agent/logger'
import {app} from 'electron'

/** 从外部路径导入 MCP 配置 */
export function importMcpFromFile(sourcePath: string): {
    imported: McpServer[]
    skipped: string[]
} {
    try {
        const raw = fs.readFileSync(sourcePath, 'utf-8')
        const parsed = JSON.parse(raw)
        const mcpServers = parsed.mcpServers || parsed.servers || {}
        if (typeof mcpServers !== 'object' || Object.keys(mcpServers).length === 0) {
            return {imported: [], skipped: []}
        }

        const existing = readMcpConfig()
        const existingNames = new Set(existing.map(s => s.name))
        const imported: McpServer[] = []
        const skipped: string[] = []

        for (const [name, cfg] of Object.entries(mcpServers)) {
            if (existingNames.has(name)) {
                skipped.push(name);
                continue
            }
            const config = cfg as Record<string, unknown>
            imported.push({
                name,
                command: (config.command as string) || '',
                args: (config.args as string[]) || [],
                env: (config.env as Record<string, string>) || {},
                url: (config.url as string) || '',
                headers: (config.headers as Record<string, string>) || {},
                transport: (config.url as string) ? 'sse' : 'stdio',
                enabled: true,
            } as McpServer)
        }

        if (imported.length > 0) writeMcpConfig([...existing, ...imported])
        return {imported, skipped}
    } catch (err: any) {
        logger.error('importMcpFromFile', {error: err.message})
        return {imported: [], skipped: []}
    }
}

/** 从 Claude Code settings.json 导入 Hook 配置 */
export function importHooksFromClaude(sourcePath: string): {
    imported: HookDefinition[]
    skipped: string[]
} {
    try {
        const raw = fs.readFileSync(sourcePath, 'utf-8')
        const parsed = JSON.parse(raw)
        const claudeHooks = parsed.hooks || {}
        if (typeof claudeHooks !== 'object' || Object.keys(claudeHooks).length === 0) {
            return {imported: [], skipped: []}
        }

        const existing = readHookConfig()
        const existingNames = new Set(existing.map(h => h.name))
        const imported: HookDefinition[] = []
        const skipped: string[] = []
        const now = Date.now()
        let counter = 0

        for (const [name, cfg] of Object.entries(claudeHooks)) {
            if (existingNames.has(name)) {
                skipped.push(name);
                continue
            }
            const config = cfg as Record<string, unknown>
            counter++
            imported.push({
                id: `imported-hook-${counter}`,
                name,
                description: `Imported: ${name}`,
                events: (config.events as string[]) || [],
                config: {
                    type: config.type || 'command',
                    command: (config.command as string) || '',
                    timeout: (config.timeout as number) ?? 5000
                },
                enabled: true,
                source: 'user',
                createdAt: now,
                updatedAt: now,
            })
        }

        if (imported.length > 0) writeHookConfig([...existing, ...imported])
        return {imported, skipped}
    } catch (err: any) {
        logger.error('importHooksFromClaude', {error: err.message})
        return {imported: [], skipped: []}
    }
}

export function getToolConfigPaths(tool: string): string[] {
    const home = app.getPath('home')
    const mapping: Record<string, string[]> = {
        'claude-code': [path.join(home, '.claude', 'mcp.json'), path.join(home, '.claude', 'settings.json')],
        'cursor': [path.join(home, '.cursor', 'mcp.json')],
        'windsurf': [path.join(home, '.windsurf', 'mcp.json')],
        'vscode': [path.join(process.cwd(), '.vscode', 'mcp.json')],
    }
    return mapping[tool] || []
}
