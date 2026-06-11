import {useCallback, useEffect, useMemo, useState} from 'react'
import {clsx} from 'clsx'
import {Switch} from '../common/Switch'
import {CopyButton} from '../common/CopyButton'
import {AnimatePresence, motion} from 'framer-motion'
import {confirm} from '../ConfirmDialog'
import {useAgentTemplateStore} from '../../stores/agentTemplateStore'
import type {AgentTemplate} from '@shared/types'
import {fuzzyFilter} from '../../lib/search'
import {Layers, Search, RefreshCw, Plus, Edit2, Trash2, X, Check, AlertCircle, ChevronDown, Folder} from 'lucide-react'
import LoadErrorBanner from '../common/LoadErrorBanner'

// 标签样式配置（模块级常量，避免重复创建）
const TAG_STYLES: Record<string, string> = {
    dev:      "bg-[var(--tag-dev-bg)] text-[var(--tag-dev-text)] ring-[var(--tag-dev-border)]",
    builtin:  "bg-[var(--tag-builtin-bg)] text-[var(--tag-builtin-text)] ring-[var(--tag-builtin-border)]",
    'read-only': "bg-[var(--tag-readonly-bg)] text-[var(--tag-readonly-text)] ring-[var(--tag-readonly-border)]",
    plugin:   "bg-[var(--tag-plugin-bg)] text-[var(--tag-plugin-text)] ring-[var(--tag-plugin-border)]",
}
const TAG_BASE_CLASS = "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase ring-1 ring-inset"

function getTagClass(tag: string): string {
    const normalized = tag.toUpperCase().replace('PLUGIN:', '')
    const key = tag.startsWith('plugin:') ? 'plugin'
        : normalized === 'DEV' ? 'dev'
        : normalized === 'BUILTIN' ? 'builtin'
        : normalized === 'READ-ONLY' ? 'read-only'
        : 'read-only'
    return clsx(TAG_BASE_CLASS, TAG_STYLES[key])
}

/** 从标签中提取非内部标签（用于展示） */
function displayTags(tags?: string[]): string[] {
    return tags?.filter(t => !t.startsWith('plugin:') && !t.startsWith('source:')) ?? []
}

// Agent 卡片组件
function AgentCard({template, onEdit, onDelete, onToggle, onPreview, readOnly}: {
    template: AgentTemplate
    onEdit: () => void
    onDelete: () => void
    onToggle: () => void
    onPreview?: () => void
    readOnly?: boolean
}) {

    return (
        <div
            onClick={() => onPreview?.()}
            className={clsx(
                "group relative flex flex-col gap-4 rounded-xl border p-5 transition-all duration-200 cursor-pointer",
                template.enabled
                    ? "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--border-muted)] hover:shadow-sm"
                    : "bg-[var(--surface-muted)]/20 border-[var(--border)] opacity-60"
            )}
        >
            {/* Icon + Content (title row with buttons | tags | description — full width) */}
            <div className="flex items-start gap-4">
                {/* Agent 图标 */}
                <div className={clsx(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
                    template.enabled
                        ? "bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]"
                        : "bg-[var(--surface-muted)] text-[var(--text-muted)]"
                )}>
                    <Layers className="w-5 h-5"/>
                </div>

                {/* Content Area */}
                <div className="flex-1 min-w-0">
                    {/* Title Row: name + action buttons */}
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-1 min-w-0">
                            <h3 className="text-sm font-semibold tracking-tight text-[var(--text-primary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
                                {template.name}
                            </h3>
                            <CopyButton name={template.name} />
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
                            <Switch checked={template.enabled} onChange={onToggle}/>
                            <div className="flex items-center gap-1 pl-2 border-l border-[var(--border)]">
                                <button
                                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                                    disabled={readOnly}
                                    className={clsx(
                                        "p-1.5 rounded-md transition-all",
                                        readOnly
                                            ? "text-[var(--text-muted)]/50 cursor-not-allowed"
                                            : "text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10"
                                    )}
                                    title="编辑"
                                >
                                    <Edit2 className="w-4 h-4"/>
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                                    disabled={readOnly}
                                    className={clsx(
                                        "p-1.5 rounded-md transition-all",
                                        readOnly
                                            ? "text-[var(--text-muted)]/50 cursor-not-allowed"
                                            : "text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10"
                                    )}
                                    title="删除"
                                >
                                    <Trash2 className="w-4 h-4"/>
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Tags */}
                    {template.tags && template.tags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {displayTags(template.tags).map(tag => (
                                <span key={tag} className={getTagClass(tag)}>{tag}</span>
                            ))}
                        </div>
                    )}

                    {/* 描述 — full width */}
                    <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)] line-clamp-2">
                        {template.description || '暂无描述'}
                    </p>
                </div>
            </div>
        </div>
    )
}

