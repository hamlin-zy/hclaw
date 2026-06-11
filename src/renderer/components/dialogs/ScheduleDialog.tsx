/**
 * ScheduleDialog - 定时任务管理主页面
 *
 * 提供定时任务的查看、搜索、新建、编辑、删除、暂停/恢复、立即执行、
 * 执行记录查看等功能，支持按状态筛选。
 */

import React, {useCallback, useEffect, useMemo, useState} from 'react'
import {ScheduleUI, useScheduleStore} from '../../stores/scheduleStore'
import {useConversationStore} from '../../stores/conversationStore'
import {confirm} from '../ConfirmDialog'
import {ScheduleEditModal, ScheduleFormData} from './ScheduleEditModal'
import {Switch} from '../common/Switch'
import {fuzzyFilter} from '../../lib/search'

// ─── 类型定义 ─────────────────────────────────────────

type TabType = 'all' | 'enabled' | 'disabled' | 'failed'

interface ConversationRecord {
    id: string
    status: string
    startedAt: number
    finishedAt?: number | null
    messageCount?: number
    error?: string | null
}

// ─── 状态配置 ─────────────────────────────────────────

const STATUS_CONFIG = {
    running: {color: '#3b82f6', label: '运行中', bg: 'bg-blue-500/10 text-blue-500'},
    normal: {color: '#10b981', label: '运行正常', bg: 'bg-emerald-500/10 text-emerald-500'},
    failed: {color: '#ef4444', label: '失败', bg: 'bg-red-500/10 text-red-500'},
    disabled: {color: '#6b7280', label: '禁用', bg: 'bg-gray-500/10 text-gray-400'},
    idle: {color: '#6b7280', label: '已禁用', bg: 'bg-gray-500/10 text-gray-400'},
} as const

function getScheduleStatus(schedule: ScheduleUI, runningTasks: Set<string>) {
    if (runningTasks.has(schedule.id)) return 'running'
    if (!schedule.enabled) return 'disabled'
    if (schedule.lastRunStatus === 'failed' || schedule.lastRunStatus === 'error') return 'failed'
    return 'normal'
}

function getStatusDot(status: string): string {
    const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
    return config?.color || '#6b7280'
}

function getStatusLabel(status: string): string {
    const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
    return config?.label || status
}

// ─── 工具函数 ─────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

