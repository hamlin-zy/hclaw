/**
 * CommandsDialog - 命令管理对话框
 *
 * 提供本地命令（内置/用户）的查看、搜索、新建、编辑、删除、预览、重置预设功能，
 * 以及插件命令的查看、预览、启用/禁用管理。
 *
 * 数据源：CapabilityHub（统一能力中心）作为主要入口，配合插件 override 接口。
 */

import React, {useCallback, useEffect, useMemo, useState} from 'react'
import {clsx} from 'clsx'
import {Switch} from '../common/Switch'
import {CopyButton} from '../common/CopyButton'
import {AnimatePresence, motion} from 'framer-motion'
import {useUserCommandStore} from '../../stores/userCommandStore'
import {CommandEditModal} from './CommandEditModal'
import {confirm} from '../ConfirmDialog'
import {fuzzyFilter} from '../../lib/search'
import {Folder, Search, Trash2, ChevronDown, Plus, X} from 'lucide-react'
import type {CapabilityEntry} from '../../capabilityTypes'

// ─── 类型定义 ─────────────────────────────────────────

interface PluginGroupData {
    pluginName: string
    commands: PluginCapability[]
}

interface PluginCapability {
    id: string
    name: string
    description: string
    content?: string
    hasArgs: boolean
    args?: Array<{ name: string; description?: string; required?: boolean; default?: string }>
}

type TabType = 'local' | 'plugin'

// ─── 主组件 ─────────────────────────────────────────

