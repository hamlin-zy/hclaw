import {useCallback, useState} from 'react'
import {Switch} from '../common/Switch'
import {CopyButton} from '../common/CopyButton'
import {type ToolState, useToolStore} from '../../stores/toolStore'

// 工具分类配置
const TOOL_CATEGORIES = [
    {
        id: 'file',
        name: '文件操作',
        tools: ['bash', 'file_read', 'file_edit', 'file_write', 'glob', 'grep', 'web_fetch']
    },
    {
        id: 'system',
        name: '系统工具',
        tools: ['ask_user', 'agent', 'skill', 'task_create', 'task_update', 'task_list']
    },
    {
        id: 'vision',
        name: '视觉工具',
        tools: ['analyze_image']
    },
    {
        id: 'audio',
        name: '听觉工具',
        tools: ['speech_to_text']
    }
]

// 工具中文描述映射
const TOOL_DESCRIPTIONS: Record<string, string> = {
    bash: '在用户的工作目录中执行 shell 命令',
    file_read: '读取指定文件的内容，支持行范围读取',
    file_edit: '精确替换文件中的文本片段',
    file_write: '将内容写入指定文件，如果文件已存在则覆盖',
    glob: '搜索文件，支持 glob 模式和正则模式',
    grep: '在文件中搜索匹配的文本内容，支持正则表达式',
    web_fetch: '获取指定 URL 的内容并返回文本',
    ask_user: '向用户提问并等待回答',
    agent: '派生子 Agent 处理子任务',
    skill: '调用技能执行特定任务',
    task_create: '创建新的待办事项任务',
    task_update: '更新待办事项的状态',
    task_list: '列出所有待办事项',
    analyze_image: '使用独立视觉模型分析图片内容（需在模型方案中配置视觉模型）',
    speech_to_text: '使用独立语音模型将音频转换为文字（需在模型方案中配置音频模型）'
}

// 工具默认超时时间（毫秒）
const DEFAULT_TIMEOUTS: Record<string, number> = {
    bash: 30000,
    web_fetch: 15000,
}

// 格式化超时时间为可读字符串
function formatTimeout(timeout: number | null | undefined): string {
    if (timeout === null || timeout === undefined) return '默认'
    if (timeout < 1000) return `${timeout}ms`
    if (timeout < 60000) return `${Math.round(timeout / 1000)}秒`
    return `${Math.round(timeout / 60000)}分钟`
}

// 解析超时字符串为毫秒数
function parseTimeoutToMs(value: string): number | null {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return null
    
    // 纯数字（毫秒）
    if (/^\d+$/.test(trimmed)) {
        return parseInt(trimmed, 10)
    }
    
    // 带单位的数字
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|秒|m|分|min|ms)?$/)
    if (!match) return null
    
    const num = parseFloat(match[1])
    const unit = match[2] || 'ms'
    
    switch (unit) {
        case 's':
        case '秒':
            return num * 1000
        case 'm':
        case '分':
        case 'min':
            return num * 60000
        case 'ms':
            return num
        default:
            return num
    }
}

