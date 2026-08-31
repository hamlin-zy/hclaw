import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {confirm} from '../ConfirmDialog'
import {useAgentStore} from '../../stores/agentStore'
import type {BatchGroup, BatchSummary} from '../../../main/repositories/sqlite/taskBatchRepository'

/** 批次任务明细行（与主进程 BatchWithTasks['tasks'] 对齐，subtasks 本窗口不展示） */
type TaskRow = {id: string; title: string; description?: string; status: string}

// ─── 视觉常量（沿用 ConversationsDialog 工具栏按钮语言） ───────────

// ─── 任务状态图标（TodoItem 视觉语言：状态图标 + 单行省略） ───────────

function StatusGlyph({status}: { status: string }) {
    switch (status) {
        case 'completed':
            return (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
                     className="text-[var(--success)]">
                    <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="m4.7 7.2 1.7 1.7 2.9-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                          strokeLinejoin="round"/>
                </svg>
            )
        case 'running':
            return (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
                     className="animate-spin text-[var(--brand-primary)]">
                    <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="5.5 3"/>
                </svg>
            )
        case 'failed':
        case 'error':
            return (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
                     className="text-[var(--error)]">
                    <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="m5 5 4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
            )
        default:
            return (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
                     className="text-[var(--text-muted)]">
                    <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4"/>
                </svg>
            )
    }
}

function HistoryTaskItem({task}: { task: TaskRow }) {
    const isCompleted = task.status === 'completed'
    return (
        <li
            data-status={task.status}
            title={task.description || task.title}
            className={`flex items-center gap-2.5 min-w-0 text-[13px] leading-5 list-none ${
                isCompleted ? 'text-[var(--text-muted)] line-through' :
                    task.status === 'running' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            }`}
        >
            <span className="grid place-items-center w-4 h-4 shrink-0" aria-hidden="true">
                <StatusGlyph status={task.status}/>
            </span>
            <span className="min-w-0 truncate">{task.title}</span>
        </li>
    )
}

// ─── 时间格式化 ──────────────────────────────────────

function formatRelative(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`
    return new Date(ts).toLocaleDateString('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit'})
}

function formatAbsolute(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    })
}

// ─── 批次条目 ──────────────────────────────────────

interface BatchRowProps {
    batch: BatchSummary
    checked: boolean
    deleting: boolean
    onToggleCheck: (id: string) => void
}

function BatchRow({batch, checked, deleting, onToggleCheck}: BatchRowProps) {
    // 展开态 + 任务明细懒加载缓存（组件实例级，切回不重复拉取）
    const [expanded, setExpanded] = useState(false)
    const [tasks, setTasks] = useState<TaskRow[] | null>(null)
    const [loadingTasks, setLoadingTasks] = useState(false)
    const isActive = batch.status !== 'completed'

    const toggleExpand = useCallback(async () => {
        const next = !expanded
        setExpanded(next)
        if (next && tasks === null) {
            setLoadingTasks(true)
            try {
                const data = await window.electronAPI?.taskBatches?.getTasks?.(batch.id)
                setTasks(data ?? [])
            } catch {
                setTasks([])
            } finally {
                setLoadingTasks(false)
            }
        }
    }, [expanded, tasks, batch.id])

    return (
        <div className={`border-b border-[var(--border-muted)] ${deleting ? 'pointer-events-none opacity-50' : ''}`}>
            <div
                className={`grid grid-cols-[32px_28px_1fr_auto] gap-2 items-center px-5 py-2.5 text-sm cursor-pointer transition-colors hover:bg-[var(--surface-muted)] ${
                    checked ? 'bg-[var(--surface-muted)]' : ''
                }`}
                onClick={() => onToggleCheck(batch.id)}
             data-name="task-history-dialog-div">
                <div className="flex items-center">
                    <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleCheck(batch.id)}
                        disabled={deleting}
                        onClick={(e) => e.stopPropagation()}
                        className="w-3.5 h-3.5 rounded border-[var(--border)] accent-[var(--brand-primary)]"
                    data-name="task-history-dialog-input"/>
                </div>

                {/* 展开/收起箭头 */}
                <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={expanded ? '收起任务明细' : '展开任务明细'}
                    onClick={(e) => {
                        e.stopPropagation()
                        void toggleExpand()
                    }}
                    className="p-0 border-none bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer grid place-items-center"
                 data-name="task-history-dialog-button">
                    <svg className={`w-3.5 h-3.5 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                         viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </button>

                {/* 名称 + 状态徽标 */}
                <div className="min-w-0 flex items-center gap-2">
                    <span className="truncate text-[var(--text-primary)]" title={batch.name}>{batch.name}</span>
                    <span
                        className={`shrink-0 px-1.5 py-px rounded-full text-[10px] leading-4 whitespace-nowrap ${
                            isActive
                                ? 'bg-[var(--brand-muted)] text-[var(--brand-primary)]'
                                : 'bg-[var(--surface-muted)] text-[var(--text-muted)]'
                        }`}
                    >
                        {isActive ? '进行中' : '已完成'}
                    </span>
                </div>

                {/* 时间 + 进度 */}
                <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] tabular-nums shrink-0">
                    <span title={`创建于 ${formatAbsolute(batch.createdAt)}`}>
                        创建 {formatRelative(batch.createdAt)}
                    </span>
                    {batch.completedAt != null && (
                        <span title={`完成于 ${formatAbsolute(batch.completedAt)}`}>
                            完成 {formatRelative(batch.completedAt)}
                        </span>
                    )}
                    <span>{batch.done}/{batch.total}</span>
                </div>
            </div>

            {/* 展开任务明细 */}
            {expanded && (
                <ul className="m-0 pb-2.5 pl-[68px] pr-5 flex flex-col gap-1.5 max-h-[220px] overflow-y-auto">
                    {loadingTasks ? (
                        <li className="list-none text-xs text-[var(--text-muted)]">加载中...</li>
                    ) : (tasks?.length ?? 0) === 0 ? (
                        <li className="list-none text-xs text-[var(--text-muted)]">无任务明细</li>
                    ) : tasks!.map((task) => (
                        <HistoryTaskItem key={task.id} task={task}/>
                    ))}
                </ul>
            )}
        </div>
    )
}