export default function CommandsDialog() {
    const {commands: userCommands, loadCommands, deleteCommand, toggleCommand} = useUserCommandStore()

    const [loading, setLoading] = useState(true)
    const [capabilities, setCapabilities] = useState<CapabilityEntry[]>([])
    const [pluginCommandOverrides, setPluginCommandOverrides] = useState<
        Record<string, { enabled: boolean; edited?: boolean }>
    >({})
    const [searchQuery, setSearchQuery] = useState('')
    const [activeTab, setActiveTab] = useState<TabType>('local')

    // 编辑弹窗状态
    const [editModalOpen, setEditModalOpen] = useState(false)
    const [editingCommand, setEditingCommand] = useState<typeof userCommands[0] | null>(null)

    // 预览弹窗状态
    const [previewCommand, setPreviewCommand] = useState<{
        name: string
        description?: string
        content?: string
        args?: any[]
        enabled: boolean
        source: 'user' | 'plugin' | 'builtin'
    } | null>(null)

    // ─── 数据加载 ─────────────────────────────────────

    useEffect(() => {
        loadData()
    }, [])

    const loadData = async () => {
        setLoading(true)
        try {
            // 1. 加载用户命令（用于本地命令的 CRUD）
            await loadCommands()

            // 2. 从 CapabilityHub 获取所有命令
            const api = window.electronAPI
            const caps = await api?.capability?.getByType?.('command')
            if (Array.isArray(caps)) {
                setCapabilities(caps as CapabilityEntry[])
            }

            // 3. 加载插件命令覆盖状态
            if (api?.pluginCommand?.getOverrides) {
                const overridesResult = await api.pluginCommand.getOverrides()
                if (Array.isArray(overridesResult)) {
                    const overrideMap: Record<string, { enabled: boolean; edited?: boolean }> = {}
                    for (const ov of overridesResult) {
                        if (ov.pluginCommandId) {
                            overrideMap[ov.pluginCommandId] = {
                                enabled: ov.enabled,
                                edited: ov.content ? true : undefined,
                            }
                        }
                    }
                    setPluginCommandOverrides(overrideMap)
                }
            }
        } catch {
            // silent
        } finally {
            setLoading(false)
        }
    }

    // ─── 过滤逻辑 ─────────────────────────────────────

    /** 本地命令：source=builtin | source=user */
    const localCapabilities = useMemo(() => {
        return capabilities.filter(c => c.source === 'builtin' || c.source === 'user')
    }, [capabilities])

    /** 插件命令：source=plugin，只显示已启用插件的分组 */
    const pluginCapabilities = useMemo(() => {
        return capabilities.filter(c => c.source === 'plugin' && c.pluginEnabled === true)
    }, [capabilities])

    /** 搜索过滤后的本地命令 */
    const filteredLocal = useMemo(() => {
        if (!searchQuery.trim()) return localCapabilities
        return fuzzyFilter(localCapabilities, searchQuery, ['name', 'description'])
    }, [localCapabilities, searchQuery])

    /** 按插件名分组（只包含已启用插件的命令） */
    const pluginGroups = useMemo(() => {
        const map = new Map<string, PluginCapability[]>()
        for (const c of pluginCapabilities) {
            const name = c.pluginName || 'unknown'
            if (!map.has(name)) map.set(name, [])
            const list = map.get(name)!
            list.push({
                id: c.id,
                name: c.name,
                description: c.description,
                content: c.content,
                hasArgs: c.hasArgs ?? false,
            })
        }
        let groups = Array.from(map.entries()).map(([pluginName, commands]) => ({
            pluginName,
            commands,
        }))
        // 搜索过滤：组内匹配的命令保留，不匹配的过滤掉
        if (searchQuery.trim()) {
            groups = groups
                .map(g => ({
                    ...g,
                    commands: fuzzyFilter(g.commands, searchQuery, ['name', 'description']),
                }))
                .filter(g => g.commands.length > 0)
        }
        groups.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
        return groups
    }, [pluginCapabilities, searchQuery])

    // ─── 本地命令操作 ─────────────────────────────────

    const handleNew = useCallback(() => {
        setEditingCommand(null)
        setEditModalOpen(true)
    }, [])

    const handleEdit = useCallback((cmd: typeof userCommands[0]) => {
        setEditingCommand(cmd)
        setEditModalOpen(true)
    }, [])

    const handleToggle = useCallback(async (id: string, enabled: boolean) => {
        await toggleCommand(id, enabled)
    }, [toggleCommand])

    const handleDelete = useCallback(async (cmd: typeof userCommands[0]) => {
        const confirmed = await confirm({
            title: '删除命令',
            message: `确定要删除命令 "${cmd.name}" 吗？此操作不可撤销。`,
            confirmText: '删除',
            confirmVariant: 'danger',
        })
        if (!confirmed) return
        const result = await deleteCommand(cmd.id)
        if (!result.success) {
            console.error('Failed to delete command:', result.error)
        }
    }, [deleteCommand])

    const handleResetPresets = useCallback(async () => {
        const confirmed = await confirm({
            title: '重置预设命令',
            message: '将重新生成预设命令文件（commit-msg.md）。\n此操作会覆盖现有文件，不影响自定义命令。\n\n确定继续吗？',
            confirmText: '重置',
            confirmVariant: 'warning',
        })
        if (!confirmed) return
        const api = window.electronAPI
        const result = await api?.command?.resetPresets?.()
        if (result?.success) {
            loadData()
        } else {
            console.error('Failed to reset presets:', result?.error)
        }
    }, [loadData])

    const handleEditModalSave = useCallback(() => {
        setEditModalOpen(false)
        setEditingCommand(null)
        loadData()
    }, [])

    // ─── 插件命令操作 ─────────────────────────────────

    /** 设置插件命令的 override 状态：启用=删除 override，禁用=创建 override */
    const setPluginOverride = useCallback(async (cmd: PluginCapability, enabled: boolean) => {
        if (enabled) {
            await window.electronAPI?.pluginCommand?.deleteOverride(cmd.id)
        } else {
            await window.electronAPI?.pluginCommand?.upsertOverride({
                pluginCommandId: cmd.id,
                name: cmd.name,
                description: cmd.description,
                content: cmd.content || '',
                enabled: false,
            })
        }
    }, [])

    const handlePluginToggle = useCallback(async (cmd: PluginCapability, enabled: boolean) => {
        try {
            await setPluginOverride(cmd, enabled)
            loadData()
        } catch {
            // silent
        }
    }, [setPluginOverride, loadData])

    const handlePluginBatchToggle = useCallback(async (group: PluginGroupData, targetEnabled: boolean) => {
        for (const cmd of group.commands) {
            const overrideState = pluginCommandOverrides[cmd.id]
            const isEnabled = overrideState ? overrideState.enabled !== false : true
            if (isEnabled !== targetEnabled) {
                try {
                    await setPluginOverride(cmd, targetEnabled)
                } catch {
                    // silent
                }
            }
        }
        loadData()
    }, [pluginCommandOverrides, setPluginOverride, loadData])

    // ─── 预览 ────────────────────────────────────────

    const handlePreview = useCallback((
        name: string,
        description: string | undefined,
        content: string | undefined,
        args: any[] | undefined,
        enabled: boolean,
        source: 'user' | 'plugin' | 'builtin',
    ) => {
        setPreviewCommand({name, description, content, args, enabled, source})
    }, [])

    // ─── 统计 ────────────────────────────────────────

    const localCount = localCapabilities.length
    const pluginCount = pluginCapabilities.length

    // ─── 渲染 ─────────────────────────────────────────

    return (
        <div className="flex flex-col h-full min-h-[400px]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">命令管理</h3>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--text-muted)]">
                        {activeTab === 'local' ? `${localCount} 个本地命令` : `${pluginCount} 个插件命令`}
                    </span>
                    {activeTab === 'local' && (
                        <>
                            <button
                                onClick={handleNew}
                                className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[var(--success)]/10 text-[var(--success)] hover:bg-[var(--success)]/20 transition-colors"
                                title="创建新命令"
                            >
                                <Plus className="w-3.5 h-3.5"/>
                                <span>创建</span>
                            </button>
                            <button
                                onClick={handleResetPresets}
                                className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10 rounded-md transition-colors"
                                title="重新生成预设命令文件（commit-msg）"
                            >
                                重置预设
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Tab 切换 */}
            <div className="flex gap-1 px-4 py-2 border-b border-[var(--border-muted)]">
                {(['local', 'plugin'] as TabType[]).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                            activeTab === tab
                                ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] font-medium'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                        }`}
                    >
                        {tab === 'local' ? '本地' : '插件'}
                    </button>
                ))}
            </div>

            {/* 搜索条 */}
            <div className="px-4 py-2 border-b border-[var(--border-muted)]">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"/>
                    <input
                        type="text"
                        placeholder="搜索命令..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface)] border border-[var(--border)] rounded-md
                                 text-[var(--text-primary)] placeholder-[var(--text-muted)]
                                 focus:outline-none focus:border-[var(--brand-primary)]"
                    />
                </div>
            </div>

            {/* 编辑弹窗 */}
            {editModalOpen && (
                <CommandEditModal
                    command={editingCommand}
                    onSave={handleEditModalSave}
                    onCancel={() => {
                        setEditModalOpen(false)
                        setEditingCommand(null)
                    }}
                />
            )}

            {/* 预览弹窗 */}
            {previewCommand && (
                <CommandPreviewModal
                    command={previewCommand}
                    onClose={() => setPreviewCommand(null)}
                />
            )}

            {/* 命令列表 */}
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                        <div className="inline-block w-5 h-5 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                        <p className="mt-3 text-sm text-[var(--text-muted)]">加载中...</p>
                    </div>
                ) : activeTab === 'local' ? (
                    <LocalCommandList
                        capabilities={filteredLocal}
                        userCommands={userCommands}
                        searchQuery={searchQuery}
                        onEdit={handleEdit}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                        onPreview={handlePreview}
                    />
                ) : (
                    <PluginGroupList
                        groups={pluginGroups}
                        pluginCommandOverrides={pluginCommandOverrides}
                        onToggle={handlePluginToggle}
                        onBatchToggle={handlePluginBatchToggle}
                        onPreview={handlePreview}
                    />
                )}
            </div>
        </div>
    )
}

