import {useState, useCallback} from 'react'
import {Switch} from '../common/Switch'
import {CopyButton} from '../common/CopyButton'
import type {MCPServer} from '@shared/types'
import {statusDotClasses, transportColorClasses, buildMcpConfigJson} from './MCPUtils'

type PluginServer = MCPServer & { pluginEnabled?: boolean }

export default function MCPPluginServerCard({
    server,
    onToggle,
    onEdit,
    onShowTools,
    onReconnect,
}: {
    server: PluginServer
    onToggle: () => void
    onEdit: () => void
    onShowTools: () => void
    onReconnect: () => void
}) {
    // 从 id 中提取插件名称，格式为 plugin:{pluginName}:{originalId}
    const pluginName = server.id.split(':')[1] || 'unknown'
    const isPluginDisabled = server.pluginEnabled === false
    const [copied, setCopied] = useState(false)

    const handleCopyConfig = useCallback(async (e: React.MouseEvent) => {
        e.stopPropagation()
        try {
            await navigator.clipboard.writeText(buildMcpConfigJson(server))
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            /* clipboard unavailable */
        }
    }, [server])

    return (
        <div
            onClick={onShowTools}
            className={`group rounded-xl bg-white border transition-all cursor-pointer overflow-hidden ${
                server.enabled ? 'border-gray-100 hover:border-gray-200 hover:shadow-sm hover:border-blue-200' :
                    'border-gray-50 opacity-60'
            }`}
        >
            <div className="p-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full ${statusDotClasses(server.status, server.enabled)}`}/>
                        <div>
                            <div className="text-xs font-semibold text-gray-700 flex items-center gap-1">
                                <span>{server.name}</span>
                                <CopyButton name={server.name} />
                                <span
                                    className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-600 font-medium uppercase border border-blue-100">插件</span>
                                <span
                                    className="text-[9px] px-1 py-0.5 rounded bg-gray-50 text-gray-400 font-medium uppercase border border-gray-100">{server.transport}</span>
                                {server.status === 'connected' && server.enabled && (
                                    <span
                                        className="text-[9px] text-gray-400 font-normal">{(server.tools?.length || 0)} 个工具</span>
                                )}
                                {!server.enabled && (
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">已禁用</span>
                                )}
                            </div>
                            <div className="text-[10px] text-gray-400 mt-0.5">插件: {pluginName}{isPluginDisabled && '（已禁用）'}</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={onReconnect}
                            className="p-1.5 text-gray-400 hover:text-brand-500 hover:bg-brand-50 rounded-md transition-all"
                            title="重新连接"
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M23 4v6h-6M1 20v-6h6"/>
                                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                            </svg>
                        </button>
                        <Switch checked={server.enabled} onChange={onToggle} disabled={isPluginDisabled} />
                        <button
                            onClick={handleCopyConfig}
                            className="p-1.5 text-gray-300 hover:text-brand-500 hover:bg-brand-50 rounded-md transition-all"
                            title={copied ? '已复制' : '复制 JSON 配置'}
                        >
                            {copied ? (
                                <svg className="w-3.5 h-3.5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M20 6L9 17l-5-5"/>
                                </svg>
                            ) : (
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                </svg>
                            )}
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onEdit()
                            }}
                            className="p-1.5 text-gray-300 hover:text-brand-500 hover:bg-brand-50 rounded-md transition-all"
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