// ─── 主组件 ──────────────────────────────────────

/**
 * 历史任务组窗口（双作用域）：
 * - 全量模式（task-history）：左侧会话分组列表（含「全部会话」）+ 右侧批次列表，
 *   数据限定当前工作区（workspaceId 实际承载工作区路径）
 * - 当前会话模式（task-history-conv）：无侧栏，仅展示 --hclaw-task-conv 指定会话的批次；
 *   缺失参数时回退全量视图并 console.warn
 * - 关键词过滤防抖 300ms；批次多选删除带 ConfirmDialog；
 *   当前会话模式删除活跃批次后同步刷新 agentStore 对应 convData
 */
export default function TaskHistoryDialog() {
    const dialogType = window.electronAPI?.dialogType ?? ''
    const rawScopeConvId = window.electronAPI?.taskConvId || undefined
    const isConvScope = dialogType === 'task-history-conv'

    // 缺失 taskConvId 的当前会话模式 → 回退全量视图
    let scopeConvId: string | undefined
    if (isConvScope && rawScopeConvId) {
        scopeConvId = rawScopeConvId
    } else if (isConvScope) {
        console.warn('[TaskHistoryDialog] task-history-conv 缺失 --hclaw-task-conv 参数，回退全量视图')
    }

    // ── 状态 ────────────────────────────────────────
    const [workspacePath, setWorkspacePath] = useState<string | null>(null)
    const [ready, setReady] = useState(false)
    const [groups, setGroups] = useState<BatchGroup[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [filterInput, setFilterInput] = useState('')
    const [filter, setFilter] = useState('')
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [deleting, setDeleting] = useState(false)
    // 删除失败的用户可见反馈（与加载错误 error 分开，避免整页错误视图顶掉列表）
    const [deleteError, setDeleteError] = useState<string | null>(null)
    // 全量模式侧栏选中会话；null = 全部会话
    const [selectedConvId, setSelectedConvId] = useState<string | null>(null)

    const reloadRef = useRef<() => void>(() => {})

    // ── 关键词过滤防抖 300ms ─────────────────────────
    useEffect(() => {
        const timer = setTimeout(() => setFilter(filterInput.trim()), 300)
        return () => clearTimeout(timer)
    }, [filterInput])

    // ── 独立窗口初始化：解析当前工作区路径（workspaceId 参数实际承载路径） ──
    useEffect(() => {
        let cancelled = false
        // 当前会话模式以 conversationId 限定了数据范围，无需工作区过滤也可查询
        void window.electronAPI?.workspace?.getCurrent?.()
            .then((ws) => {
                if (!cancelled) {
                    setWorkspacePath(ws?.path ?? null)
                    setReady(true)
                }
            })
            .catch(() => {
                if (!cancelled) setReady(true)
            })
        return () => {
            cancelled = true
        }
    }, [])

    // ── 加载批次列表 ────────────────────────────────
    const loadGroups = useCallback(async () => {
        if (!ready) return
        setLoading(true)
        setError(null)
        try {
            const data = await window.electronAPI?.taskBatches?.list?.({
                filter: filter || undefined,
                conversationId: scopeConvId,
                // 全量模式限定当前工作区；scope 模式无需重复限定
                workspaceId: scopeConvId ? undefined : (workspacePath ?? undefined),
            })
            setGroups(data ?? [])
        } catch (err) {
            console.error('[TaskHistoryDialog] loadGroups failed:', err)
            setError('加载任务历史失败')
        } finally {
            setLoading(false)
        }
    }, [ready, filter, scopeConvId, workspacePath])

    useEffect(() => {
        void loadGroups()
        // 清理已不存在的选中项
        setSelectedIds(new Set())
    }, [loadGroups])

    reloadRef.current = () => void loadGroups()

    // ── 右侧展示的批次列表 ──────────────────────────
    // 全量模式按侧栏选中会话客户端过滤（列表一次拉取，侧栏保持完整）
    const visibleGroups = useMemo(() => {
        if (scopeConvId || !selectedConvId) return groups
        return groups.filter(g => g.conversationId === selectedConvId)
    }, [groups, selectedConvId, scopeConvId])

    const visibleBatches = useMemo(
        () => visibleGroups.flatMap(g => g.batches),
        [visibleGroups],
    )

    // ── 选择控制 ────────────────────────────────────
    const toggleSelect = useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])

    const selectedCount = selectedIds.size

    // 选中批次的任务总数（确认文案用）
    const selectedTaskTotal = useMemo(() => {
        let total = 0
        for (const g of visibleGroups) {
            for (const b of g.batches) {
                if (selectedIds.has(b.id)) total += b.total
            }
        }
        return total
    }, [visibleGroups, selectedIds])

    // ── 删除操作 ────────────────────────────────────
    const handleDeleteSelected = useCallback(async () => {
        if (selectedCount === 0) return
        const ids = Array.from(selectedIds)

        const confirmed = await confirm({
            title: '删除任务组',
            message: selectedTaskTotal > 0
                ? `确定要删除选中的 ${selectedCount} 个任务组吗？\n（共包含 ${selectedTaskTotal} 个任务的明细记录）\n此操作不可撤销。`
                : `确定要删除选中的 ${selectedCount} 个任务组吗？\n此操作不可撤销。`,
            confirmText: '删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                setDeleting(true)
                setDeleteError(null)
                try {
                    await window.electronAPI?.taskBatches?.remove?.(ids)
                    // 当前会话模式：删除含本窗口活跃批次时刷新 agentStore 对应 convData，
                    // 防止 TodoStrip 显示已删数据（其他窗口由主进程广播触发同步）
                    if (scopeConvId) {
                        const activeBatchId = useAgentStore.getState().convAgentStates[scopeConvId]?.currentBatch?.id
                        if (activeBatchId && ids.includes(activeBatchId)) {
                            useAgentStore.getState().updateConvData(scopeConvId, {currentBatch: undefined, tasks: []})
                        }
                    }
                    setSelectedIds(new Set())
                    reloadRef.current()
                } catch (err) {
                    console.error('[TaskHistoryDialog] delete failed:', err)
                    setDeleteError('删除任务组失败，请稍后重试')
                } finally {
                    setDeleting(false)
                }
            },
        })
        if (!confirmed) return
    }, [selectedCount, selectedIds, selectedTaskTotal, scopeConvId])

    // ── 渲染：加载 / 错误 / 空 ──────────────────────
    if (!ready || loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    <span className="text-sm text-[var(--text-muted)]">加载中...</span>
                </div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <svg className="w-10 h-10 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span className="text-sm text-red-400">{error}</span>
                    <button onClick={reloadRef.current}
                            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors" data-name="task-history-dialog-reload-button">
                        重试
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* 工具栏：搜索 + 删除 */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)]">
                <div className="relative flex-1 min-w-0 max-w-[280px]">
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
                         viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        value={filterInput}
                        onChange={(e) => setFilterInput(e.target.value)}
                        placeholder="搜索任务组或任务标题"
                        className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
                    data-name="task-history-dialog-filter-input"/>
                </div>

                <div className="ml-auto flex items-center gap-3 shrink-0">
                    {selectedCount > 0 && (
                        <span className="text-xs text-[var(--text-muted)]">已选 {selectedCount} 组</span>
                    )}
                    <button
                        onClick={handleDeleteSelected}
                        disabled={selectedCount === 0 || deleting}
                        className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0 ${
                            selectedCount === 0
                                ? 'bg-[var(--surface-muted)] text-[var(--text-muted)] opacity-60 cursor-not-allowed'
                                : deleting
                                    ? 'bg-red-500/20 text-red-400 cursor-not-allowed'
                                    : 'bg-red-500/12 text-red-400 hover:bg-red-500/20'
                        }`}
                     data-name="task-history-dialog-delete-button">
                        {deleting ? (
                            <>
                                <div className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin"/>
                                删除中...
                            </>
                        ) : (
                            <>
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                </svg>
                                删除选中{selectedCount > 0 ? ` (${selectedCount})` : ''}
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* 删除失败横幅（用户可见反馈，手动关闭） */}
            {deleteError && (
                <div className="flex items-center gap-2 px-5 py-2 bg-red-500/10 border-b border-red-500/30">
                    <svg className="w-3.5 h-3.5 shrink-0 text-red-400" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span className="text-xs text-red-400">{deleteError}</span>
                    <button
                        onClick={() => setDeleteError(null)}
                        className="ml-auto shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                     data-name="task-history-dialog-dismiss-error-button">
                        关闭
                    </button>
                </div>
            )}

            {/* 主体：全量模式左会话列表 + 右批次列表；当前会话模式无侧栏 */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
                {!scopeConvId && (
                    <aside
                        className="w-[200px] shrink-0 border-r border-[var(--border-muted)] bg-[var(--surface-muted)] overflow-y-auto py-2">
                        <button
                            onClick={() => setSelectedConvId(null)}
                            aria-selected={selectedConvId === null}
                            className={`w-full flex items-center justify-between gap-2 px-4 py-2 text-left text-[13px] transition-colors ${
                                selectedConvId === null
                                    ? 'bg-[var(--brand-muted)] text-[var(--brand-primary)] font-medium'
                                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)]'
                            }`}
                         data-name="task-history-dialog-all-conversations-tab-button">
                            <span className="min-w-0 truncate">全部会话</span>
                            <span className="shrink-0 text-[11px] tabular-nums opacity-70">{groups.length}</span>
                        </button>
                        {groups.map((g, i) => (
                            <button
                                key={g.conversationId}
                                onClick={() => setSelectedConvId(g.conversationId)}
                                aria-selected={selectedConvId === g.conversationId}
                                title={g.conversationTitle || '(无标题)'}
                                className={`w-full flex items-center justify-between gap-2 px-4 py-2 text-left text-[13px] transition-colors ${
                                    selectedConvId === g.conversationId
                                        ? 'bg-[var(--brand-muted)] text-[var(--brand-primary)] font-medium'
                                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)]'
                                }`}
                             data-name={`task-history-dialog-group-${i}`}>
                                <span className="min-w-0 truncate">
                                    {g.conversationTitle || '(无标题)'}
                                </span>
                                <span className="shrink-0 text-[11px] tabular-nums opacity-70">{g.batches.length}</span>
                            </button>
                        ))}
                    </aside>
                )}

                {/* 右侧批次列表 */}
                <div className="flex-1 min-w-0 overflow-y-auto">
                    {groups.length === 0 ? (
                        <div className="h-full flex items-center justify-center">
                            <div className="flex flex-col items-center gap-3">
                                <svg className="w-10 h-10 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="1.5">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polyline points="12 6 12 12 16 14"/>
                                </svg>
                                <span className="text-sm text-[var(--text-muted)]">
                                    {filter ? '没有匹配的任务组' : '暂无历史任务组'}
                                </span>
                            </div>
                        </div>
                    ) : visibleBatches.length === 0 ? (
                        <div className="h-full flex items-center justify-center">
                            <span className="text-sm text-[var(--text-muted)]">该会话暂无匹配的任务组</span>
                        </div>
                    ) : (
                        visibleGroups.map((g) => (
                            <section key={g.conversationId}>
                                {/* 分组头：全量模式显示会话标题；单会话视图省略 */}
                                {!scopeConvId && selectedConvId === null && (
                                    <div
                                        className="sticky top-0 z-10 px-5 py-1.5 text-xs text-[var(--text-muted)] bg-[var(--surface)] border-b border-[var(--border-muted)] truncate"
                                        title={g.conversationTitle || '(无标题)'}
                                    >
                                        {g.conversationTitle || '(无标题)'}
                                    </div>
                                )}
                                {g.batches.map((batch) => (
                                    <BatchRow
                                        key={batch.id}
                                        batch={batch}
                                        checked={selectedIds.has(batch.id)}
                                        deleting={deleting}
                                        onToggleCheck={toggleSelect}
                                    />
                                ))}
                            </section>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
