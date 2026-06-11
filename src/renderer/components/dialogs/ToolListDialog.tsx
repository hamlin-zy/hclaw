import {useCallback, useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'

// 类型来自 window.electronAPI 返回值
// ToolDefinitionForLLM 已在 env.d.ts 定义

// 本地类型别名，保持与组件内部使用一致
type ToolMcpListResult = {
    success: boolean
    tools?: ToolDefinitionForLLM[]
    mcpServers?: Array<{
        serverId: string
        serverName: string
        status: string
        tools: ToolDefinitionForLLM[]
    }>
    error?: string
}

/** 格式化 JSON Schema 属性为可读字符串 */
function formatPropertyType(prop: Record<string, unknown>): string {
    const type = prop.type as string
    if (prop.enum) {
        return `${type} (enum: ${(prop.enum as string[]).map(v => `"${v}"`).join(' | ')})`
    }
    if (prop.const !== undefined) {
        return `${type} (const: ${JSON.stringify(prop.const)})`
    }
    if (type === 'array' && prop.items) {
        const items = prop.items as Record<string, unknown>
        return `array<${formatPropertyType(items)}>`
    }
    return type || 'any'
}

/** 工具卡片组件 */
function ToolCard({tool, serverName}: {tool: ToolDefinitionForLLM; serverName?: string}) {
    const [isExpanded, setIsExpanded] = useState(false)
    const properties = tool.inputSchema.properties || {}
    const required = tool.inputSchema.required || []
    const hasParams = Object.keys(properties).length > 0

    return (
        <div className="border border-[var(--border)] rounded-lg overflow-hidden">
            {/* 头部：工具名 + 描述 */}
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-3 text-left hover:bg-[var(--surface-muted)] transition-colors flex items-start gap-2"
            >
                <span className="px-1.5 py-0.5 bg-[var(--brand-muted)] text-[var(--brand-primary)] text-[10px] font-medium rounded shrink-0">
                    {tool.name}
                </span>
                {serverName && (
                    <span className="px-1.5 py-0.5 bg-[var(--info-muted)] text-[var(--info)] text-[9px] font-medium rounded shrink-0">
                        {serverName}
                    </span>
                )}
                <div className="flex-1 min-w-0">
                    <p className="text-xs text-[var(--text-secondary)] line-clamp-2">
                        {tool.description || '无描述'}
                    </p>
                    {hasParams && (
                        <p className="text-[10px] text-[var(--text-muted)] mt-1">
                            参数: {Object.keys(properties).length} 个
                            {required.length > 0 && (
                                <span className="text-[var(--warning)]"> (必填: {required.join(', ')})</span>
                            )}
                        </p>
                    )}
                </div>
                <svg
                    className={`w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <path d="M6 9l6 6 6-6" />
                </svg>
            </button>

            {/* 展开内容：参数详情 */}
            {isExpanded && hasParams && (
                <div className="border-t border-[var(--border)] bg-[var(--surface-muted)] p-3">
                    <table className="w-full text-[10px]">
                        <thead>
                            <tr className="text-[var(--text-muted)]">
                                <th className="text-left font-medium pb-1.5 w-24">参数名</th>
                                <th className="text-left font-medium pb-1.5 w-16">类型</th>
                                <th className="text-left font-medium pb-1.5">描述</th>
                            </tr>
                        </thead>
                        <tbody className="space-y-1.5">
                            {Object.entries(properties).map(([key, prop]) => (
                                <tr key={key} className="text-[var(--text-secondary)]">
                                    <td className="py-0.5">
                                        <span className={`px-1 py-0.5 rounded ${
                                            required.includes(key)
                                                ? 'bg-[var(--error-muted)] text-[var(--error)]'
                                                : 'bg-[var(--surface-elevated)] text-[var(--text-muted)]'
                                        }`}>
                                            {key}
                                        </span>
                                    </td>
                                    <td className="py-0.5 font-mono text-[9px]">
                                        {formatPropertyType(prop)}
                                    </td>
                                    <td className="py-0.5 text-[var(--text-secondary)]">
                                        {prop.description || '-'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* 原始 JSON Schema */}
                    <details className="mt-3">
                        <summary className="text-[10px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]">
                            查看原始 Schema
                        </summary>
                        <pre className="mt-1 p-2 bg-[var(--surface)] rounded text-[9px] text-[var(--text-muted)] overflow-x-auto">
                            {JSON.stringify(tool.inputSchema, null, 2)}
                        </pre>
                    </details>
                </div>
            )}
        </div>
    )
}

export default function ToolListDialog() {
    const [data, setData] = useState<ToolMcpListResult | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [activeTab, setActiveTab] = useState<'builtin' | 'mcp'>('builtin')
    const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())
    const toggleServer = (id: string) => {
        setExpandedServers(prev => {
            const next = new Set(prev)
            if (!next.delete(id)) next.add(id)
            return next
        })
    }

    // 加载数据
    const loadData = useCallback(async () => {
        setIsLoading(true)
        setError(null)
        try {
            const result = await window.electronAPI?.toolMcpList?.()
            setData(result as ToolMcpListResult)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        loadData()
    }, [loadData])

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-40">
                <div className="animate-spin w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full" />
                <span className="ml-3 text-sm text-[var(--text-muted)]">加载中...</span>
            </div>
        )
    }

    if (error) {
        return (
            <div className="p-4">
                <div className="p-4 bg-[var(--error-muted)] rounded-lg border border-[var(--error)]/20">
                    <h4 className="text-sm font-medium text-[var(--error)] mb-2">加载失败</h4>
                    <pre className="text-xs text-[var(--error)] whitespace-pre-wrap break-all">{error}</pre>
                </div>
            </div>
        )
    }

    if (!data?.success) {
        return (
            <div className="p-4">
                <div className="p-4 bg-[var(--warning-muted)] rounded-lg border border-[var(--warning)]/20">
                    <h4 className="text-sm font-medium text-[var(--warning)] mb-2">获取失败</h4>
                    <pre className="text-xs text-[var(--warning)] whitespace-pre-wrap break-all">
                        {data?.error || '未知错误'}
                    </pre>
                </div>
            </div>
        )
    }

    const tools = data.tools || []
    const mcpServers = data.mcpServers || []

    // 统计信息
    const totalParams = tools.reduce((acc, t) => acc + Object.keys(t.inputSchema.properties || {}).length, 0)
    const requiredParams = tools.reduce((acc, t) => acc + (t.inputSchema.required?.length || 0), 0)
    const mcpToolCount = mcpServers.reduce((acc, s) => acc + s.tools.length, 0)
    const connectedMcpCount = mcpServers.filter(s => s.status === 'connected').length

    return (
        <div className="h-full overflow-hidden flex flex-col">
            {/* 统计信息栏 */}
            <div className="shrink-0 bg-[var(--surface)] border-b border-[var(--border)] p-3">
                <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
                    <span>
                        内置工具: <strong className="text-[var(--text-primary)]">{tools.length}</strong>
                        {totalParams > 0 && (
                            <span className="ml-1">({totalParams} 参数
                                {requiredParams > 0 && <span className="text-[var(--error)]">, {requiredParams} 必填</span>})
                            </span>
                        )}
                    </span>
                    <span>
                        MCP 工具: <strong className="text-[var(--text-primary)]">{mcpToolCount}</strong>
                        {mcpServers.length > 0 && (
                            <span className="ml-1">({connectedMcpCount}/{mcpServers.length} 服务器已连接)</span>
                        )}
                    </span>
                    <button
                        type="button"
                        onClick={loadData}
                        className="ml-auto px-2 py-0.5 text-[10px] text-[var(--brand-primary)] hover:bg-[var(--brand-muted)] rounded transition-colors"
                    >
                        刷新
                    </button>
                </div>
            </div>

            {/* Tab 切换 */}
            <div className="shrink-0 flex border-b border-[var(--border)]">
                <button
                    type="button"
                    onClick={() => setActiveTab('builtin')}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                        activeTab === 'builtin'
                            ? 'text-[var(--brand-primary)] border-b-2 border-[var(--brand-primary)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}
                >
                    内置工具 ({tools.length})
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('mcp')}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                        activeTab === 'mcp'
                            ? 'text-[var(--brand-primary)] border-b-2 border-[var(--brand-primary)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}
                >
                    MCP 工具 ({mcpToolCount})
                </button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                {activeTab === 'builtin' ? (
                    // 内置工具列表
                    tools.length > 0 ? (
                        <div className="space-y-2">
                            {tools.map((tool, index) => (
                                <ToolCard key={index} tool={tool} />
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 text-center bg-[var(--surface-muted)] rounded-lg border border-dashed border-[var(--border)]">
                            <p className="text-sm text-[var(--text-muted)]">暂无内置工具</p>
                        </div>
                    )
                ) : (
                    // MCP 工具列表
                    mcpServers.length > 0 ? (
                        <div className="space-y-6">
                            {mcpServers.map((server) => (
                                <div key={server.serverId}>
                                    {/* 可点击 header */}
                                    <div
                                        className="flex items-center gap-2 mb-3 cursor-pointer select-none hover:bg-[var(--surface-muted)] rounded px-1 py-0.5 -mx-1 transition-colors"
                                        onClick={() => toggleServer(server.serverId)}
                                    >
                                        {/* chevron 箭头 */}
                                        <svg
                                            className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform duration-200 ${
                                                expandedServers.has(server.serverId) ? 'rotate-90' : ''
                                            }`}
                                            viewBox="0 0 16 16"
                                            fill="currentColor"
                                        >
                                            <path d="M6 3l5 5-5 5" />
                                        </svg>
                                        <span className="px-2 py-0.5 bg-[var(--info-muted)] text-[var(--info)] text-[10px] font-medium rounded">
                                            {server.serverName}
                                        </span>
                                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                                            server.status === 'connected'
                                                ? 'bg-[var(--success-muted)] text-[var(--success)]'
                                                : 'bg-[var(--surface-elevated)] text-[var(--text-muted)]'
                                        }`}>
                                            {server.status === 'connected' ? '已连接' : server.status}
                                        </span>
                                        <span className="text-xs text-[var(--text-muted)]">
                                            ({server.tools.length} 个工具)
                                        </span>
                                    </div>
                                    {/* 工具列表（含折叠动画） */}
                                    <AnimatePresence initial={false}>
                                        {expandedServers.has(server.serverId) && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.2, ease: 'easeInOut' }}
                                                className="overflow-hidden"
                                            >
                                                {server.tools.length > 0 ? (
                                                    <div className="space-y-2">
                                                        {server.tools.map((tool, index) => (
                                                            <ToolCard key={index} tool={tool} serverName={server.serverName} />
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <p className="text-xs text-[var(--text-muted)] italic">无工具</p>
                                                )}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 text-center bg-[var(--surface-muted)] rounded-lg border border-dashed border-[var(--border)]">
                            <p className="text-sm text-[var(--text-muted)]">暂无 MCP 服务器</p>
                        </div>
                    )
                )}
            </div>

            {/* 提示信息 */}
            <div className="shrink-0 p-3 bg-[var(--info-muted)]/50 rounded-none border-t border-[var(--info)]/20">
                <p className="text-[10px] text-[var(--info)]">
                    <strong>用途说明：</strong>此列表展示实际传递给 LLM 的工具定义，包括名称、描述和参数 Schema。
                    检查是否存在不合理的描述、缺失的参数说明或工具数量异常。
                </p>
            </div>
        </div>
    )
}