// ─── 本地命令列表 ─────────────────────────────────────

function LocalCommandList({
                              capabilities,
                              userCommands,
                              searchQuery,
                              onEdit,
                              onToggle,
                              onDelete,
                              onPreview,
                          }: {
    capabilities: CapabilityEntry[]
    userCommands: any[]
    searchQuery: string
    onEdit: (cmd: any) => void
    onToggle: (id: string, enabled: boolean) => void
    onDelete: (cmd: any) => void
    onPreview: (name: string, desc: string | undefined, content: string | undefined, args: any[] | undefined, enabled: boolean, source: 'user' | 'plugin' | 'builtin') => void
}) {
    if (capabilities.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <X className="w-10 h-10 text-[var(--text-muted)]/30 mb-3"/>
                <p className="text-sm text-[var(--text-muted)]">
                    {searchQuery ? '未找到匹配的命令' : '暂无本地命令，点击上方按钮新建'}
                </p>
            </div>
        )
    }

    return (
        <div className="p-2 space-y-1.5">
            <AnimatePresence initial={false}>
                {capabilities.map(cap => {
                    // 从 userCommands 查找详细信息（用于编辑/删除）
                    const userCmd = userCommands.find(c => `cmd:${c.id}` === cap.id || c.name === cap.name)
                    return (
                        <LocalCommandCard
                            key={cap.id}
                            capability={cap}
                            userCommand={userCmd}
                            onEdit={userCmd ? () => onEdit(userCmd) : undefined}
                            onToggle={() => onToggle(userCmd?.id || cap.id, !cap.enabled)}
                            onDelete={userCmd ? () => onDelete(userCmd) : undefined}
                            onPreview={() => onPreview(
                                cap.name, cap.description, cap.content, undefined, cap.enabled, cap.source as any
                            )}
                        />
                    )
                })}
            </AnimatePresence>
        </div>
    )
}

