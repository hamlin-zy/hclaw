import {useState} from 'react'
import type {MCPServer} from '@shared/types'
import {confirm} from '../ConfirmDialog'

// ─── Helpers ──────────────────────────────

function pairsToObject(pairs: Array<{ key: string; value: string }>): Record<string, string> {
    const obj: Record<string, string> = {}
    pairs.forEach(p => {
        if (p.key.trim() && p.value.trim()) obj[p.key.trim()] = p.value.trim()
    })
    return obj
}

function objectToPairs(obj?: Record<string, string>): Array<{ key: string; value: string }> {
    if (!obj) return []
    return Object.entries(obj).map(([key, value]) => ({key, value}))
}

// ─── KVPairEditor ──────────────────────────

function KVPairEditor({pairs, onChange, keyPlaceholder = '键名', valuePlaceholder = '值'}: {
    pairs: Array<{ key: string; value: string }>
    onChange: (pairs: Array<{ key: string; value: string }>) => void
    keyPlaceholder?: string
    valuePlaceholder?: string
}) {
    const updatePair = (index: number, field: 'key' | 'value', val: string) => {
        const newPairs = pairs.map((p, i) => (i === index ? {...p, [field]: val} : p))
        onChange(newPairs)
    }
    const addPair = () => onChange([...pairs, {key: '', value: ''}])
    const removePair = (index: number) => {
        const filtered = pairs.filter((_, i) => i !== index)
        onChange(filtered.length === 0 ? [] : filtered)
    }

    return (
        <div className="space-y-1.5">
            {pairs.map((pair, i) => (
                <div key={i} className="flex gap-1.5 items-center">
                    <input type="text" value={pair.key} onChange={(e) => updatePair(i, 'key', e.target.value)}
                           placeholder={keyPlaceholder}
                           className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded-lg font-mono focus:border-brand-500 outline-none min-w-0"/>
                    <span className="text-gray-300 text-xs shrink-0">=</span>
                    <input type="text" value={pair.value} onChange={(e) => updatePair(i, 'value', e.target.value)}
                           placeholder={valuePlaceholder}
                           className="flex-[2] px-2 py-1 text-xs border border-gray-200 rounded-lg font-mono focus:border-brand-500 outline-none min-w-0"/>
                    <div className="flex gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={async () => {
                            const filePath = await window.electronAPI?.selectFilePath?.()
                            if (filePath) updatePair(i, 'value', filePath)
                        }}
                                className="p-1 text-gray-300 hover:text-brand-500 transition-colors"
                                title="选择文件">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                                <line x1="16" y1="13" x2="8" y2="13"/>
                                <line x1="16" y1="17" x2="8" y2="17"/>
                            </svg>
                        </button>
                        <button onClick={async () => {
                            const dir = await window.electronAPI?.openFolderDialog?.()
                            if (dir) updatePair(i, 'value', dir)
                        }}
                                className="p-1 text-gray-300 hover:text-brand-500 transition-colors"
                                title="选择文件夹">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                            </svg>
                        </button>
                    </div>
                    <button onClick={() => removePair(i)}
                            className="shrink-0 p-1 text-gray-300 hover:text-red-400 transition-colors"
                            title="删除">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2.5">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
            ))}
            <button onClick={addPair}
                    className="flex items-center gap-1 text-[10px] font-medium text-brand-500 hover:text-brand-600 transition-colors">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                添加
            </button>
        </div>
    )
}

// ─── MCPEditCard ───────────────────────────

