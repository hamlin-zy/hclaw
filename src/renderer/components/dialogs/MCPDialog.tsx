import {useCallback, useEffect, useState} from 'react'
import {Switch} from '../common/Switch'
import {useMcpStore} from '../../stores/mcpStore'
import type {MCPServer} from '@shared/types'
import MCPToolsOverlay from './MCPToolsOverlay'
import MCPUserServerCard from './MCPUserServerCard'
import MCPPluginServerCard from './MCPPluginServerCard'
import MCPEditCard from './MCPEditCard'
import MCPEditModal from './MCPEditModal'
import {useMcpErrorDialog} from './MCPErrorHelper'
import {useMenuBarStore} from '../../stores/menuBarStore'

type TabType = 'user' | 'plugin'

export default function MCPDialog() {
    const {
        mcpServers,
        addMCPServer,
        removeMCPServer,
        updateMCPServer,
        toggleMCPServer,
        setServerStatusesBatch,
    } = useMcpStore()
    const {McpErrorOverlay, showError} = useMcpErrorDialog({
        onNavigateHome: () => useMenuBarStore.getState().closeDialog(),
    })
    const [activeTab, setActiveTab] = useState<TabType>('user')
    const [editTarget, setEditTarget] = useState<MCPServer | 'add' | null>(null)
    const [toolsModalServer, setToolsModalServer] = useState<MCPServer | null>(null)
    const [pluginMcpServers, setPluginMcpServers] = useState<MCPServer[]>([])
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{
        imported: number
        skipped: number
        error?: string
    } | null>(null)

    // ─── 同步服务器状态 ─────────────────────

    const syncMcpStatus = useCallback(async () => {
        if (!window.electronAPI?.mcp?.getAllStatus) return
        const statuses = await window.electronAPI.mcp.getAllStatus()
        const result = await window.electronAPI?.mcp?.list?.()
        const mcpServiceList = result?.success ? result.data || [] : []

        const pluginServerConfigMap = new Map<string, any>()
        mcpServiceList.forEach((s: any) => {
            if (s.id.startsWith('plugin:')) pluginServerConfigMap.set(s.id, s)
        })

        const userUpdates: Array<{ id: string; status: any; tools: any; error: string; config: any }> = []
        const pluginList: MCPServer[] = []
        const statusMap = new Map(statuses.map((s: any) => [s.config.id, s]))

        pluginServerConfigMap.forEach((config: any, id: string) => {
            const runtimeStatus = statusMap.get(id)
            pluginList.push({
                id: config.id,
                name: config.name || config.id,
                transport: config.transport,
                status: runtimeStatus?.status || (config.enabled ? 'stopped' : 'disabled'),
                tools: runtimeStatus?.tools || [],
                errorDetail: runtimeStatus?.error || '',
                enabled: config.enabled,
                command: config.command,
                args: config.args,
                env: config.env,
                url: config.url,
                headers: config.headers,
                cwd: config.cwd,
                timeout: config.timeout,
                autoApprove: config.autoApprove,
                denyList: config.denyList,
                pluginEnabled: config.pluginEnabled,
            } as MCPServer & { pluginEnabled?: boolean })
        })
        pluginList.sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
            return a.name.localeCompare(b.name)
        })

        statuses.forEach((s: any) => {
            const config = s.config
            if (!config.id.startsWith('plugin:')) {
                userUpdates.push({id: config.id, status: s.status, tools: s.tools, error: s.error || '', config})
            }
        })

        setPluginMcpServers(pluginList)

        // ★ 用户 MCP 状态同步：只同步 store 中不存在的服务器，或 store 中仍为 'stopped' 的服务器
        // 避免用主进程的旧数据（可能仍未收到 Worker 的 status_batch）覆盖 store 中已由
        // 模块级 onStatusChanged 监听器更新的实时状态（如 'connecting'、'connected'）
        if (userUpdates.length > 0) {
            // 获取当前 store 状态，过滤掉已有非 stopped 状态的服务器
            const storeState = useMcpStore.getState()
            const filtered = userUpdates.filter(u => {
                const storeServer = storeState.mcpServers.find(s => s.id === u.id)
                // 新服务器（store 中不存在）→ 同步
                if (!storeServer) return true
                // store 中已经是 stopped → 用主进程数据（可能有更新）
                if (storeServer.status === 'stopped') return true
                // store 中已有活跃状态（connecting/connected/error/reconnecting）→ 不覆盖
                console.log(`[MCPDialog] syncMcpStatus: SKIP user server ${u.id} (store already has ${storeServer.status}, main says ${u.status})`)
                return false
            })
            if (filtered.length > 0) {
                setServerStatusesBatch(filtered.map(({id, status, tools, error, config}) => ({
                    id, status, tools,
                    errorDetail: error,
                    extra: {
                        name: config.name, transport: config.transport,
                        command: config.command, args: config.args, env: config.env,
                        url: config.url, headers: config.headers, cwd: config.cwd,
                        timeout: config.timeout, autoApprove: config.autoApprove,
                        denyList: config.denyList, userDescription: config.userDescription,
                    },
                })))
            }
        }
    }, [setServerStatusesBatch])

    useEffect(() => { syncMcpStatus() }, [syncMcpStatus])

    // 监听插件 MCP 状态变化
    useEffect(() => {
        const unsubscribe = window.electronAPI?.mcp?.onStatusChanged?.((payload: any) => {
            if (!payload.serverId?.startsWith('plugin:')) return
            setPluginMcpServers(prev => prev.map(srv =>
                srv.id !== payload.serverId ? srv : {
                    ...srv,
                    status: payload.status,
                    errorDetail: payload.error || '',
                    tools: payload.tools || [],
                }
            ))
        })
        return () => unsubscribe?.()
    }, [])

    // ─── 导入 MCP 配置 ─────────────────────

    const handleImportFile = useCallback(async () => {
        const filePath = await window.electronAPI?.selectFilePath?.()
        if (!filePath) return
        setImporting(true)
        setImportResult(null)
        try {
            const mcpApi = window.electronAPI?.mcp as any
            const result = await mcpApi?.importConfig?.(filePath)
            if (result?.success) {
                setImportResult({imported: result.imported?.length || 0, skipped: result.skipped?.length || 0})
                setTimeout(() => syncMcpStatus(), 500)
            } else {
                setImportResult({imported: -1, skipped: 0, error: result?.error || '未知错误'})
            }
        } catch (err: any) {
            setImportResult({imported: -1, skipped: 0, error: err?.message || String(err)})
        }
        setImporting(false)
        setTimeout(() => setImportResult(null), 3000)
    }, [syncMcpStatus])

    // ─── 派生数据 ─────────────────────────

    const userMcpServers = mcpServers
        .filter(s => !s.id.startsWith('plugin:'))
        .sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
            return a.name.localeCompare(b.name)
        })

    const userAllEnabled = userMcpServers.length > 0 && userMcpServers.every(s => s.enabled)
    const pluginAllEnabled = pluginMcpServers.length > 0 && pluginMcpServers.every(s => s.enabled)

    // ─── 操作处理函数 ─────────────────────

    const startServer = useCallback(async (server: MCPServer) => {
        return await window.electronAPI?.mcp?.startServer?.(server)
    }, [])

    const stopServer = useCallback(async (serverId: string) => {
        return await window.electronAPI?.mcp?.stopServer?.(serverId)
    }, [])

    const handleToggle = useCallback(async (serverId: string, currentEnabled: boolean) => {
        const newEnabled = !currentEnabled
        toggleMCPServer(serverId)
        const server = mcpServers.find(s => s.id === serverId)
        if (server) {
            await window.electronAPI?.mcp?.setEnabled?.(serverId, newEnabled)
            if (newEnabled) {
                const r = await startServer(server)
                if (r && !r.success) {
                    showError({server, errorMessage: r.error || '启动失败', action: 'enable'})
                    return
                }
            } else {
                const r = await stopServer(serverId)
                if (r && !r.success) {
                    showError({server, errorMessage: r.error || '停止失败', action: 'enable'})
                    return
                }
            }
        }
    }, [mcpServers, toggleMCPServer, startServer, stopServer, showError])

    const handleRemove = useCallback(async (serverId: string) => {
        removeMCPServer(serverId)
        await window.electronAPI?.mcp?.delete?.(serverId)
    }, [removeMCPServer])

    const handleReconnect = useCallback(async (serverId: string, _server: MCPServer) => {
        const r = await window.electronAPI?.mcp?.restartServer?.(serverId)
        if (r && !r.success) {
            showError({server: _server, errorMessage: r.error || '重连失败', action: 'reconnect'})
        }
    }, [showError])

    const handlePluginToggle = useCallback(async (serverId: string, currentEnabled: boolean) => {
        const newEnabled = !currentEnabled
        await window.electronAPI?.mcp?.setEnabled?.(serverId, newEnabled)
        if (!newEnabled) {
            const r = await stopServer(serverId)
            if (r && !r.success) {
                const server = pluginMcpServers.find(s => s.id === serverId)
                if (server) showError({server, errorMessage: r.error || '停止失败', action: 'enable'})
            }
        } else {
            const server = pluginMcpServers.find(s => s.id === serverId)
            if (server) {
                const r = await startServer(server)
                if (r && !r.success) {
                    showError({server, errorMessage: r.error || '启动失败', action: 'enable'})
                    return
                }
            }
        }
        setPluginMcpServers(prev => prev.map(s =>
            s.id === serverId ? {...s, enabled: newEnabled} : s
        ))
    }, [pluginMcpServers, startServer, stopServer, showError])

    // Master Toggle
    const toggleAll = useCallback(async (servers: MCPServer[], currentAllEnabled: boolean) => {
        const newEnabled = !currentAllEnabled
        for (const server of servers) {
            // 用户 MCP 需要更新 store
            if (!server.id.startsWith('plugin:')) toggleMCPServer(server.id)
            await window.electronAPI?.mcp?.setEnabled?.(server.id, newEnabled)
            newEnabled ? startServer(server) : stopServer(server.id)
        }
        if (servers[0]?.id.startsWith('plugin:')) {
            setPluginMcpServers(prev => prev.map(s => ({...s, enabled: newEnabled})))
        }
    }, [toggleMCPServer, startServer, stopServer])

    // ─── 渲染 ────────────────────────────

    return (
        <div className="h-full overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {/* Header */}
            <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-medium text-gray-600">MCP 服务器</h3>
                <div className="flex items-center gap-1 p-0.5 bg-gray-100 rounded-lg">
                    <button onClick={() => setActiveTab('user')}
                            className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all ${
                                activeTab === 'user' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                            }`}>用户 MCP</button>
                    <button onClick={() => setActiveTab('plugin')}
                            className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all flex items-center gap-1 ${
                                activeTab === 'plugin' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                            }`}>
                        插件 MCP
                        {pluginMcpServers.length > 0 && (
                            <span className="px-1 py-0.5 text-[9px] bg-brand-100 text-brand-600 rounded-full">
                                {pluginMcpServers.length}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* 用户 MCP Tab */}
            {activeTab === 'user' && (
                <>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setEditTarget('add')}
                                className="px-2.5 py-1 text-xs text-brand-500 hover:bg-brand-50 rounded-md transition-colors">
                            + 添加服务器
                        </button>
                        <button onClick={handleImportFile} disabled={importing}
                                className="px-2.5 py-1 text-xs text-brand-500 hover:bg-brand-50 rounded-md transition-colors flex items-center gap-1 disabled:opacity-50">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            {importing ? '导入中...' : '导入配置'}
                        </button>
                        {userMcpServers.length > 0 && (
                            <div className="ml-auto flex items-center gap-2">
                                <span className="text-[10px] font-medium text-gray-500">全部开启</span>
                                <Switch checked={userAllEnabled} onChange={() => toggleAll(userMcpServers, userAllEnabled)} />
                            </div>
                        )}
                    </div>

                    {importResult && (
                        <div className={`p-2 rounded-lg text-[10px] ${importResult.imported > 0 ? 'bg-green-50 text-green-700 border border-green-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
                            {importResult.imported > 0
                                ? `✓ 成功导入 ${importResult.imported} 个 MCP 服务器${importResult.skipped > 0 ? `，${importResult.skipped} 个已跳过（重复）` : ''}`
                                : <div className="font-medium">✕ {importResult.error || '导入失败'}</div>
                            }
                        </div>
                    )}

                    <div className="space-y-2.5">
                        {userMcpServers.length === 0 ? (
                            <div className="p-8 text-center bg-gray-50/50 rounded-xl border border-dashed border-gray-200">
                                <svg className="w-10 h-10 mx-auto text-gray-200 mb-3" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="1.5">
                                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                                    <line x1="8" y1="21" x2="16" y2="21"/>
                                    <line x1="12" y1="17" x2="12" y2="21"/>
                                </svg>
                                <p className="text-sm text-gray-400 font-medium">暂无 MCP 服务器</p>
                                <p className="text-[11px] text-gray-300 mt-1">点击上方按钮添加 MCP 服务器</p>
                            </div>
                        ) : (
                            userMcpServers.map(server => (
                                <MCPUserServerCard key={server.id} server={server}
                                    onToggle={() => handleToggle(server.id, server.enabled)}
                                    onEdit={() => setEditTarget(server)}
                                    onDelete={() => handleRemove(server.id)}
                                    onShowTools={() => setToolsModalServer(server)}
                                    onReconnect={() => handleReconnect(server.id, server)}/>
                            ))
                        )}
                    </div>
                </>
            )}

            {/* 插件 MCP Tab */}
            {activeTab === 'plugin' && (
                <div className="space-y-2.5">
                    <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100">
                        <p className="text-[10px] text-blue-600">插件 MCP 的启用状态跟随插件，禁用插件将自动断开连接</p>
                    </div>
                    {pluginMcpServers.length > 0 && (
                        <div className="flex items-center justify-end gap-2">
                            <span className="text-[10px] font-medium text-gray-500">全部开启</span>
                            <Switch checked={pluginAllEnabled} onChange={() => toggleAll(pluginMcpServers, pluginAllEnabled)} />
                        </div>
                    )}

                    {pluginMcpServers.length === 0 ? (
                        <div className="p-8 text-center bg-gray-50/50 rounded-xl border border-dashed border-gray-200">
                            <svg className="w-10 h-10 mx-auto text-gray-200 mb-3" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="1.5">
                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                                <line x1="8" y1="21" x2="16" y2="21"/>
                                <line x1="12" y1="17" x2="12" y2="21"/>
                            </svg>
                            <p className="text-sm text-gray-400 font-medium">暂无插件 MCP</p>
                            <p className="text-[11px] text-gray-300 mt-1">安装带有 MCP 服务器的插件</p>
                        </div>
                    ) : (
                        pluginMcpServers.map(server => (
                            <MCPPluginServerCard key={server.id} server={server}
                                onToggle={() => handlePluginToggle(server.id, server.enabled)}
                                onEdit={() => setEditTarget(server)}
                                onShowTools={() => setToolsModalServer(server)}
                                onReconnect={() => handleReconnect(server.id, server)}/>
                        ))
                    )}
                </div>
            )}

            {/* MCP 编辑/添加弹窗 */}
            {editTarget && (
                <MCPEditModal
                    server={editTarget === 'add' ? null : editTarget}
                    onSave={async (data) => {
                        const target = editTarget
                        if (target === 'add') {
                            const newServer = addMCPServer(data as any)
                            if (newServer?.enabled) window.electronAPI?.mcp?.startServer?.(newServer)
                        } else if (target.id.startsWith('plugin:')) {
                            await window.electronAPI?.mcp?.saveServer?.({...target, ...data})
                            setPluginMcpServers(prev => prev.map(s =>
                                s.id === target.id ? {...s, ...data} : s
                            ))
                            if (target.status === 'connected') {
                                await stopServer(target.id)
                                await startServer({...target, ...data})
                                syncMcpStatus()
                            }
                        } else {
                            updateMCPServer(target.id, data)
                        }
                        setEditTarget(null)
                    }}
                    onCancel={() => setEditTarget(null)}
                    onTestError={(server, errorMessage) => showError({server, errorMessage, action: 'test'})}
                />
            )}

            {toolsModalServer && (
                <MCPToolsOverlay server={toolsModalServer} onClose={() => setToolsModalServer(null)}/>
            )}
            <McpErrorOverlay />
        </div>
    )
}
