import {useState} from 'react'
import type {MCPServer} from '@shared/types'
import MarkdownRenderer from '../message-list/MarkdownRenderer'

// ─── 工具函数 ──────────────────────────────

function transportLabel(transport: string, command?: string, url?: string): string {
    switch (transport) {
        case 'stdio':
            return `STDIO (${command || 'n/a'})`
        case 'sse':
            return `SSE (${url || 'n/a'})`
        case 'http':
            return `HTTP (${url || 'n/a'})`
        case 'websocket':
            return `WebSocket (${url || 'n/a'})`
        case 'streamable-http':
            return `Streamable HTTP (${url || 'n/a'})`
        default:
            return transport
    }
}

function statusLabel(status: string): string {
    const LABELS: Record<string, string> = {
        connected: '运行中',
        connecting: '连接中...',
        reconnecting: '重新连接中...',
        stopped: '已停止',
        error: '错误',
    }
    return LABELS[status] || status
}

/** 从工具描述中提取支持格式列表（如 "Word、Excel、PDF..."） */
function extractFormats(description: string): string[] {
    if (!description) return []
    const formatRegex = /(?:支持|支持格式|格式:|如)\s*([^。\n]+?(?:Word|Excel|PDF|WPS|RTF|HTML|XML|MHTML|CSV|JSON|TXT|PNG|JPG|Markdown|\.docx?|\.xlsx?|\.pptx?|\.pdf)[^。\n]*)/i
    const match = description.match(formatRegex)
    if (!match) return []

    const known = ['Word', 'Excel', 'PDF', 'WPS', 'RTF', 'HTML', 'XML', 'MHTML', 'CSV', 'Markdown',
        '.doc', '.docx', '.dot', '.dotx', '.docm', '.dotm', '.wps', '.wpt',
        '.xlsx', '.xlsm', '.xls', '.xla', '.xlt', '.xlsb', '.et', '.ett',
        '.pdf', '.rtf', '.htm', '.xml', '.mhtml', '.mht', '.prn',
        'JSON', 'TXT', 'PNG', 'JPG', 'JPEG']

    return known.filter(fmt => match[1].includes(fmt))
}

interface MCPToolsOverlayProps {
    server: MCPServer & { pluginEnabled?: boolean }
    onClose: () => void
}