export default function MCPEditCard({server, onSave, onCancel, onTestError}: {
    server?: MCPServer
    onSave: (data: Partial<MCPServer>) => void
    onCancel: () => void
    onTestError?: (server: MCPServer, errorMessage: string) => void
}) {
    const [activeTab, setActiveTab] = useState<'manual' | 'json'>('manual')
    const [jsonInput, setJsonInput] = useState('')
    const [jsonError, setJsonError] = useState<string | null>(null)

    const [name, setName] = useState(server?.name || '')
    const [transport, setTransport] = useState(server?.transport || 'stdio')
    const [userDescription, setUserDescription] = useState(server?.userDescription || '')
    const [command, setCommand] = useState(server?.command || '')
    const [argsStr, setArgsStr] = useState(server?.args?.join('\n') || '')
    const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>(objectToPairs(server?.env))
    const [cwd, setCwd] = useState(server?.cwd || '')
    const [url, setUrl] = useState(server?.url || '')
    const [headersPairs, setHeadersPairs] = useState<Array<{ key: string; value: string }>>(objectToPairs(server?.headers))
    const [timeoutStr, setTimeoutStr] = useState(server?.timeout ? String(server.timeout) : '60000')

    // 测试连接状态
    const [isTesting, setIsTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ success: boolean; error?: string; toolCount?: number } | null>(null)

    // 解析 JSON 配置到表单
    const handleParseJson = () => {
        try {
            const parsed = JSON.parse(jsonInput)
            const mcpServers = parsed.mcpServers || parsed
            const mcpConfigKey = Object.keys(mcpServers)[0]
            const mcpConfig = mcpServers[mcpConfigKey]
            if (!mcpConfig) {
                setJsonError('未找到有效的 MCP 配置')
                return
            }

            if (mcpConfigKey) setName(mcpConfigKey)
            if (mcpConfig.transport) setTransport(mcpConfig.transport)
            if (mcpConfig.command) setCommand(mcpConfig.command)
            if (mcpConfig.args) setArgsStr(Array.isArray(mcpConfig.args) ? mcpConfig.args.join('\n') : mcpConfig.args)
            if (mcpConfig.env) setEnvPairs(objectToPairs(mcpConfig.env))
            if (mcpConfig.url) setUrl(mcpConfig.url)
            if (mcpConfig.headers) setHeadersPairs(objectToPairs(mcpConfig.headers))
            if (mcpConfig.cwd) setCwd(mcpConfig.cwd)
            if (mcpConfig.timeout) setTimeoutStr(String(mcpConfig.timeout))

            const possibleName = parsed.mcpServers ? mcpConfigKey : (mcpConfig.name || '')
            if (possibleName && !name) setName(possibleName)

            setJsonError(null)
            setActiveTab('manual')
        } catch (e: any) {
            setJsonError(`配置解析失败: ${e.message}`)
        }
    }

    // 从表单数据同步到 JSON 输入框
    const syncToJsonInput = () => {
        try {
            const args = argsStr.split('\n').map(s => s.trim()).filter(Boolean)
            const env = pairsToObject(envPairs)
            const headers = pairsToObject(headersPairs)

            const serverConfig: any = {}

            if (transport === 'stdio') {
                serverConfig.command = command || 'uvx'
                serverConfig.args = args.length > 0 ? args : ['']
                if (Object.keys(env).length > 0) serverConfig.env = env
                if (cwd) serverConfig.cwd = cwd
                if (timeoutStr && Number(timeoutStr) !== 60000) serverConfig.timeout = Number(timeoutStr)
            } else {
                serverConfig.transport = transport
                serverConfig.url = url || ''
                if (Object.keys(headers).length > 0) serverConfig.headers = headers
                if (timeoutStr && Number(timeoutStr) !== 60000) serverConfig.timeout = Number(timeoutStr)
            }

            const config = {
                mcpServers: {
                    [name || '服务名']: serverConfig,
                },
            }

            setJsonInput(JSON.stringify(config, null, 2))
            setJsonError(null)
            setActiveTab('json')
        } catch (e: any) {
            setJsonError(`同步到 JSON 失败: ${e.message}`)
            setActiveTab('json')
        }
    }

    const handleTest = async () => {
        setIsTesting(true)
        setTestResult(null)
        try {
            const args = argsStr.split('\n').map(s => s.trim()).filter(Boolean)
            const env = pairsToObject(envPairs)
            const headers = pairsToObject(headersPairs)
            const testId = server?.id ?? `test-${Date.now()}`
            const config = {
                id: testId, name, transport, command, args, env, url, headers, enabled: true,
                cwd: cwd || undefined, timeout: Number(timeoutStr) || 60000,
            }
            const result = await window.electronAPI?.mcp?.testConnection?.(config)
            if (!result) {
                setIsTesting(false)
                return
            }
            setTestResult({success: result.success, error: result.error, toolCount: result.tools?.length})
            // 测试失败 → 通知父组件弹「帮我检查」对话框
            if (!result.success && onTestError) {
                onTestError({
                    id: testId,
                    name, transport, command, args, env, url, headers,
                    enabled: true, status: 'error' as const, tools: [],
                    errorDetail: result.error || '连接失败',
                    cwd: cwd || undefined,
                    timeout: Number(timeoutStr) || 60000,
                    autoApprove: [],
                    denyList: [],
                    userDescription: userDescription || '',
                } as MCPServer, result.error || '连接测试失败')
            }
        } catch (err: any) {
            setTestResult({success: false, error: err.message})
        } finally {
            setIsTesting(false)
        }
    }

    const handleSave = () => {
        if (!name.trim()) return
        const args = argsStr.split('\n').map(s => s.trim()).filter(Boolean)
        const env = pairsToObject(envPairs)
        const headers = pairsToObject(headersPairs)
        const timeout = Number(timeoutStr) || 60000
        onSave({
            name,
            transport,
            userDescription,
            command,
            args,
            env,
            url,
            headers,
            cwd: cwd || undefined,
            timeout,
        })
    }

    return (
        <div className="p-3.5 rounded-xl bg-white border border-brand-200 shadow-sm space-y-3.5">
            {/* Tab Header */}
            <div className="flex p-0.5 bg-gray-50 rounded-lg border border-gray-100">
                <button
                    onClick={() => setActiveTab('manual')}
                    className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all ${activeTab === 'manual' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                >
                    手动配置
                </button>
                <button
                    onClick={syncToJsonInput}
                    className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all ${activeTab === 'json' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                >
                    JSON 导入
                </button>
            </div>

            {activeTab === 'json' ? (
                <div className="space-y-3">
                    <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">粘贴 MCP 配置 JSON</label>
                    <textarea
                        value={jsonInput}
                        onChange={(e) => setJsonInput(e.target.value)}
                        placeholder='{ "mcpServers": { "服务名": { "command": "", "args": ["", ""], "env": {} } } }'
                        rows={Math.max(4, jsonInput.split('\n').length + 3)}
                        className="w-full px-2.5 py-2 text-xs border border-gray-200 rounded-lg font-mono resize-none focus:border-brand-500 outline-none custom-scrollbar"
                    />
                    {jsonError && <p className="text-[10px] text-red-500 px-1">{jsonError}</p>}
                    <button
                        onClick={handleParseJson}
                        disabled={!jsonInput.trim()}
                        className="w-full py-2 text-[10px] font-bold bg-gray-800 text-white rounded-lg hover:bg-black disabled:opacity-50 transition-all"
                    >
                        解析并填充到表单
                    </button>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">服务名称</label>
                            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                                   placeholder="如: SQLite 助手"
                                   className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:border-brand-500 outline-none transition-all"/>
                        </div>
                        <div>
                            <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">传输协议</label>
                            <select value={transport} onChange={(e) => setTransport(e.target.value as any)}
                                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:border-brand-500 outline-none bg-white">
                                <option value="stdio">STDIO (本地命令)</option>
                                <option value="sse">SSE (远程服务 - 已废弃)</option>
                                <option value="http">HTTP (纯 HTTP)</option>
                                <option value="websocket">WebSocket (双向通信)</option>
                                <option value="streamable-http">Streamable HTTP (MCP 推荐)</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1 flex justify-between">
                            场景描述
                            <span className="text-[9px] font-normal lowercase text-brand-500">引导 Agent 使用</span>
                        </label>
                        <input type="text" value={userDescription} onChange={(e) => setUserDescription(e.target.value)}
                               placeholder="描述此服务的作用..."
                               className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:border-brand-500 outline-none"/>
                    </div>

                    {transport === 'stdio' ? (
                        <div className="space-y-3 p-2.5 bg-gray-50/50 rounded-lg border border-gray-100">
                            <div>
                                <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">执行命令
                                    (Command)</label>
                                <input type="text" value={command} onChange={(e) => setCommand(e.target.value)}
                                       placeholder="npx, python, docker..."
                                       className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono focus:border-brand-500 outline-none"/>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">参数 (Arguments,
                                    每行一个)</label>
                                <textarea value={argsStr} onChange={(e) => setArgsStr(e.target.value)}
                                          placeholder="-y&#10;@modelcontextprotocol/server-sqlite"
                                          rows={Math.max(3, argsStr.split('\n').length + 2)}
                                          className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono resize-none custom-scrollbar focus:border-brand-500 outline-none"/>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">环境变量
                                    (Environment)</label>
                                <KVPairEditor pairs={envPairs} onChange={setEnvPairs}
                                              keyPlaceholder="KEY" valuePlaceholder="值"/>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">工作目录
                                    (Working Directory)</label>
                                <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)}
                                       placeholder="/absolute/path/to/working/dir"
                                       className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono focus:border-brand-500 outline-none"/>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3 p-2.5 bg-gray-50/50 rounded-lg border border-gray-100">
                            <div>
                                <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">EndPoint
                                    URL</label>
                                <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
                                       placeholder="http://localhost:3001/sse 或 ws://localhost:3002 或 https://example.com/mcp"
                                       className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono focus:border-brand-500 outline-none"/>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">请求头
                                    (Headers)</label>
                                <KVPairEditor pairs={headersPairs} onChange={setHeadersPairs}
                                              keyPlaceholder="Header-Name" valuePlaceholder="值"/>
                            </div>
                        </div>
                    )}

                    {/* 高级配置 */}
                    <div className="space-y-3 p-2.5 bg-gray-50/50 rounded-lg border border-gray-100/80">
                        <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">高级配置</div>
                        <div>
                            <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1 px-1">超时 (毫秒)</label>
                            <input type="number" value={timeoutStr} onChange={(e) => setTimeoutStr(e.target.value)}
                                   placeholder="60000" min="1000" max="300000" step="1000"
                                   className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg font-mono focus:border-brand-500 outline-none"/>
                        </div>
                    </div>
                </>
            )}

            {testResult && (
                <div
                    className={`p-2.5 rounded-lg text-[10px] border flex items-start gap-2 ${testResult.success ? 'bg-green-50 text-green-700 border-green-100' : 'bg-red-50 text-red-700 border-red-100'}`}>
                    <div className="flex-1 break-all">
                        {testResult.success ? `✓ 连接成功: 发现 ${testResult.toolCount} 个可用工具` : `✕ 连接失败: ${testResult.error}`}
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between pt-1 border-t border-gray-50 mt-2">
                <button onClick={handleTest} disabled={isTesting || !name}
                        className="flex items-center gap-1.5 text-[10px] font-bold text-brand-500 hover:text-brand-600 disabled:opacity-50 transition-colors px-1">
                    {isTesting ? (
                        <div className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"/>
                    ) : (
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                        </svg>
                    )}
                    测试连接
                </button>
                <div className="flex gap-2">
                    <button onClick={onCancel}
                            className="px-3 py-1.5 text-[10px] font-medium text-gray-400 hover:text-gray-600 transition-colors">取消
                    </button>
                    <button onClick={handleSave} disabled={!name}
                            className="px-4 py-1.5 text-[10px] font-bold bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 shadow-sm shadow-brand-500/20 transition-all active:scale-95">
                        保存配置
                    </button>
                </div>
            </div>
        </div>
    )
}