function formatTime(ts: number | null | undefined): string {
    if (!ts) return '-'
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - d.getTime()

    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`

    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatConversationTime(ts: number | null | undefined): string {
    if (!ts) return '-'
    const d = new Date(ts)
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 高亮文本中的搜索关键词 */
function highlightText(text: string, query: string): React.ReactNode {
    if (!query.trim()) return text
    const q = query.trim()
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx === -1) return text
    return (
        <>
            {text.slice(0, idx)}
            <span className="bg-yellow-500/20 text-yellow-300 rounded px-0.5">
                {text.slice(idx, idx + q.length)}
            </span>
            {text.slice(idx + q.length)}
        </>
    )
}

function getLastRunStatusLabel(status: string | null | undefined): string {
    switch (status) {
        case 'success':
        case 'completed':
            return '成功'
        case 'failed':
        case 'error':
            return '失败'
        case 'running':
            return '运行中'
        default:
            return '未执行'
    }
}

function getLastRunStatusColor(status: string | null | undefined): string {
    switch (status) {
        case 'success':
        case 'completed':
            return 'text-emerald-500'
        case 'failed':
        case 'error':
            return 'text-red-500'
        case 'running':
            return 'text-blue-500'
        default:
            return 'text-[var(--text-muted)]'
    }
}

// ─── 主组件 ─────────────────────────────────────────

export default function ScheduleDialog() {
    const {schedules, loading, loadSchedules, create, update, delete: deleteSchedule, stop, runNow} =
        useScheduleStore()

    const [searchQuery, setSearchQuery] = useState('')
    const [activeTab, setActiveTab] = useState<TabType>('all')

    // 编辑弹窗状态
    const [editModalOpen, setEditModalOpen] = useState(false)
    const [editingSchedule, setEditingSchedule] = useState<ScheduleUI | null>(null)

    // 运行中状态跟踪
    const [runningTasks, setRunningTasks] = useState<Set<string>>(new Set())

    // 展开的记录面板
    const [expandedConversations, setExpandedConversations] = useState<Set<string>>(new Set())

    // 加载数据
    useEffect(() => {
        loadSchedules()
    }, [])

    // ─── 过滤逻辑 ─────────────────────────────────────

    const filteredSchedules = useMemo(() => {
        let filtered = [...schedules]

        // 状态筛选
        if (activeTab === 'enabled') {
            filtered = filtered.filter(s => s.enabled)
        } else if (activeTab === 'disabled') {
            filtered = filtered.filter(s => !s.enabled)
        } else if (activeTab === 'failed') {
            filtered = filtered.filter(
                s => s.lastRunStatus === 'failed' || s.lastRunStatus === 'error'
            )
        }

        // 搜索筛选（模糊子序列匹配）
        if (searchQuery.trim()) {
            filtered = fuzzyFilter(filtered, searchQuery, ['name', 'description', 'cronExpression', 'taskTarget', 'taskType'])
        }

        return filtered
    }, [schedules, activeTab, searchQuery])

    // ─── 统计 ─────────────────────────────────────────

    const stats = useMemo(() => {
        const total = schedules.length
        const running = schedules.filter(s => s.enabled && s.lastRunStatus === 'running').length
        const disabled = schedules.filter(s => !s.enabled).length
        const failed = schedules.filter(s => s.lastRunStatus === 'failed' || s.lastRunStatus === 'error').length
        return {total, running, disabled, failed}
    }, [schedules])

    // ─── 操作处理 ─────────────────────────────────────

    const handleNew = useCallback(() => {
        setEditingSchedule(null)
        setEditModalOpen(true)
    }, [])

    const handleEdit = useCallback((schedule: ScheduleUI) => {
        setEditingSchedule(schedule)
        setEditModalOpen(true)
    }, [])

    const handleEditModalSave = useCallback((data: ScheduleFormData) => {
        setEditModalOpen(false)
        setEditingSchedule(null)

        const payload: any = {
            name: data.name,
            description: data.description,
            taskType: data.taskType,
            taskTarget: data.taskTarget,
            taskArgs: data.taskPrompt ? [data.taskPrompt] : [],
            cronExpression: data.cronExpression,
            enabled: data.enabled,
            workspaceId: data.workspaceId || null,
        }

        if (data.id) {
            update(data.id, payload)
        } else {
            create(payload)
        }
    }, [create, update])

    const handleDelete = useCallback(async (schedule: ScheduleUI) => {
        await confirm({
            title: '删除定时任务',
            message: `确定要删除定时任务"${schedule.name}"吗？\n此操作不可撤销。`,
            confirmText: '确认删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                await deleteSchedule(schedule.id)
            },
        })
    }, [deleteSchedule])

    const handleRunNow = useCallback(async (schedule: ScheduleUI) => {
        // 如果任务状态为 running（可能是上次执行卡死残留），先 stop 清理后端状态
        if (schedule.lastRunStatus === 'running') {
            await stop(schedule.id)
            await loadSchedules()
        }

        setRunningTasks(prev => new Set(prev).add(schedule.id))

        try {
            const result: any = await runNow(schedule.id)
            if (result && !result.success) {
                alert(`启动失败: ${result.error || '未知错误'}`)
            }
        } catch (err: any) {
            alert(`启动异常: ${err?.message || String(err)}`)
        } finally {
            setTimeout(() => {
                setRunningTasks(prev => {
                    const next = new Set(prev)
                    next.delete(schedule.id)
                    return next
                })
                loadSchedules()
            }, 2000)
        }
    }, [stop, runNow, loadSchedules])

    const handleToggleConversation = useCallback((scheduleId: string) => {
        setExpandedConversations(prev => {
            const next = new Set(prev)
            if (next.has(scheduleId)) {
                next.delete(scheduleId)
            } else {
                next.add(scheduleId)
            }
            return next
        })
    }, [])

    const handleToggleEnabled = useCallback((schedule: ScheduleUI) => {
        update(schedule.id, {enabled: !schedule.enabled})
    }, [update])

    // ─── 渲染 ─────────────────────────────────────────

    return (
        <div className="flex flex-col h-full min-h-[400px]">
            {/* ── Tab 切换 ── */}
            <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-[var(--border)]">
                {([
                    {key: 'all' as TabType, label: '全部'},
                    {key: 'enabled' as TabType, label: '启用'},
                    {key: 'disabled' as TabType, label: '禁用'},
                    {key: 'failed' as TabType, label: '失败'},
                ]).map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                            activeTab === tab.key
                                ? 'bg-[var(--brand-primary)]/20 text-[var(--brand-primary)] font-medium'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
                <div className="flex-1"/>
                <button
                    onClick={handleNew}
                    className="px-3 py-1.5 text-xs font-medium rounded-md
                             bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]
                             hover:bg-[var(--brand-primary)]/20 transition-colors"
                >
                    新建
                </button>
            </div>

            {/* ── 搜索条 ── */}
            <div className="px-4 py-2 border-b border-[var(--border)]">
                <div className="relative">
                    <svg
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                    </svg>
                    <input
                        type="text"
                        placeholder="搜索定时任务..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md
                                 text-[var(--text-primary)] placeholder-[var(--text-muted)]
                                 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                    />
                </div>
            </div>

            {/* ── 任务列表 ── */}
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="p-8 text-center">
                        <div
                            className="inline-block w-5 h-5 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                        <div className="mt-2 text-xs text-[var(--text-muted)]">加载中...</div>
                    </div>
                ) : (
                    <div className="py-1">
                        {filteredSchedules.length === 0 ? (
                            <div className="p-8 text-center">
                                <div className="text-xs text-[var(--text-muted)]">
                                    {searchQuery ? '未找到匹配的定时任务' : '暂无定时任务，点击上方"新建"创建'}
                                </div>
                            </div>
                        ) : (
                            filteredSchedules.map(schedule => {
                                const status = getScheduleStatus(schedule, runningTasks)
                                const isConversationExpanded = expandedConversations.has(schedule.id)
                                return (
                                    <div key={schedule.id}>
                                        <ScheduleCard
                                            schedule={schedule}
                                            status={status}
                                            searchQuery={searchQuery}
                                            onEdit={() => handleEdit(schedule)}
                                            onDelete={() => handleDelete(schedule)}
                                            onRunNow={() => handleRunNow(schedule)}
                                            onToggleConversation={() => handleToggleConversation(schedule.id)}
                                            onToggleEnabled={() => handleToggleEnabled(schedule)}
                                            isConversationExpanded={isConversationExpanded}
                                        />
                                        {isConversationExpanded && (
                                            <ConversationsPanel
                                                scheduleId={schedule.id}
                                                scheduleName={schedule.name}
                                                taskType={schedule.taskType}
                                            />
                                        )}
                                    </div>
                                )
                            })
                        )}
                    </div>
                )}
            </div>

            {/* ── 底部统计栏 ── */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border)] bg-[var(--surface-muted)]">
                <div className="flex gap-4 text-[10px] text-[var(--text-muted)]">
                    <span>总数: <strong className="text-[var(--text-primary)]">{stats.total}</strong></span>
                    <span className="text-blue-500">运行中: <strong>{stats.running}</strong></span>
                    <span className="text-gray-400">禁用: <strong>{stats.disabled}</strong></span>
                    <span className="text-red-500">失败: <strong>{stats.failed}</strong></span>
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">
                    {filteredSchedules.length !== schedules.length
                        ? `已筛选 ${filteredSchedules.length} / 共 ${schedules.length} 个任务`
                        : `共 ${schedules.length} 个定时任务`
                    }
                </div>
            </div>

            {/* ── 编辑弹窗（穿透模式，可同时操作页面按钮） ── */}
            {editModalOpen && (
                <ScheduleEditModal
                    initial={editingSchedule ? {
                        id: editingSchedule.id,
                        name: editingSchedule.name,
                        description: editingSchedule.description,
                        taskType: editingSchedule.taskType,
                        taskTarget: editingSchedule.taskTarget,
                        taskPrompt: editingSchedule.taskPrompt || '',
                        cronExpression: editingSchedule.cronExpression,
                        enabled: editingSchedule.enabled,
                        workspaceId: editingSchedule.workspaceId,
                    } : undefined}
                    onSave={handleEditModalSave}
                    onClose={() => {
                        setEditModalOpen(false)
                        setEditingSchedule(null)
                    }}
                    penetrable={true}
                />
            )}
        </div>
    )
}

// ─── 任务卡片组件 ─────────────────────────────────────

interface ScheduleCardProps {
    schedule: ScheduleUI
    status: string
    searchQuery: string
    onEdit: () => void
    onDelete: () => void
    onRunNow: () => void
    onToggleConversation: () => void
    onToggleEnabled: () => void
    isConversationExpanded: boolean
}

function ScheduleCard({
                          schedule,
                          status,
                          searchQuery,
                          onEdit,
                          onDelete,
                          onRunNow,
                          onToggleConversation,
                          onToggleEnabled,
                          isConversationExpanded,
                      }: ScheduleCardProps) {
    const statusDotColor = getStatusDot(status)
    const statusLabel = getStatusLabel(status)
    const isRunning = status === 'running'
    const isDisabled = !schedule.enabled

    const TASK_TYPE_LABEL: Record<string, string> = {
        agent: 'Agent',
        skill: 'Skill',
        command: 'Command',
        script: 'Script',
    }

    const taskTypeColors: Record<string, string> = {
        agent: 'bg-purple-500/10 text-purple-400',
        skill: 'bg-cyan-500/10 text-cyan-400',
        command: 'bg-amber-500/10 text-amber-400',
        script: 'bg-rose-500/10 text-rose-400',
    }

    return (
        <div className={`mx-1 rounded-md transition-colors ${
            isDisabled ? 'opacity-60' : 'hover:bg-[var(--surface-muted)]'
        }`}>
            <div className="flex items-start gap-3 px-4 py-2.5">
                {/* 状态指示点 */}
                <div className="flex-shrink-0 pt-1">
                    <div
                        className="w-2.5 h-2.5 rounded-full"
                        style={{backgroundColor: statusDotColor}}
                        title={statusLabel}
                    />
                </div>

                {/* 信息主体 */}
                <div className="flex-1 min-w-0">
                    {/* 第一行：名称 + 状态标签 */}
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                            {highlightText(schedule.name, searchQuery)}
                        </span>
                        <span className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${
                            taskTypeColors[schedule.taskType] || 'bg-gray-500/10 text-gray-400'
                        }`}>
                            {TASK_TYPE_LABEL[schedule.taskType] || schedule.taskType}
                        </span>
                        {isRunning && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0 flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"/>
                                运行中
                            </span>
                        )}
                        {isDisabled && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400 shrink-0">
                                禁用
                            </span>
                        )}
                        {!isDisabled && !isRunning && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0">
                                启用
                            </span>
                        )}
                    </div>

                    {/* 第二行：Cron + 类型 + 目标 */}
                    <div className="flex items-center gap-2 mt-1">
                        <code className="text-[10px] font-mono text-[var(--brand-primary)] bg-[var(--brand-primary)]/5 px-1 py-0.5 rounded whitespace-nowrap">
                            {highlightText(schedule.cronExpression, searchQuery)}
                        </code>
                        <span className={`text-[10px] px-1 py-0.5 rounded whitespace-nowrap ${
                            taskTypeColors[schedule.taskType] || 'bg-gray-500/10 text-gray-400'
                        }`}>
                            {TASK_TYPE_LABEL[schedule.taskType] || schedule.taskType}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)] truncate">
                            {highlightText(schedule.taskTarget, searchQuery)}
                        </span>
                    </div>

                    {/* 描述 */}
                    {schedule.description && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                            {highlightText(schedule.description, searchQuery)}
                        </div>
                    )}

                    {/* 执行信息 */}
                    <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] text-[var(--text-muted)]">
                            上次: <span className={getLastRunStatusColor(schedule.lastRunStatus)}>
                                {getLastRunStatusLabel(schedule.lastRunStatus)}
                            </span>
                            <span className="ml-1">{formatTime(schedule.lastRunAt)}</span>
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                            执行 <strong className="text-[var(--text-primary)]">{schedule.runCount}</strong> 次
                        </span>
                    </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-0.5 flex-shrink-0 pt-0.5">
                    {/* 启用/禁用开关 */}
                    <Switch
                        checked={schedule.enabled}
                        onChange={(checked) => checked !== schedule.enabled && onToggleEnabled()}
                    />

                    {/* 立即执行/停止 */}
                    <button
                        onClick={onRunNow}
                        className={`p-1.5 rounded transition-colors ${
                            isRunning
                                ? 'text-red-400 hover:bg-red-500/10'
                                : 'text-emerald-400 hover:bg-emerald-500/10'
                        }`}
                        title={isRunning ? '停止' : '立即执行'}
                    >
                        {isRunning ? (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="6" width="12" height="12"/>
                            </svg>
                        ) : (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        )}
                    </button>

                    {/* 执行记录 */}
                    <button
                        onClick={onToggleConversation}
                        className={`p-1.5 rounded transition-colors ${
                            isConversationExpanded
                                ? 'text-[var(--brand-primary)] bg-[var(--brand-primary)]/10'
                                : 'text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10'
                        }`}
                        title="执行记录"
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                        </svg>
                    </button>

                    {/* 编辑 */}
                    <button
                        onClick={onEdit}
                        className="p-1.5 text-[var(--text-muted)] hover:text-[var(--brand-primary)] rounded hover:bg-[var(--brand-primary)]/10 transition-colors"
                        title="编辑"
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                        </svg>
                    </button>

                    {/* 删除 */}
                    <button
                        onClick={onDelete}
                        className="p-1.5 text-[var(--text-muted)] hover:text-red-400 rounded hover:bg-red-500/10 transition-colors"
                        title="删除"
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m8 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                            <line x1="10" y1="11" x2="10" y2="17"/>
                            <line x1="14" y1="11" x2="14" y2="17"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─── 执行记录面板组件 ─────────────────────────────────