// ─── Agent 预览弹出模态框 ──────────────────────────────

function AgentPreviewModal({agent, onClose, onEdit, readOnly}: {
    agent: AgentTemplate
    onClose: () => void
    onEdit?: () => void
    readOnly?: boolean
}) {
    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            onClick={() => onClose()}
        >
            <div className="absolute inset-0 bg-black/50"/>
            <div
                onClick={e => e.stopPropagation()}
                className="relative w-[580px] max-h-[85vh] bg-[var(--surface)] rounded-xl shadow-elevated border border-[var(--border)] flex flex-col overflow-hidden"
            >
                {/* Header */}
                <div className="shrink-0 bg-[var(--surface-elevated)] px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
                            <Layers className="w-4 h-4"/>
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                                {agent.name}
                            </h3>
                            {displayTags(agent.tags).length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                    {displayTags(agent.tags).map(tag => (
                                        <span key={tag} className={clsx(TAG_BASE_CLASS, TAG_STYLES.builtin)}>{tag}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <button
                        onClick={() => onClose()}
                        className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded transition-colors"
                    >
                        <X className="w-4 h-4"/>
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-5">
                    {agent.description && (
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">描述</label>
                            <p className="text-sm text-[var(--text-primary)] leading-relaxed">{agent.description}</p>
                        </div>
                    )}
                    {agent.whenToUse && (
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">何时使用</label>
                            <p className="text-sm text-[var(--text-primary)] leading-relaxed">{agent.whenToUse}</p>
                        </div>
                    )}
                    {agent.model && (
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">模型</label>
                            <p className="text-sm font-mono text-[var(--text-primary)]">{agent.model}</p>
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">系统提示词 (System Prompt)</label>
                        <div className="rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] p-3 max-h-64 overflow-y-auto custom-scrollbar">
                            <pre className="text-xs font-mono text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words">{agent.systemPrompt}</pre>
                        </div>
                    </div>
                    {agent.skillIds && agent.skillIds.length > 0 && (
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">预设技能 ({agent.skillIds.length})</label>
                            <div className="flex flex-wrap gap-1.5">
                                {agent.skillIds.map(sid => (
                                    <span key={sid} className="inline-flex items-center rounded px-2 py-1 text-[10px] font-medium bg-[var(--surface-muted)] text-[var(--text-secondary)] border border-[var(--border)]">{sid}</span>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">状态</label>
                        <span className={clsx(
                            "inline-flex items-center rounded px-2 py-1 text-[11px] font-semibold",
                            agent.enabled
                                ? "bg-[var(--tag-dev-bg)] text-[var(--tag-dev-text)] ring-1 ring-inset ring-[var(--tag-dev-border)]"
                                : "bg-[var(--surface-muted)] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)]"
                        )}>
                            {agent.enabled ? '已启用' : '已禁用'}
                        </span>
                    </div>
                </div>

                {/* Footer */}
                <div className="shrink-0 bg-[var(--surface-elevated)] px-5 py-3 border-t border-[var(--border)] flex items-center justify-end gap-3">
                    {onEdit && (
                        <button
                            onClick={() => onEdit()}
                            disabled={readOnly}
                            className={clsx(
                                "px-4 py-2 rounded-lg text-xs font-bold shadow-sm hover:shadow-md transition-all",
                                readOnly
                                    ? "bg-[var(--surface-muted)] text-[var(--text-muted)]/50 cursor-not-allowed"
                                    : "bg-[var(--brand-primary)] text-white hover:shadow-md"
                            )}
                        >
                            编辑
                        </button>
                    )}
                    <button
                        onClick={() => onClose()}
                        className="px-4 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)] transition-all"
                    >
                        关闭
                    </button>
                </div>
            </div>
        </div>
    )
}

export default function AgentsDialog() {
    const {
        templates,
        addTemplate,
        updateTemplate,
        removeTemplate,
        toggleTemplate,
        toggleTemplateBatch,
        syncFromDisk,
        init,
        loading,
        updateTemplateDescription,
        loadErrors,
    } = useAgentTemplateStore()
    const [showModal, setShowModal] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [previewAgent, setPreviewAgent] = useState<AgentTemplate | null>(null)
    const [syncStatus, setSyncStatus] = useState<string | null>(null)
    const [activeTab, setActiveTab] = useState<'local' | 'plugin'>('local')
    const [searchQuery, setSearchQuery] = useState('')
    const [form, setForm] = useState<Partial<AgentTemplate>>({
        name: '',
        description: '',
        whenToUse: '',
        systemPrompt: '',
        enabled: true,
    })

    useEffect(() => {
        init()
    }, [init])

    const localTemplates = templates.filter(t => !t.tags?.some(tag => tag.startsWith('plugin:')))
    const pluginTemplates = templates.filter(t => t.tags?.some(tag => tag.startsWith('plugin:')))
    const filteredByTab = activeTab === 'local' ? localTemplates : pluginTemplates
    const displayTemplates = fuzzyFilter(filteredByTab, searchQuery, ['name'])
    const isReadOnly = activeTab === 'plugin'

    const handleDeleteWithConfirm = async (id: string, name: string) => {
        await confirm({
            title: '确认删除',
            message: `确定要删除 Agent「${name}」吗？此操作无法撤销。`,
            confirmText: '删除',
            confirmVariant: 'danger',
            onConfirm: () => removeTemplate(id),
        })
    }

    const resetForm = () => setForm({name: '', description: '', whenToUse: '', systemPrompt: '', enabled: true})

    const handleSave = (data: Partial<AgentTemplate>) => {
        if (!data.name || !data.systemPrompt) return

        if (editingId) {
            updateTemplate(editingId, data)
        } else {
            addTemplate(data as any)
        }

        setShowModal(false)
        setEditingId(null)
        resetForm()
    }

    const startEdit = (t: AgentTemplate) => {
        // 手动构造 form 避免旧 Agent 残留字段（如已移除的 userDescription/tags）污染
        setForm({
            name: t.name,
            description: t.description,
            whenToUse: t.whenToUse || '',
            systemPrompt: t.systemPrompt,
            enabled: t.enabled,
        })
        setEditingId(t.id)
        setShowModal(true)
    }

    const handleSync = async () => {
        const res = await syncFromDisk()
        if (res.success) {
            setSyncStatus(`已同步 ${res.count} 个 Agent`)
            setTimeout(() => setSyncStatus(null), 3000)
        } else {
            setSyncStatus(`同步失败: ${res.error}`)
            setTimeout(() => setSyncStatus(null), 3000)
        }
    }

    return (
        <div className="h-full flex flex-col bg-[var(--surface)] overflow-hidden">
            {/* 头部区域 */}
            <div className="relative px-6 py-5 border-b border-[var(--border-muted)] bg-[var(--surface-elevated)]/40 overflow-hidden">
                {/* 背景装饰光晕 */}
                <div className="absolute top-0 right-0 -mr-20 -mt-20 h-40 w-40 rounded-full bg-[var(--brand-primary)]/5 blur-[60px] pointer-events-none"/>

                <div className="relative flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
                            Agent 管理
                        </h2>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            预设或自定义专用 Agent 工作流
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleSync}
                            disabled={loading}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")}/>
                            {syncStatus || '同步'}
                        </button>
                        <button
                            onClick={() => {
                                resetForm()
                                setEditingId(null)
                                setShowModal(true)
                            }}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20 transition-colors"
                        >
                            <Plus className="h-3.5 w-3.5"/>
                            创建
                        </button>
                    </div>
                </div>
            </div>

            {/* 工具栏区域 */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-4 bg-[var(--surface-muted)]/20 border-b border-[var(--border-muted)]">
                {/* Tab 切换 */}
                <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] p-1 shadow-inner">
                    <button
                        onClick={() => setActiveTab('local')}
                        className={clsx(
                            "rounded-md px-4 py-1.5 text-xs font-medium transition-all duration-200 whitespace-nowrap",
                            activeTab === 'local'
                                ? "bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] shadow-sm"
                                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        )}
                    >
                        本地
                    </button>
                    <button
                        onClick={() => setActiveTab('plugin')}
                        className={clsx(
                            "rounded-md px-4 py-1.5 text-xs font-medium transition-all duration-200 whitespace-nowrap",
                            activeTab === 'plugin'
                                ? "bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] shadow-sm"
                                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        )}
                    >
                        插件 Agents
                    </button>
                </div>

                {/* 搜索框 */}
                <div className="relative w-full sm:w-64 group">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                        <Search className={clsx(
                            "h-4 w-4 transition-colors",
                            searchQuery ? "text-[var(--brand-primary)]" : "text-[var(--text-muted)]"
                        )}/>
                    </div>
                    <input
                        type="text"
                        placeholder="按名称搜索..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="block w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/50 py-2 pl-9 pr-8 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] shadow-sm focus:border-[var(--brand-primary)]/50 focus:bg-[var(--surface-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/30 transition-all"
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute inset-y-0 right-0 flex items-center pr-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        >
                            <X className="h-4 w-4"/>
                        </button>
                    )}
                </div>
            </div>

            {/* 加载错误警告 */}
            <div className="mx-6 mt-3">
                <LoadErrorBanner
                    errors={loadErrors.map(e => ({name: e.agentName || e.filePath.split(/[/\\]/).pop() || '', error: e.error}))}
                    title={`${loadErrors.length} 个 Agent 加载失败`}
                    tip="请检查对应文件的 YAML frontmatter 格式，修改后点击同步按钮重试"
                />
            </div>

            {/* 主内容区域 */}
            <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                {displayTemplates.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-center border border-dashed border-[var(--border)] rounded-xl bg-[var(--surface-muted)]/20">
                        <div className="w-16 h-16 rounded-xl bg-[var(--surface-muted)] flex items-center justify-center mb-4">
                            <Layers className="w-8 h-8 text-[var(--text-muted)] opacity-30"/>
                        </div>
                        <h3 className="text-sm font-medium text-[var(--text-primary)]">
                            {activeTab === 'local' ? '暂无自定义 Agent' : '暂无插件 Agent'}
                        </h3>
                        <p className="text-xs text-[var(--text-muted)] mt-1.5">
                            {activeTab === 'local' ? '点击右上方按钮开始创建' : '插件 Agent 可通过插件系统安装'}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        {activeTab === 'plugin' ? (
                            <PluginAgentGroupList
                                templates={displayTemplates}
                                toggleTemplate={toggleTemplate}
                                toggleTemplateBatch={toggleTemplateBatch}
                                handleDeleteWithConfirm={handleDeleteWithConfirm}
                                startEdit={startEdit}
                                onPreview={(t) => setPreviewAgent(t)}
                                isReadOnly={isReadOnly}
                            />
                        ) : (
                            displayTemplates.map(t => (
                                <AgentCard
                                    key={t.id}
                                    template={t}
                                    onEdit={() => startEdit(t)}
                                    onDelete={() => handleDeleteWithConfirm(t.id, t.name)}
                                    onToggle={() => toggleTemplate(t.id)}
                                    onPreview={() => setPreviewAgent(t)}
                                    readOnly={isReadOnly}
                                />
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* Agent 创建/编辑弹窗 */}
            {showModal && (
                <AgentEditModal
                    form={form}
                    editingId={editingId}
                    onSave={handleSave}
                    onCancel={() => {
                        setShowModal(false)
                        setEditingId(null)
                        resetForm()
                    }}
                />
            )}

            {/* Agent 预览弹窗 */}
            {previewAgent && (
                <AgentPreviewModal
                    agent={previewAgent}
                    onClose={() => setPreviewAgent(null)}
                    onEdit={() => {
                        const t = previewAgent
                        setPreviewAgent(null)
                        startEdit(t)
                    }}
                    readOnly={isReadOnly}
                />
            )}
        </div>
    )
}

// ─── 插件 Agent 分组组件 ─────────────────────────────

function PluginAgentGroupList({templates, toggleTemplate, toggleTemplateBatch, handleDeleteWithConfirm, startEdit, onPreview, isReadOnly}: {
    templates: AgentTemplate[]
    toggleTemplate: (id: string) => void
    toggleTemplateBatch: (templateIds: string[], enabled: boolean) => Promise<void>
    handleDeleteWithConfirm: (id: string, name: string) => void
    startEdit: (t: AgentTemplate) => void
    onPreview?: (t: AgentTemplate) => void
    isReadOnly: boolean
}) {
    // 从 plugin:xxx 标签提取插件名，按插件分组（暂不过滤禁用插件，等 Hub 完全接入后统一处理）
    const groups = useMemo(() => {
        const map = new Map<string, AgentTemplate[]>()
        for (const t of templates) {
            const pluginTag = t.tags?.find(tag => tag.startsWith('plugin:'))
            const pluginName = pluginTag ? pluginTag.replace('plugin:', '') : '未知插件'
            const list = map.get(pluginName) || []
            list.push(t)
            map.set(pluginName, list)
        }
        return [...map].map(([name, agents]) => ({name, agents}))
    }, [templates])

    if (groups.length === 0) return null

    return (
        <div className="space-y-3">
            <AnimatePresence initial={false}>
                {groups.map(group => (
                    <PluginAgentGroup
                        key={group.name}
                        pluginName={group.name}
                        agents={group.agents}
                        toggleTemplate={toggleTemplate}
                        toggleTemplateBatch={toggleTemplateBatch}
                        handleDeleteWithConfirm={handleDeleteWithConfirm}
                        startEdit={startEdit}
                        onPreview={onPreview}
                        isReadOnly={isReadOnly}
                    />
                ))}
            </AnimatePresence>
        </div>
    )
}

function PluginAgentGroup({pluginName, agents, toggleTemplate, toggleTemplateBatch, handleDeleteWithConfirm, startEdit, onPreview, isReadOnly}: {
    pluginName: string
    agents: AgentTemplate[]
    toggleTemplate: (id: string) => void
    toggleTemplateBatch: (templateIds: string[], enabled: boolean) => Promise<void>
    handleDeleteWithConfirm: (id: string, name: string) => void
    startEdit: (t: AgentTemplate) => void
    onPreview?: (t: AgentTemplate) => void
    isReadOnly: boolean
}) {
    const [collapsed, setCollapsed] = useState(true)

    return (
        <motion.div
            layout
            initial={{opacity: 0, y: -8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            transition={{duration: 0.15}}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
        >
            {/* 插件标题栏 */}
            <div
                className="flex items-center justify-between px-3 py-2 bg-[var(--surface-muted)]/50 cursor-pointer"
                onClick={() => setCollapsed(c => !c)}
            >
                <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span className="text-xs font-semibold text-[var(--text-primary)]">{pluginName}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">{agents.length} 个 Agent</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                        onClick={async e => {
                            e.stopPropagation()
                            const allEnabled = agents.every(a => a.enabled)
                            const targetEnabled = !allEnabled
                            const ids = agents.filter(a => a.enabled !== targetEnabled).map(a => a.id)
                            if (ids.length > 0) {
                                await toggleTemplateBatch(ids, targetEnabled)
                            }
                        }}
                        className="text-[10px] font-medium text-[var(--brand-primary)] hover:text-[var(--brand-primary)]/80 transition-colors flex-shrink-0"
                    >
                        {agents.every(a => a.enabled) ? '全部禁用' : '全部启用'}
                    </button>
                    <svg
                        className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 9l-7 7-7-7"/>
                    </svg>
                </div>
            </div>

            {/* 插件下的 Agent 列表 */}
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.div
                        initial={{opacity: 0, height: 0}}
                        animate={{opacity: 1, height: 'auto'}}
                        exit={{opacity: 0, height: 0}}
                        transition={{duration: 0.2, ease: 'easeInOut'}}
                        style={{overflow: 'hidden'}}
                    >
                        <div className="p-2 space-y-2 border-t border-[var(--border-muted)]">
                            {agents.map(agent => (
                                <AgentCard
                                    key={agent.id}
                                    template={agent}
                                    onEdit={() => startEdit(agent)}
                                    onDelete={() => handleDeleteWithConfirm(agent.id, agent.name)}
                                    onToggle={() => toggleTemplate(agent.id)}
                                    onPreview={() => onPreview?.(agent)}
                                    readOnly={isReadOnly}
                                />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}

// ─── Agent 编辑/创建弹出模态框 ──────────────────────────────

function AgentEditModal({form: initialForm, editingId, onSave, onCancel}: {
    form: Partial<AgentTemplate>
    editingId: string | null
    onSave: (data: Partial<AgentTemplate>) => void
    onCancel: () => void
}) {
    const [form, setForm] = useState<Partial<AgentTemplate>>(initialForm)

    const handleSave = () => {
        if (!form.name || !form.systemPrompt) return
        onSave(form)
    }

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            onClick={() => onCancel()}
        >
            <div className="absolute inset-0 bg-black/50"/>
            <div
                onClick={e => e.stopPropagation()}
                className="relative w-[580px] max-h-[85vh] bg-[var(--surface)] rounded-xl shadow-elevated border border-[var(--border)] flex flex-col overflow-hidden"
            >
                {/* Header */}
                <div className="shrink-0 bg-[var(--surface-elevated)] px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        {editingId ? '编辑 Agent' : '创建 Agent'}
                    </h3>
                    <button
                        onClick={() => onCancel()}
                        className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded transition-colors"
                    >
                        <X className="w-4 h-4"/>
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-4">
                    {/* Agent 名称 */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                            Agent 名称
                        </label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={e => setForm({...form, name: e.target.value})}
                            placeholder="如：安全审计专家"
                            className="w-full px-3 py-2.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/30 transition-all"
                        />
                    </div>

                    {/* 简短描述 */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                            简短描述
                        </label>
                        <input
                            type="text"
                            value={form.description}
                            onChange={e => setForm({...form, description: e.target.value})}
                            placeholder="该 Agent 主要负责什么任务？"
                            className="w-full px-3 py-2.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/30 transition-all"
                        />
                    </div>

                    {/* 何时使用 */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                            何时使用
                            <span className="ml-1 text-[9px] font-normal normal-case text-[var(--text-muted)]">（帮助 LLM 识别何时触发此 Agent）</span>
                        </label>
                        <input
                            type="text"
                            value={form.whenToUse || ''}
                            onChange={e => setForm({...form, whenToUse: e.target.value})}
                            placeholder="如：代码审查、安全审计、性能优化时使用"
                            className="w-full px-3 py-2.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/30 transition-all"
                        />
                    </div>

                    {/* 系统提示词 */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                            系统提示词 (System Prompt)
                        </label>
                        <textarea
                            value={form.systemPrompt}
                            onChange={e => setForm({...form, systemPrompt: e.target.value})}
                            rows={8}
                            placeholder="详细定义该 Agent 的角色、知识边界、行动规则和输出格式要求..."
                            className="w-full px-3 py-2.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/30 transition-all resize-none"
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="shrink-0 bg-[var(--surface-elevated)] px-5 py-3 border-t border-[var(--border)] flex items-center justify-end gap-3">
                    <button
                        onClick={() => onCancel()}
                        className="px-4 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)] transition-all"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!form.name || !form.systemPrompt}
                        className="px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-bold shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        {editingId ? '保存修改' : '立即创建'}
                    </button>
                </div>
            </div>
        </div>
    )
}