// ─── 本地命令卡片 ─────────────────────────────────────

function LocalCommandCard({
                              capability,
                              userCommand,
                              onEdit,
                              onToggle,
                              onDelete,
                              onPreview,
                          }: {
    capability: CapabilityEntry
    userCommand?: any
    onEdit?: () => void
    onToggle?: () => void
    onDelete?: () => void
    onPreview: () => void
}) {
    const {enabled, name, description, source} = capability
    const isUser = source === 'user'

    return (
        <motion.div
            layout
            initial={{opacity: 0, y: -8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            transition={{duration: 0.15}}
        >
            <div
                onClick={onPreview}
                className={`rounded-xl border transition-all cursor-pointer overflow-hidden ${
                    enabled
                        ? 'bg-[var(--surface)] border-[var(--border)] hover:border-[var(--border-muted)]'
                        : 'bg-[var(--surface)] border-[var(--border)] opacity-60'
                }`}
            >
                <div className="p-3">
                    {/* Title Row */}
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1 min-w-0">
                            <span className={`text-sm font-semibold truncate ${
                                enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                            }`}>
                                {name}
                            </span>
                            <CopyButton name={name}/>
                            <SourceBadge source={source}/>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
                            {isUser && (
                                <>
                                    {userCommand?.filePath && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                window.electronAPI?.showItemInFolder?.(userCommand.filePath)
                                            }}
                                            className="p-1 text-gray-300 hover:text-[var(--brand-primary)] transition-colors"
                                            title="打开所在目录"
                                        >
                                            <Folder className="w-4 h-4"/>
                                        </button>
                                    )}
                                    {onEdit && (
                                        <button
                                            onClick={e => { e.stopPropagation(); onEdit?.() }}
                                            className="p-1 text-gray-300 hover:text-[var(--brand-primary)] transition-colors"
                                            title="编辑"
                                        >
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                                            </svg>
                                        </button>
                                    )}
                                    {onDelete && (
                                        <button
                                            onClick={e => { e.stopPropagation(); onDelete?.() }}
                                            className="p-1 text-gray-300 hover:text-[var(--error)] transition-colors"
                                            title="删除"
                                        >
                                            <Trash2 className="w-4 h-4"/>
                                        </button>
                                    )}
                                </>
                            )}
                            {onToggle && (
                                <Switch checked={enabled} onChange={onToggle}/>
                            )}
                        </div>
                    </div>
                    {/* Description */}
                    {description && (
                        <p className="text-sm text-[var(--text-muted)] mt-1.5 line-clamp-2">{description}</p>
                    )}
                </div>
            </div>
        </motion.div>
    )
}

// ─── 插件命令分组列表 ─────────────────────────────────