interface ConversationsPanelProps {
    scheduleId: string
    scheduleName: string
    taskType: string
}

/** 脚本日志文件记录 */
interface ScriptLogEntry {
    path: string
    fileName: string
    startTime: number
    size: number
}

function ConversationsPanel({scheduleId, scheduleName, taskType}: ConversationsPanelProps) {
    const isScript = taskType === 'script'

    if (isScript) {
        return <ScriptLogPanel scheduleId={scheduleId} scheduleName={scheduleName}/>
    }

    // Agent/Skill/Command：提示到会话列表搜索
    return (
        <div className="mx-4 mb-1 rounded-md border border-[var(--border)] bg-[var(--surface-muted)]/50 overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    执行记录
                </span>
            </div>
            <div className="p-4 text-center">
                <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                    请在<strong className="text-[var(--text-primary)]">会话列表</strong>搜索
                    "<strong className="text-[var(--brand-primary)]">{scheduleName}</strong>" 查看执行记录
                </div>
                <div className="mt-2 flex justify-center">
                    <svg className="w-8 h-8 text-[var(--text-muted)]/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 6v6l4 2"/>
                    </svg>
                </div>
            </div>
        </div>
    )
}

// ─── 脚本日志面板 ─────────────────────────────────────

function ScriptLogPanel({scheduleId, scheduleName}: {scheduleId: string; scheduleName: string}) {
    const [logs, setLogs] = useState<ScriptLogEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [expandedLog, setExpandedLog] = useState<string | null>(null)
    const [logContent, setLogContent] = useState<string>('')
    const [loadingContent, setLoadingContent] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false

        const fetchLogs = async () => {
            setLoading(true)
            try {
                const data = await window.electronAPI?.scheduler?.scriptLogs?.(scheduleId)
                if (!cancelled) {
                    setLogs(Array.isArray(data) ? data : [])
                }
            } catch {
                if (!cancelled) setLogs([])
            } finally {
                if (!cancelled) setLoading(false)
            }
        }

        fetchLogs()
        return () => { cancelled = true }
    }, [scheduleId])

    const handleView = async (logPath: string) => {
        if (expandedLog === logPath) {
            setExpandedLog(null)
            setLogContent('')
            return
        }
        setLoadingContent(logPath)
        try {
            const content = await window.electronAPI?.scheduler?.readScriptLog?.(logPath) || ''
            setLogContent(content)
            setExpandedLog(logPath)
        } catch {
            setLogContent('读取失败')
            setExpandedLog(logPath)
        } finally {
            setLoadingContent(null)
        }
    }

    const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes}B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`
    }

    return (
        <div className="mx-4 mb-1 rounded-md border border-[var(--border)] bg-[var(--surface-muted)]/50 overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    脚本执行记录
                </span>
            </div>

            {loading ? (
                <div className="p-4 text-center">
                    <div className="inline-block w-4 h-4 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">加载执行记录...</div>
                </div>
            ) : logs.length === 0 ? (
                <div className="p-4 text-center">
                    <div className="text-[10px] text-[var(--text-muted)]">暂无脚本执行记录</div>
                </div>
            ) : (
                <div className="divide-y divide-[var(--border)]">
                    {logs.map((log, idx) => {
                        const d = new Date(log.startTime)
                        const pad = (n: number) => String(n).padStart(2, '0')
                        const timeStr = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
                        const isExpanded = expandedLog === log.path

                        return (
                            <div key={log.path}>
                                <div className="px-3 py-2 flex items-center gap-3">
                                    {/* 序号 */}
                                    <span className="text-[10px] text-[var(--text-muted)] font-mono w-5 shrink-0">
                                        {logs.length - idx}
                                    </span>

                                    {/* 时间 */}
                                    <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">
                                        {timeStr}
                                    </span>

                                    {/* 文件大小 */}
                                    <span className="text-[10px] text-[var(--text-muted)]">
                                        {formatSize(log.size)}
                                    </span>

                                    <div className="flex-1"/>

                                    {/* 查看/收起按钮 */}
                                    <button
                                        onClick={() => handleView(log.path)}
                                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                                            isExpanded
                                                ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                        }`}
                                    >
                                        {loadingContent === log.path ? (
                                            <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"/>
                                        ) : isExpanded ? '收起' : '查看'}
                                    </button>
                                </div>

                                {/* 展开的日志内容 */}
                                {isExpanded && (
                                    <div className="px-3 pb-2">
                                        <pre className="text-[10px] text-[var(--text-muted)] font-mono bg-black/20 rounded p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
                                            {logContent || '加载中...'}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