/** 单个工具卡片 */
function ToolCard({tool, serverName, isPlugin}: {
    tool: NonNullable<MCPServer['tools']>[number]
    serverName: string
    isPlugin: boolean
}) {
    const [expanded, setExpanded] = useState(false)
    const description = String(tool.description || '')
    const formats = extractFormats(description)
    const properties = (tool.inputSchema as any)?.properties
    const required = (tool.inputSchema as any)?.required || []
    const hasParams = properties && Object.keys(properties).length > 0
    const hasExtra = description.length > 60 || hasParams

    return (
        <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-sm overflow-hidden">
            {/* 头部 */}
            <div
                className={`flex items-start justify-between gap-2 cursor-pointer select-none transition-colors ${
                    hasExtra ? 'hover:bg-[var(--surface-muted)]' : ''
                } p-3.5 ${expanded ? 'pb-2.5' : ''}`}
                onClick={() => hasExtra && setExpanded(!expanded)}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-semibold text-[var(--text-primary)] font-mono truncate">
                            {isPlugin ? `mp_` : `m_`}{serverName}_{tool.name}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-[var(--brand-muted)] text-[var(--brand-primary)] text-2xs font-semibold shrink-0">
                            TOOL
                        </span>
                    </div>
                    {/* 折叠时最多 2 行，展开时全文 */}
                    <div className={`text-xs text-[var(--text-secondary)] leading-relaxed ${!expanded ? 'line-clamp-2' : ''}`}>
                        {description ? (
                            <MarkdownRenderer isUser={false} theme="dark">{description}</MarkdownRenderer>
                        ) : (
                            <span className="italic text-[var(--text-muted)]">无描述</span>
                        )}
                    </div>
                    {/* 格式标签 */}
                    {formats.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                            {formats.map(fmt => (
                                <span key={fmt}
                                      className="px-1.5 py-0.5 bg-[var(--surface-overlay)] border border-[var(--border-muted)] text-2xs text-[var(--text-muted)] rounded">
                                    {fmt}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* 展开箭头 */}
                {hasExtra && (
                    <button
                        onClick={e => { e.stopPropagation(); setExpanded(!expanded) }}
                        className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded shrink-0 mt-0.5 transition-colors"
                    >
                        <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                             viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                    </button>
                )}
            </div>

            {/* 展开内容 */}
            {expanded && (
                <div className="border-t border-[var(--border-muted)] bg-[var(--surface-muted)] px-3.5 py-3 space-y-3">
                    {/* 完整描述 */}
                    {description.length > 60 && (
                        <div>
                            <h5 className="text-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">完整描述</h5>
                            <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
                                <MarkdownRenderer isUser={false} theme="dark">{description}</MarkdownRenderer>
                            </div>
                        </div>
                    )}

                    {/* 参数结构 */}
                    {hasParams && (
                        <div>
                            <h5 className="text-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                                参数
                                <span className="normal-case text-[var(--text-muted)] ml-1">
                                    ({Object.keys(properties).length} 个{required.length > 0 && `，${required.length} 必填`})
                                </span>
                            </h5>
                            <div className="space-y-1.5">
                                {Object.entries(properties).map(([key, prop]: [string, any]) => {
                                    const isRequired = required.includes(key)
                                    return (
                                        <div key={key}
                                             className="flex flex-col gap-0.5 p-2 rounded bg-[var(--surface)] border border-[var(--border-muted)]">
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-xs font-mono font-semibold text-[var(--text-primary)]">
                                                    {key}{isRequired && <span className="text-red-400 ml-0.5">*</span>}
                                                </span>
                                                <span className="text-2xs px-1 py-0.5 rounded bg-[var(--surface-muted)] text-[var(--text-muted)] font-mono">
                                                    {String(prop.type || 'any')}
                                                </span>
                                            </div>
                                            {prop.description && (
                                                <p className="text-2xs text-[var(--text-muted)] leading-relaxed">{String(prop.description)}</p>
                                            )}
                                            {prop.enum && (
                                                <div className="flex flex-wrap gap-1 mt-0.5">
                                                    {(prop.enum as string[]).map((v: string) => (
                                                        <span key={v}
                                                              className="px-1 py-0.5 bg-[var(--brand-muted)] text-[var(--brand-primary)] text-2xs font-mono rounded">
                                                            {v}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

export default function MCPToolsOverlay({server, onClose}: MCPToolsOverlayProps) {
    const isPlugin = server.id.startsWith('plugin:')
    const pluginName = isPlugin ? server.id.split(':')[1] || 'unknown' : ''

    return (
        <div
            className="fixed inset-0 z-modal flex items-center justify-center"
            onClick={onClose}
        >
            {/* 遮罩层 */}
            <div className="absolute inset-0 bg-black/50"/>

            {/* 弹窗 */}
            <div
                onClick={e => e.stopPropagation()}
                className="relative w-[600px] max-h-[85vh] bg-[var(--surface)] rounded-xl shadow-elevated border border-[var(--border)] flex flex-col"
            >
                {/* ─── Header ──────────────────────────────── */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0 bg-[var(--surface-elevated)]">
                    <div className="flex items-center gap-3 min-w-0">
                        {/* 状态指示灯 */}
                        <div className={`w-3 h-3 rounded-full shrink-0 ${
                            server.enabled === false ? 'bg-gray-300' :
                                server.status === 'connected' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.3)]' :
                                    server.status === 'error' ? 'bg-red-500' :
                                        server.status === 'connecting' || server.status === 'reconnecting' ? 'bg-yellow-300 animate-pulse' :
                                            'bg-gray-300'
                        }`}/>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm font-bold text-[var(--text-primary)] truncate">{server.name}</h2>
                                <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold uppercase border shrink-0 ${
                                    isPlugin
                                        ? 'bg-[var(--brand-muted)] text-[var(--brand-primary)] border-[var(--brand-primary)]/20'
                                        : 'bg-[var(--surface-muted)] text-[var(--text-muted)] border-[var(--border)]'
                                }`}>
                                    {isPlugin ? '插件' : server.transport}
                                </span>
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                                <span className={`text-2xs font-medium ${
                                    server.status === 'connected' ? 'text-green-500' :
                                        server.status === 'error' ? 'text-red-400' :
                                            server.status === 'connecting' || server.status === 'reconnecting' ? 'text-yellow-400' :
                                                'text-[var(--text-muted)]'
                                }`}>
                                    {statusLabel(server.status)}
                                </span>
                                {server.tools && server.tools.length > 0 && (
                                    <span className="text-2xs text-[var(--text-muted)]">
                                        {server.tools.length} 个工具
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded-lg transition-colors shrink-0"
                    >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                {/* ─── Body ────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-5">
                    {/* 场景引导 */}
                    <section>
                        <h4 className="text-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">场景引导</h4>
                        <div className="p-3 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs text-[var(--text-secondary)] leading-relaxed">
                            {server.userDescription || <span className="italic text-[var(--text-muted)]">未填写场景描述，Agent 可能无法准确决策何时使用此服务。</span>}
                        </div>
                    </section>

                    <div className="border-t border-[var(--border-muted)]"/>

                    {/* 连接信息 */}
                    <section>
                        <h4 className="text-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">连接信息</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="p-3 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
                                <div className="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider mb-1">传输协议</div>
                                <div className="text-xs font-mono text-[var(--text-primary)] font-medium break-all">
                                    {transportLabel(server.transport, server.command, server.url)}
                                </div>
                            </div>
                            <div className="p-3 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
                                <div className="text-2xs text-[var(--text-muted)] font-medium uppercase tracking-wider mb-1">当前状态</div>
                                <div className={`text-xs font-semibold ${
                                    server.status === 'connected' ? 'text-green-500' :
                                        server.status === 'error' ? 'text-red-400' :
                                            server.status === 'connecting' || server.status === 'reconnecting' ? 'text-yellow-400' :
                                                'text-[var(--text-muted)]'
                                }`}>
                                    {statusLabel(server.status)}
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* 插件来源 */}
                    {isPlugin && (
                        <>
                            <div className="border-t border-[var(--border-muted)]"/>
                            <section>
                                <h4 className="text-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">来源插件</h4>
                                <div className="p-3 rounded-lg bg-[var(--brand-muted)] border border-[var(--brand-primary)]/20 text-xs text-[var(--brand-primary)] font-medium">
                                    插件: {pluginName}
                                </div>
                            </section>
                        </>
                    )}

                    <div className="border-t border-[var(--border-muted)]"/>

                    {/* 工具列表 */}
                    <section>
                        <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-semibold text-[var(--text-primary)]">可用工具</h4>
                            {server.tools && server.tools.length > 0 && (
                                <span className="text-2xs text-[var(--text-muted)] font-medium">{server.tools.length} 个</span>
                            )}
                        </div>

                        {server.tools && server.tools.length > 0 ? (
                            <div className="space-y-2.5">
                                {server.tools.filter(Boolean).map(tool => (
                                    <ToolCard
                                        key={tool.name}
                                        tool={tool}
                                        serverName={server.name}
                                        isPlugin={isPlugin}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="p-8 text-center border border-dashed border-[var(--border)] rounded-lg bg-[var(--surface-muted)]">
                                <p className="text-xs text-[var(--text-muted)]">尚未发现可用工具</p>
                            </div>
                        )}
                    </section>

                    {/* 错误详情 */}
                    {server.status === 'error' && server.errorDetail && (
                        <>
                            <div className="border-t border-[var(--border-muted)]"/>
                            <section>
                                <h4 className="text-2xs font-semibold text-red-400 uppercase tracking-wider mb-2">错误详情</h4>
                                <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-xs text-red-600 break-all font-mono leading-relaxed">
                                    {server.errorDetail}
                                </div>
                            </section>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