function PluginGroupList({
                             groups,
                             pluginCommandOverrides,
                             onToggle,
                             onBatchToggle,
                             onPreview,
                         }: {
    groups: PluginGroupData[]
    pluginCommandOverrides: Record<string, { enabled: boolean; edited?: boolean }>
    onToggle: (cmd: PluginCapability, enabled: boolean) => void
    onBatchToggle: (group: PluginGroupData, targetEnabled: boolean) => void
    onPreview: (name: string, desc: string | undefined, content: string | undefined, args: any[] | undefined, enabled: boolean, source: 'user' | 'plugin' | 'builtin') => void
}) {
    if (groups.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <X className="w-10 h-10 text-[var(--text-muted)]/30 mb-3"/>
                <p className="text-sm text-[var(--text-muted)]">暂无插件命令</p>
            </div>
        )
    }

    return (
        <div className="p-2 space-y-3">
            <AnimatePresence initial={false}>
                {groups.map(group => (
                    <PluginGroupCard
                        key={group.pluginName}
                        group={group}
                        pluginCommandOverrides={pluginCommandOverrides}
                        onToggle={onToggle}
                        onBatchToggle={onBatchToggle}
                        onPreview={onPreview}
                    />
                ))}
            </AnimatePresence>
        </div>
    )
}

// ─── 插件分组卡片 ─────────────────────────────────────

function PluginGroupCard({
                             group,
                             pluginCommandOverrides,
                             onToggle,
                             onBatchToggle,
                             onPreview,
                         }: {
    group: PluginGroupData
    pluginCommandOverrides: Record<string, { enabled: boolean; edited?: boolean }>
    onToggle: (cmd: PluginCapability, enabled: boolean) => void
    onBatchToggle: (group: PluginGroupData, targetEnabled: boolean) => void
    onPreview: (name: string, desc: string | undefined, content: string | undefined, args: any[] | undefined, enabled: boolean, source: 'user' | 'plugin' | 'builtin') => void
}) {
    const [collapsed, setCollapsed] = useState(true)

    const allEnabled = group.commands.every(cmd => {
        const overrideState = pluginCommandOverrides[cmd.id]
        return overrideState ? overrideState.enabled !== false : true
    })

    return (
        <motion.div
            layout
            initial={{opacity: 0, y: -8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            transition={{duration: 0.15}}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
        >
            {/* Plugin header */}
            <div
                className="flex items-center justify-between px-3 py-2 bg-[var(--surface-muted)]/50 cursor-pointer select-none"
                onClick={() => setCollapsed(c => !c)}
            >
                <div className="flex items-center gap-2">
                    <Folder className="w-4 h-4 text-[var(--brand-primary)]"/>
                    <span className="text-xs font-semibold text-[var(--text-primary)]">{group.pluginName}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">{group.commands.length} 个命令</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                        onClick={async e => {
                            e.stopPropagation()
                            await onBatchToggle(group, !allEnabled)
                        }}
                        className="text-[10px] font-medium text-[var(--brand-primary)] hover:text-[var(--brand-primary)]/80 transition-colors flex-shrink-0"
                    >
                        {allEnabled ? '全部禁用' : '全部启用'}
                    </button>
                    <ChevronDown
                        className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}
                    />
                </div>
            </div>

            {/* Commands list */}
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.div
                        initial={{opacity: 0, height: 0}}
                        animate={{opacity: 1, height: 'auto'}}
                        exit={{opacity: 0, height: 0}}
                        transition={{duration: 0.2, ease: 'easeInOut'}}
                        style={{overflow: 'hidden'}}
                    >
                        <div className="border-t border-[var(--border-muted)]">
                            {group.commands.map(cmd => {
                                const overrideState = pluginCommandOverrides[cmd.id]
                                const isEnabled = overrideState ? overrideState.enabled !== false : true
                                return (
                                    <PluginCommandCard
                                        key={cmd.id}
                                        command={cmd}
                                        isEnabled={isEnabled}
                                        onToggle={(enabled) => onToggle(cmd, enabled)}
                                        onPreview={() => onPreview(
                                            cmd.name, cmd.description, cmd.content, cmd.args, isEnabled, 'plugin'
                                        )}
                                    />
                                )
                            })}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}

// ─── 插件命令卡片 ─────────────────────────────────────

