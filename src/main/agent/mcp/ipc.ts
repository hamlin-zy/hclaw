import type {BrowserWindow} from 'electron'
import {ipcMain} from 'electron'
import {logger} from '../logger'
import {mcpClient} from './client'
import type {MCPServerConfig} from './types'
import {mcpService} from '../../services/mcpService'
import type {McpServer} from '../../../shared/types/mcp'
import {setMcpPluginOverride} from '../../config/mcpConfig'
import {PluginRegistry} from '../../plugin/registry'
import {mcpWorkerManager} from './mcpWorkerManager'
import path from 'path'
import fs from 'fs'

/** IPC 响应辅助：成功 */
const ok = () => ({success: true})
/** IPC 响应辅助：失败 */
const fail = (err: unknown) => ({success: false, error: String(err)})

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function registerMCPIPC(): void {
    // 列出所有 MCP 服务器配置（不含运行时状态）
    ipcMain.handle('mcp:list', async () => {
        try {
            const servers = mcpService.list()
            // 对于插件 MCP，添加插件启用状态
            const pluginRegistry = PluginRegistry.getInstance()
            const serversWithPluginStatus = servers.map(server => {
                if (server.id.startsWith('plugin:')) {
                    const pluginName = server.id.split(':')[1]
                    const plugin = pluginRegistry.get(pluginName)
                    return {
                        ...server,
                        pluginEnabled: plugin?.enabled ?? false,
                    }
                }
                return server
            })
            logger.debug('[MCP IPC] mcp:list returning', {count: serversWithPluginStatus.length})
            return {success: true, data: serversWithPluginStatus}
        } catch (err) {
            logger.error('[MCP IPC] list failed', {error: err})
            return {success: false, error: String(err)}
        }
    })

    // 保存单个 MCP 服务器配置（增量）
    ipcMain.handle('mcp:save-server', async (_, server: any) => {
        try {
            logger.debug('[MCP IPC] mcp:save-server called', {id: server?.id})
            if (server?.id?.startsWith('plugin:')) {
                // 插件服务器：写入 pluginMcpServers 覆盖节，不修改插件目录配置
                setMcpPluginOverride(server.id, {
                    enabled: server.enabled,
                    name: server.name,
                    transport: server.transport,
                    command: server.command,
                    args: server.args,
                    env: server.env,
                    url: server.url,
                    headers: server.headers,
                    cwd: server.cwd,
                    timeout: server.timeout,
                    autoApprove: server.autoApprove,
                    denyList: server.denyList,
                    userDescription: server.userDescription,
                })
                // 同步 mcpService 缓存
                const s = mcpService.get(server.id)
                if (s) {
                    Object.assign(s, server)
                }
                logger.debug('[MCP IPC] mcp:save-server plugin override', {id: server.id})
            } else {
                mcpService.add(server)
            }
            // 通知 Worker 更新配置（启动/停止对应的服务器）
            mcpWorkerManager.syncConfigs()
            return ok()
        } catch (err) {
            logger.error('[MCP IPC] mcp:save-server failed', {error: err})
            return fail(err)
        }
    })

    // 删除单个 MCP 服务器
    ipcMain.handle('mcp:delete', async (_, id: string) => {
        try {
            logger.debug('[MCP IPC] mcp:delete called', {id})
            mcpService.delete(id)
            mcpWorkerManager.syncConfigs()
            return ok()
        } catch (err) {
            logger.error('[MCP IPC] delete failed', {error: err})
            return fail(err)
        }
    })

    // 删除单个 MCP 服务器 (removeServer alias)
    ipcMain.handle('mcp:remove-server', async (_, id: string) => {
        try {
            logger.debug('[MCP IPC] mcp:remove-server called', {id})
            mcpService.delete(id)
            mcpWorkerManager.syncConfigs()
            return ok()
        } catch (err) {
            logger.error('[MCP IPC] removeServer failed', {error: err})
            return fail(err)
        }
    })

    // 导入 MCP 配置（从用户选择的 JSON 文件）
    ipcMain.handle('mcp:import-config', async (_, filePath: string) => {
        try {
            // 读取并解析 JSON 文件
            let content: string
            try {
                content = fs.readFileSync(filePath, 'utf-8')
            } catch {
                return {success: false, error: `文件不存在或无法读取: ${filePath}`}
            }

            let parsed: any
            try {
                parsed = JSON.parse(content)
            } catch {
                return {success: false, error: `文件格式无效（非 JSON）: ${filePath}`}
            }

            // 解析 mcpServers 对象（Claude Code / Cursor 等格式兼容）
            const mcpServers = parsed?.mcpServers || parsed?.servers || {}
            if (typeof mcpServers !== 'object' || Object.keys(mcpServers).length === 0) {
                return {success: false, error: `文件中未找到 mcpServers 字段`}
            }

            const imported: Array<{ id: string; name: string; transport: string }> = []
            const skipped: Array<{ name: string; reason: string }> = []
            const source = path.basename(filePath, '.json')

            for (const [name, cfg] of Object.entries(mcpServers)) {
                const config = cfg as Record<string, unknown>
                const command = config.command as string | undefined
                const args = config.args as string[] | undefined
                const url = config.url as string | undefined
                const transport = (config.transport as string) || (config.type as string) || (url ? 'sse' : 'stdio')
                const env = config.env as Record<string, string> | undefined
                const headers = config.headers as Record<string, string> | undefined

                // 检查是否已存在（基于命令/URL 去重）
                const existingServers = mcpService.list()
                const isDuplicate = existingServers.some(s => {
                    if (command && s.command === command) return true
                    if (url && s.url === url) return true
                    return false
                })

                if (isDuplicate) {
                    skipped.push({name, reason: '已存在相同命令或 URL 的服务器'})
                    continue
                }

                const serverId = `imported:${source}:${name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()}`
                const server: McpServer = {
                    id: serverId,
                    name: `${name} (${source})`,
                    transport: transport as any,
                    command: command || '',
                    args: args || [],
                    env: env || {},
                    url: url || '',
                    headers: headers || {},
                    cwd: config.cwd as string | undefined,
                    timeout: config.timeout as number | undefined,
                    autoApprove: config.autoApprove as string[] | undefined,
                    denyList: config.denyList as string[] | undefined,
                    userDescription: '',
                    enabled: true,
                }

                mcpService.add(server)
                imported.push({id: serverId, name: server.name, transport: server.transport})
            }

            // 同步到 Worker（启动新导入的服务器）
            if (imported.length > 0) {
                mcpWorkerManager.syncConfigs()
            }

            return {success: true, imported, skipped}
        } catch (err: any) {
            logger.error('[MCP IPC] import-config failed', {error: err})
            return {success: false, error: String(err)}
        }
    })

    // 更新单个 MCP 服务器的 enabled 状态
    ipcMain.handle('mcp:set-enabled', async (_, id: string, enabled: boolean) => {
        try {
            logger.debug('[MCP IPC] mcp:set-enabled called', {id, enabled, isPlugin: id.startsWith('plugin:')})
            if (id.startsWith('plugin:')) {
                // 插件服务器：写入 pluginMcpServers 覆盖节，保留其他已有覆盖字段
                setMcpPluginOverride(id, {enabled})
                // 同步 mcpService 缓存
                const s = mcpService.get(id)
                if (s) {
                    s.enabled = enabled
                }
                logger.debug('[MCP IPC] setEnabled: plugin server override updated', {id, enabled})
            } else {
                mcpService.setEnabled(id, enabled)
            }
            // 通知 Worker 更新配置（根据 enabled 决定启动/停止）
            mcpWorkerManager.syncConfigs()
            return ok()
        } catch (err) {
            logger.error('[MCP IPC] setEnabled failed', {error: err})
            return fail(err)
        }
    })

    // 测试连接
    ipcMain.handle('mcp:test-connection', async (_event, config: MCPServerConfig) => {
                try {
            const result = await mcpClient.testConnection(config)
            return result
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 启动服务器 — 路由到 Worker 统一管理
    // Phase 2: 主进程不再直接启动进程，避免双份子进程
    ipcMain.handle('mcp:start-server', async (_event, config: MCPServerConfig) => {
        logger.debug(`[MCP IPC] mcp:start-server: id=${config.id} name=${config.name}`)
        mcpService.updateStatus(config.id, 'connecting')
        try {
            // 标记为启用 → sync 到 Worker → Worker 启动进程 → 状态通过 status_batch 回传
            mcpService.setEnabled(config.id, true)
            mcpWorkerManager.syncConfigs()
            return ok()
        } catch (err: any) {
            logger.debug(`[MCP IPC] ${config.name} error: ${err.message}`)
            mcpService.updateStatus(config.id, 'error', err.message)
            return fail(err)
        }
    })

    // 停止服务器 — 路由到 Worker 统一管理
    // Phase 2: 主进程不再直接停止进程，避免只停一半
    ipcMain.handle('mcp:stop-server', async (_event, serverId: string) => {
        mcpService.updateStatus(serverId, 'stopping')
        try {
            // 标记为禁用 → sync 到 Worker → Worker 停止进程 → 状态通过 status_batch 回传
            mcpService.setEnabled(serverId, false)
            mcpWorkerManager.syncConfigs()
            return ok()
        } catch (err: any) {
            return fail(err)
        }
    })

    // 重启单个 MCP Server（不触发全量 diff，只操作指定服务）
    // 用于刷新按钮，避免 syncConfigs 误重试所有已断开的服务
    ipcMain.handle('mcp:restart-server', async (_event, serverId: string) => {
        const server = mcpService.get(serverId)
        if (!server) return fail(new Error(`服务器 ${serverId} 不存在`))
        logger.debug(`[MCP IPC] mcp:restart-server: id=${serverId} name=${server.name}`)
        try {
            mcpService.updateStatus(serverId, 'connecting')
            const result = await mcpWorkerManager.restartServer(serverId)
            if (!result.success) {
                mcpService.updateStatus(serverId, 'error', '重启失败')
                return fail(new Error('重启失败'))
            }
            return ok()
        } catch (err: any) {
            logger.debug(`[MCP IPC] restart-server ${serverId} error: ${err.message}`)
            mcpService.updateStatus(serverId, 'error', err.message)
            return fail(err)
        }
    })

    // 获取所有服务器状态 — 从权威缓存读取（Worker 的状态变化会实时同步到这里）
    ipcMain.handle('mcp:get-all-status', async () => {
        return mcpService.list().map(s => ({
            config: {
                id: s.id,
                name: s.name,
                transport: s.transport,
                command: s.command,
                args: s.args,
                env: s.env,
                url: s.url,
                headers: s.headers,
                cwd: s.cwd,
                timeout: s.timeout,
                autoApprove: s.autoApprove,
                denyList: s.denyList,
                userDescription: s.userDescription,
                enabled: s.enabled,
            },
            status: s.status,
            error: s.errorDetail,
            tools: s.tools,
        }))
    })
}

export function registerMCPEventForwarding(): () => void {
    // Phase 2: 所有 MCP 服务器状态由 Worker 管理
    // Worker 通过 status_batch → mcpWorkerManager.handleStatusBatch() → mcpService.updateStatus() 更新状态
    // mcpService.onEvent 监听这些变化并转发到渲染进程
    const unsubscribeService = mcpService.onEvent((event) => {
        if (event.type === 'status-changed') {
            const data = event.data as { serverId: string; status: string; error?: string; tools?: unknown[] }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('mcp:status-changed', data)
            }
        } else if (event.type === 'list-changed') {
            // 列表变更（新增/删除/外部修改 mcp.json）→ 通知渲染进程刷新
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('mcp:list-changed')
            }
        }
    })

    return () => {
        unsubscribeService()
    }
}