export default function ToolsDialog() {
    const {tools, hasRehydrated, toggleTool, isLoading} = useToolStore()

    // 统计数据
    const enabledCount = tools.filter(t => t.enabled).length
    const totalCount = tools.length

    // 按 ID 创建映射
    const toolMap = new Map(tools.map(t => [t.id, t]))

    // 禁用所有工具
    const handleDisableAll = useCallback(async () => {
        const updates = tools.map(t => ({id: t.id, enabled: false}))
        await window.electronAPI?.tool?.setEnabledBatch?.(updates)
        useToolStore.getState().setTools(tools.map(t => ({...t, enabled: false})))
    }, [tools])

    // 启用所有工具
    const handleEnableAll = useCallback(async () => {
        const updates = tools.map(t => ({id: t.id, enabled: true}))
        await window.electronAPI?.tool?.setEnabledBatch?.(updates)
        useToolStore.getState().setTools(tools.map(t => ({...t, enabled: true})))
    }, [tools])

    return (
        <div className="h-full overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-xs font-medium" style={{color: 'var(--text-primary)'}}>内置工具</h3>
                    <p className="text-[10px] mt-0.5" style={{color: 'var(--text-muted)'}}>
                        已启用 {enabledCount}/{totalCount} 个工具
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleDisableAll}
                        className="px-2 py-1 text-[10px] rounded transition-colors"
                        style={{
                            color: 'var(--text-muted)',
                            border: '1px solid var(--border)',
                            opacity: enabledCount === 0 ? 0.4 : 1,
                            cursor: enabledCount === 0 ? 'not-allowed' : 'pointer'
                        }}
                        onMouseEnter={e => { if (enabledCount > 0) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-muted)' }}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
                        disabled={enabledCount === 0}
                    >
                        全部禁用
                    </button>
                    <button
                        onClick={handleEnableAll}
                        className="px-2 py-1 text-[10px] rounded transition-colors"
                        style={{
                            color: 'var(--brand-primary)',
                            border: '1px solid var(--brand-muted)',
                            opacity: enabledCount === totalCount ? 0.4 : 1,
                            cursor: enabledCount === totalCount ? 'not-allowed' : 'pointer'
                        }}
                        onMouseEnter={e => { if (enabledCount < totalCount) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--brand-muted)' }}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
                        disabled={enabledCount === totalCount}
                    >
                        全部启用
                    </button>
                </div>
            </div>

            {/* 进度条 */}
            <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{backgroundColor: 'var(--border)'}}
            >
                <div
                    className="h-full transition-all duration-300 rounded-full"
                    style={{
                        width: totalCount > 0 ? `${(enabledCount / totalCount) * 100}%` : '0%',
                        backgroundColor: 'var(--brand-primary)'
                    }}
                />
            </div>

            {/* 工具列表 */}
            {isLoading && !hasRehydrated ? (
                <div className="p-8 text-center">
                    <div
                        className="animate-spin w-6 h-6 border-2 border-t-transparent rounded-full mx-auto"
                        style={{
                            borderColor: 'var(--brand-muted)',
                            borderTopColor: 'var(--brand-primary)'
                        }}
                    />
                    <p className="text-sm mt-2" style={{color: 'var(--text-muted)'}}>加载中...</p>
                </div>
            ) : (
                <div className="space-y-5">
                    {TOOL_CATEGORIES.map(category => {
                        const categoryTools = category.tools
                            .map(id => toolMap.get(id))
                            .filter((t): t is ToolState => t !== undefined)

                        if (categoryTools.length === 0) return null

                        const categoryEnabled = categoryTools.filter(t => t.enabled).length

                        return (
                            <div key={category.id}>
                                {/* 类别头部 — 带下划线的分组标签 */}
                                <div className="flex items-center gap-2 mb-2.5">
                                    <span
                                        className="text-[10px] font-semibold uppercase tracking-wider"
                                        style={{color: 'var(--text-muted)'}}
                                    >
                                        {category.name}
                                    </span>
                                    <span
                                        className="text-[9px] px-1.5 py-0.5 rounded-full"
                                        style={{
                                            color: 'var(--text-muted)',
                                            backgroundColor: 'var(--surface-muted)'
                                        }}
                                    >
                                        {categoryEnabled}/{categoryTools.length}
                                    </span>
                                    <span
                                        className="flex-1 h-px"
                                        style={{backgroundColor: 'var(--border)'}}
                                    />
                                </div>
                                <div className="space-y-2">
                                    {categoryTools.map(tool => (
                                        <ToolCard
                                            key={tool.id}
                                            tool={tool}
                                            description={TOOL_DESCRIPTIONS[tool.id] || tool.description}
                                            onToggle={() => toggleTool(tool.id)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* 空状态 */}
            {tools.length === 0 && hasRehydrated && !isLoading && (
                <div
                    className="p-8 text-center rounded-xl border border-dashed"
                    style={{
                        backgroundColor: 'var(--surface-muted)',
                        borderColor: 'var(--border)'
                    }}
                >
                    <svg
                        className="w-10 h-10 mx-auto mb-3"
                        style={{color: 'var(--text-muted)'}}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                    <p className="text-sm" style={{color: 'var(--text-muted)'}}>暂无工具数据</p>
                    <p className="text-[11px] mt-1" style={{color: 'var(--text-muted)'}}>请重启应用以加载内置工具</p>
                </div>
            )}

            {/* 提示信息 */}
            <div
                className="p-3 rounded-lg mt-4"
                style={{
                    backgroundColor: 'var(--warning-muted)',
                    border: '1px solid var(--warning)',
                    borderColor: 'color-mix(in srgb, var(--warning) 20%, transparent)'
                }}
            >
                <p className="text-[10px]" style={{color: 'var(--warning)'}}>
                    禁用工具后，该工具将不会出现在 LLM 的工具列表中。
                    某些关键工具（如 bash、file_read）禁用后可能影响 Agent 的正常工作。
                </p>
            </div>
        </div>
    )
}

// 工具卡片组件（支持编辑超时时间）
function ToolCard({tool, description, onToggle}: {tool: ToolState; description: string; onToggle: () => void}) {
    const [isEditingTimeout, setIsEditingTimeout] = useState(false)
    const [timeoutInput, setTimeoutInput] = useState('')
    const {setToolTimeout} = useToolStore()
    
    // 工具的默认超时时间
    const defaultTimeout = DEFAULT_TIMEOUTS[tool.id]
    
    // 开始编辑超时时间
    const handleStartEditTimeout = useCallback(() => {
        setTimeoutInput(tool.timeout !== null ? String(tool.timeout) : '')
        setIsEditingTimeout(true)
    }, [tool.timeout])
    
    // 取消编辑
    const handleCancelEditTimeout = useCallback(() => {
        setIsEditingTimeout(false)
        setTimeoutInput('')
    }, [])
    
    // 保存超时时间
    const handleSaveTimeout = useCallback(() => {
        const parsed = parseTimeoutToMs(timeoutInput)
        setToolTimeout(tool.id, parsed)
        setIsEditingTimeout(false)
        setTimeoutInput('')
    }, [timeoutInput, tool.id, setToolTimeout])
    
    // 重置为默认值
    const handleResetTimeout = useCallback(() => {
        setToolTimeout(tool.id, null)
        setIsEditingTimeout(false)
        setTimeoutInput('')
    }, [tool.id, setToolTimeout])
    
    // 键盘事件处理
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSaveTimeout()
        } else if (e.key === 'Escape') {
            handleCancelEditTimeout()
        }
    }, [handleSaveTimeout, handleCancelEditTimeout])
    
    return (
        <div
            className="flex items-center justify-between p-3 rounded-lg transition-all duration-150"
            style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-card)',
            }}
            onMouseEnter={e => {
                const el = e.currentTarget as HTMLElement
                el.style.borderColor = 'var(--border-emphasis)'
                el.style.boxShadow = 'var(--shadow-elevated)'
            }}
            onMouseLeave={e => {
                const el = e.currentTarget as HTMLElement
                el.style.borderColor = 'var(--border)'
                el.style.boxShadow = 'var(--shadow-card)'
            }}
        >
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                    <code
                        className="text-xs font-mono px-1.5 py-0.5 rounded"
                        style={{
                            color: 'var(--brand-primary)',
                            backgroundColor: 'var(--brand-muted)'
                        }}
                    >
                        {tool.name}
                    </code>
                    <CopyButton name={tool.name} />
                    <span
                        className="px-1.5 py-0.5 text-[9px] font-medium rounded"
                        style={tool.enabled
                            ? {
                                color: 'var(--success)',
                                backgroundColor: 'var(--success-muted)'
                            }
                            : {
                                color: 'var(--text-muted)',
                                backgroundColor: 'var(--surface-muted)'
                            }
                        }
                    >
                        {tool.enabled ? '已启用' : '已禁用'}
                    </span>
                </div>
                <p className="text-[10px] mt-1 truncate" style={{color: 'var(--text-secondary)'}}>
                    {description}
                </p>
                
                {/* 超时时间显示/编辑 */}
                <div className="flex items-center gap-1 mt-1.5">
                    {isEditingTimeout ? (
                        <div className="flex items-center gap-1">
                            <input
                                type="text"
                                value={timeoutInput}
                                onChange={(e) => setTimeoutInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={defaultTimeout ? String(defaultTimeout) : '60000'}
                                className="w-20 px-1.5 py-0.5 text-[10px] rounded focus:outline-none"
                                style={{
                                    border: '1px solid var(--border)',
                                    backgroundColor: 'var(--surface)',
                                    color: 'var(--text-primary)',
                                }}
                                autoFocus
                            />
                            <span className="text-[9px]" style={{color: 'var(--text-muted)'}}>ms</span>
                            <button
                                onClick={handleSaveTimeout}
                                className="px-1.5 py-0.5 text-[9px] rounded transition-colors"
                                style={{
                                    backgroundColor: 'var(--brand-primary)',
                                    color: 'var(--text-inverse)'
                                }}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '0.85'}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
                            >
                                保存
                            </button>
                            <button
                                onClick={handleCancelEditTimeout}
                                className="px-1.5 py-0.5 text-[9px] rounded transition-colors"
                                style={{
                                    backgroundColor: 'var(--surface-muted)',
                                    color: 'var(--text-secondary)',
                                    border: '1px solid var(--border)'
                                }}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--border)'}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-muted)'}
                            >
                                取消
                            </button>
                            <button
                                onClick={handleResetTimeout}
                                className="px-1.5 py-0.5 text-[9px] rounded transition-colors"
                                style={{color: 'var(--warning)'}}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--warning-muted)'}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
                                title="重置为默认值"
                            >
                                重置
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={handleStartEditTimeout}
                            className="flex items-center gap-1 text-[9px] transition-colors"
                            style={{color: 'var(--text-muted)'}}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'}
                            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'}
                            title={defaultTimeout ? `默认: ${formatTimeout(defaultTimeout)}` : '点击编辑'}
                        >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10"/>
                                <path d="M12 6v6l4 2"/>
                            </svg>
                            <span>超时: {formatTimeout(tool.timeout)}</span>
                        </button>
                    )}
                </div>
            </div>
            <Switch checked={tool.enabled} onChange={onToggle} />
        </div>
    )
}