function PluginCommandCard({
                               command,
                               isEnabled,
                               onToggle,
                               onPreview,
                           }: {
    command: PluginCapability
    isEnabled: boolean
    onToggle: (enabled: boolean) => void
    onPreview: () => void
}) {
    return (
        <motion.div
            layout
            initial={{opacity: 0, y: -4}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -4}}
            transition={{duration: 0.12}}
        >
            <div
                onClick={onPreview}
                className={`flex items-center gap-3 px-4 py-2.5 mx-1 rounded-md transition-colors cursor-pointer
                            ${isEnabled ? 'hover:bg-[var(--surface-muted)]' : 'opacity-50'}`}
            >
                {/* Icon */}
                <span className={`flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-xs
                               ${isEnabled
                                   ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                                   : 'bg-[var(--surface)] text-[var(--text-muted)]'
                               }`}>
                    ⚡
                </span>

                {/* Info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                    <span className={`text-sm font-semibold truncate ${
                        isEnabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                    }`}>
                        {command.name}
                    </span>
                        <CopyButton name={command.name}/>
                        <SourceBadge source="plugin"/>
                        {!isEnabled && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--error)]/10 text-[var(--error)]">
                                已禁用
                            </span>
                        )}
                    </div>
                    {command.description && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">{command.description}</div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <Switch checked={isEnabled} onChange={onToggle}/>
                </div>
            </div>
        </motion.div>
    )
}

// ─── 来源徽标组件 ─────────────────────────────────────

function SourceBadge({source}: { source: 'builtin' | 'user' | 'plugin' }) {
    const config: Record<string, { label: string; className: string }> = {
        builtin: {
            label: '内置',
            className: 'bg-[var(--info)]/10 text-[var(--info)]',
        },
        user: {
            label: '用户',
            className: 'bg-[var(--tag-dev-bg)] text-[var(--tag-dev-text)] ring-1 ring-inset ring-[var(--tag-dev-border)]',
        },
        plugin: {
            label: '插件',
            className: 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]',
        },
    }
    const {label, className} = config[source] || {label: source, className: 'bg-[var(--surface)] text-[var(--text-muted)]'}
    return (
        <span className={`flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded ${className}`}>
            {label}
        </span>
    )
}

// ─── 命令预览弹窗 ─────────────────────────────────────

function CommandPreviewModal({command, onClose}: {
    command: { name: string; description?: string; content?: string; args?: any[]; enabled: boolean; source: 'user' | 'plugin' | 'builtin' }
    onClose: () => void
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
                        <span className={`flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-xs font-bold ${
                            command.enabled
                                ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                                : 'bg-[var(--surface)] text-[var(--text-muted)]'
                        }`}>
                            ⚡
                        </span>
                        <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                                {command.name}
                            </h3>
                            <SourceBadge source={command.source}/>
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
                    {command.description && (
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                                描述
                            </label>
                            <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                                {command.description}
                            </p>
                        </div>
                    )}

                    {command.args && command.args.length > 0 && (
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                                参数 ({command.args.length})
                            </label>
                            <div className="space-y-1.5">
                                {command.args.map((arg: any, i: number) => (
                                    <div key={i} className="flex items-center gap-2 text-sm">
                                        <code className="px-1.5 py-0.5 rounded text-xs font-mono bg-[var(--surface-muted)] text-[var(--brand-primary)]">
                                            {arg.name}
                                        </code>
                                        {arg.description && (
                                            <span className="text-xs text-[var(--text-secondary)]">{arg.description}</span>
                                        )}
                                        {arg.required && (
                                            <span className="text-[10px] text-[var(--error)]">必填</span>
                                        )}
                                        {arg.default !== undefined && (
                                            <span className="text-[10px] text-[var(--text-muted)]">
                                                默认: {arg.default}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                            内容 (Content)
                        </label>
                        <div className="rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] p-3 max-h-64 overflow-y-auto custom-scrollbar">
                            <pre className="text-xs font-mono text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words">
                                {command.content || '(空)'}
                            </pre>
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                            状态
                        </label>
                        <span className={clsx(
                            "inline-flex items-center rounded px-2 py-1 text-[11px] font-semibold",
                            command.enabled
                                ? "bg-[var(--tag-dev-bg)] text-[var(--tag-dev-text)] ring-1 ring-inset ring-[var(--tag-dev-border)]"
                                : "bg-[var(--surface-muted)] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)]"
                        )}>
                            {command.enabled ? '已启用' : '已禁用'}
                        </span>
                    </div>
                </div>

                {/* Footer */}
                <div className="shrink-0 bg-[var(--surface-elevated)] px-5 py-3 border-t border-[var(--border)] flex items-center justify-end">
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
