import {useCallback, useEffect, useMemo, useState} from 'react'
import type {ConversationWithStats} from '@shared/types'
import type {ConversationStatsScope} from '@shared/types/conversationStats'
import type {ProjectGroupWithMembers} from '@shared/types/projectGroup'
import {useConversationStore} from '../../stores/conversationStore'
import {confirm} from '../ConfirmDialog'
import {collectDescendants} from '../../stores/conversationTree'
import {formatRelativeTime} from '../../lib/relativeTime'
import {getBasename} from '../../lib/format'
import {workspacePathKey} from '../../lib/workspacePath'

/** 工具栏按钮样式常量 */
const BTN_BORDERED = "px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"
const BTN_GHOST = "px-2 py-1.5 text-xs rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"
const SELECT_CLS = "px-2 py-1 text-xs bg-[var(--surface-muted)] rounded border border-[var(--border)] text-[var(--text-primary)] max-w-[220px]"

/** 工作区记录（`workspace:list` 返回项；本页只取路径与展示名） */
type WorkspaceRecord = {id: string; path: string; name: string; createdAt: number; updatedAt: number}

/** 组筛选哨兵值：顶层项目（不属于任何组）——主进程不查 group_id，范围仍由 workspacePaths 驱动 */
const UNGROUPED = '__ungrouped__'
/** 项目筛选哨兵值：未归属会话（workspacePath 为空，与侧栏「未归属」虚拟段同一口径） */
const UNASSIGNED = '__unassigned__'

/** 默认 scope 的稳定引用：级联数据到达不改变「全部」语义，避免触发重复查询 */
const ALL_SCOPE: ConversationStatsScope = {scope: 'all'}

/**
 * 级联筛选 → 统计查询 scope（纯函数）。
 * 项目筛选优先于组筛选（「全部项目」= 不施加项目筛选，跟随组）；组为「全部」= 不施加范围。
 */
function resolveStatsScope(
    groupFilter: string,
    projectFilter: string,
    groupPaths: string[],
    topLevelPaths: string[],
): ConversationStatsScope {
    if (projectFilter === UNASSIGNED) return {scope: 'unassigned'}
    if (projectFilter) return {scope: 'project', workspacePath: projectFilter}
    if (groupFilter === UNGROUPED) return {scope: 'group', groupId: UNGROUPED, workspacePaths: topLevelPaths}
    if (groupFilter) return {scope: 'group', groupId: groupFilter, workspacePaths: groupPaths}
    return ALL_SCOPE
}

/** 某组筛选下的项目路径：未分组 → 顶层项目；组 → 成员；全部 → 全部项目 */
function projectPathsFor(
    groupId: string,
    groups: ProjectGroupWithMembers[],
    workspaces: WorkspaceRecord[],
    topLevelPaths: string[],
): string[] {
    if (groupId === UNGROUPED) return topLevelPaths
    if (groupId) return (groups.find((g) => g.id === groupId)?.members ?? []).map((m) => m.projectPath)
    return workspaces.map((w) => w.path)
}

/**
 * 会话管理对话框
 * 展示所有会话的统计信息（消息数、block 数），支持批量删除
 */
export default function ConversationsDialog() {
    const deleteConversations = useConversationStore((s) => s.deleteConversations)

    const [conversations, setConversations] = useState<ConversationWithStats[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [deleting, setDeleting] = useState(false)
    // store 初始化是否完成（独立窗口 JS 堆无主窗口的 store 状态，需显式初始化后才可查询）
    const [workspaceReady, setWorkspaceReady] = useState(false)
    // 级联筛选（'' = 全部；组为 groupId 或 UNGROUPED；项目为工作区路径）
    const [groupFilter, setGroupFilter] = useState('')
    const [projectFilter, setProjectFilter] = useState('')
    const [groups, setGroups] = useState<ProjectGroupWithMembers[]>([])
    const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])

    // ── 独立窗口 store 初始化 ────────────────────────────────
    // 独立窗口是全新 JS 堆，不继承主窗口 zustand store（currentWorkspacePath 初始为 null）。
    // 打开时显式调用 store.loadConversations()（仿 toolStore.loadTools 模式），内部经
    // workspace.getCurrent 解析当前工作区并填充 workspaces / currentWorkspacePath，
    // 删除时的后代展开需要它（列表查询本身走 scope，不依赖当前工作区）。
    useEffect(() => {
        const state = useConversationStore.getState()
        if (state.currentWorkspacePath) {
            setWorkspaceReady(true)
            return
        }
        void state.loadConversations().finally(() => setWorkspaceReady(true))
    }, [])

    // ── 级联筛选数据（本窗口自行拉取，与 store 引导并行 → 首屏列表不被它阻塞）──
    // 独立窗口不读主窗口 viewScope / 组快照；任一来源失败只降级（少一类选项），不抛错、不白屏。
    useEffect(() => {
        let cancelled = false
        void (async () => {
            const [g, w] = await Promise.all([
                (async () => { try { return await window.electronAPI?.projectGroup?.list?.() } catch { return null } })(),
                (async () => { try { return await window.electronAPI?.workspace?.list?.() } catch { return null } })(),
            ])
            if (cancelled) return
            if (Array.isArray(g)) setGroups(g as ProjectGroupWithMembers[])
            if (Array.isArray(w)) setWorkspaces(w as WorkspaceRecord[])
        })()
        return () => {
            cancelled = true
        }
    }, [])

    /** 未被任何组包含的路径 = 顶层项目（组数据不可用时全部视为顶层） */
    const groupedKeys = useMemo(
        () => new Set(groups.flatMap((g) => g.members.map((m) => workspacePathKey(m.projectPath)))),
        [groups],
    )
    /** 顶层项目路径（「未分组」范围；workspace:list 不可用时为空） */
    const topLevelPaths = useMemo(
        () => workspaces.filter((w) => !groupedKeys.has(workspacePathKey(w.path))).map((w) => w.path),
        [workspaces, groupedKeys],
    )
    /** 当前组筛选范围内的项目路径（同时作为项目下拉的候选项） */
    const groupPaths = useMemo(
        () => projectPathsFor(groupFilter, groups, workspaces, topLevelPaths),
        [groupFilter, groups, workspaces, topLevelPaths],
    )
    /** 查询 scope：由级联筛选推导（Task 8 的对象参数） */
    const scope = useMemo(
        () => resolveStatsScope(groupFilter, projectFilter, groupPaths, topLevelPaths),
        [groupFilter, projectFilter, groupPaths, topLevelPaths],
    )

    // ── 加载数据 ────────────────────────────────────────────
    const loadData = useCallback(async () => {
        // 初始化完成前保持加载态，避免闪现"暂无会话"
        if (!workspaceReady) return
        setLoading(true)
        setError(null)
        try {
            const data = await window.electronAPI?.conversationListWithStats?.(scope)
            const list = data ?? []
            setConversations(list)
            // 选区与返回数据取交：切换筛选后列表内容会与选区脱钩（计数 / 确认文案承诺的
            // 条数与实际收集不符，甚至出现"实收集为空 → store 静默 0 删"），取交后
            // 「已选 N 项」、确认文案与实收集始终同源。
            setSelectedIds((prev) => new Set([...prev].filter((id) => list.some((c) => c.id === id))))
        } catch (err) {
            console.error('[ConversationsDialog] loadData failed:', err)
            setError('加载会话列表失败')
        } finally {
            setLoading(false)
        }
    }, [workspaceReady, scope])

    useEffect(() => {
        loadData()
    }, [loadData])

    // ── 选择控制 ────────────────────────────────────────────
    const toggleSelect = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
    }, [])

    // ── 按时间快捷选择 ─────────────────────────────────────
    const selectByTime = useCallback((days: number) => {
        const cutoff = Date.now() - days * 86400000
        setSelectedIds(new Set(
            conversations
                .filter((c) => c.updatedAt < cutoff)
                .map((c) => c.id)
        ))
    }, [conversations])

    const TIME_PRESETS = [
        {days: 1, label: '1天前'},
        {days: 3, label: '3天前'},
        {days: 7, label: '7天前'},
        {days: 14, label: '14天前'},
        {days: 30, label: '30天前'},
    ] as const

    // ── 删除操作 ────────────────────────────────────────────
    const selectedCount = selectedIds.size

    /** 项目展示名（列表里有记录 → 记录名；否则取路径末段） */
    const projectLabel = (p: string) =>
        workspaces.find((w) => workspacePathKey(w.path) === workspacePathKey(p))?.name || getBasename(p)

    /** 切组 → 原项目不在新范围内则清空重选（不自动猜） */
    const handleGroupChange = (nextGroupId: string) => {
        setGroupFilter(nextGroupId)
        const nextPaths = projectPathsFor(nextGroupId, groups, workspaces, topLevelPaths)
        if (projectFilter && !nextPaths.some((p) => workspacePathKey(p) === workspacePathKey(projectFilter))) {
            setProjectFilter('')
        }
    }

    const handleDeleteSelected = useCallback(async () => {
        if (selectedCount === 0) return

        // 后代展开：按**各会话所属项目**分别解析（跨项目批量删除时不能只查当前项目）
        const state = useConversationStore.getState()
        const byWorkspace = new Map<string, ConversationWithStats[]>()
        for (const c of conversations) {
            const list = byWorkspace.get(c.workspacePath) ?? []
            list.push(c)
            byWorkspace.set(c.workspacePath, list)
        }
        // 完整删除集 = 选中 ∪ 各自后代（与确认文案同源，避免文案承诺的后代未实删：
        // store 只按 currentWorkspacePath 展开，跨项目时其他项目的后代会被漏掉，
        // 因此这里把已展开集直接传给 deleteConversations —— store 再展开是幂等的）。
        const toDelete = new Set<string>()
        for (const [wsPath, list] of byWorkspace) {
            // ★ 只传**该项目内**的选中 id：collectDescendants 会把入参 id 无条件计入结果，
            //   若每个项目都传全部 selectedIds，返回值会带上其他项目的选中 id，求和后
            //   再减一次 selectedIds.size 会高估 (N-1)×|selected|。
            const inWs = list.filter((c) => selectedIds.has(c.id)).map((c) => c.id)
            if (inWs.length === 0) continue
            const allConvs = state.workspaces[wsPath]?.conversations ?? list
            for (const id of collectDescendants(allConvs, inWs)) toDelete.add(id)
        }
        const descendantCount = toDelete.size - selectedIds.size

        await confirm({
            title: '删除会话',
            message: descendantCount > 0
                ? `确定要删除选中的 ${selectedCount} 个会话吗？\n（含 ${descendantCount} 个子会话将一并删除）\n此操作不可撤销，关联的消息和记录将一并删除。`
                : `确定要删除选中的 ${selectedCount} 个会话吗？\n此操作不可撤销，关联的消息和记录将一并删除。`,
            confirmText: '删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                setDeleting(true)
                try {
                    // 传已展开的完整删除集（含跨项目后代），store 再展开幂等
                    await deleteConversations(Array.from(toDelete))
                    // 刷新列表
                    await loadData()
                    setSelectedIds(new Set())
                } catch (err) {
                    console.error('[ConversationsDialog] delete failed:', err)
                } finally {
                    setDeleting(false)
                }
            },
        })
    }, [selectedCount, selectedIds, conversations, deleteConversations, loadData])

    // ── 格式化时间（共享工具，与备忘录列表同源） ──────────────────

    // ── 总计信息 ────────────────────────────────────────────
    const totals = useMemo(() => {
        let messages = 0
        let blocks = 0
        for (const c of conversations) {
            messages += c.messageCount
            blocks += c.blockCount
        }
        return {conversations: conversations.length, messages, blocks}
    }, [conversations])

    // ── 渲染：级联筛选条（独立窗口自行拉取组/项目；默认「全部 + 全部项目」）──
    const filterBar = (
        <div className="flex items-center gap-2 flex-wrap px-5 py-3 border-b border-[var(--border-muted)]">
            <select
                value={groupFilter}
                onChange={(e) => handleGroupChange(e.target.value)}
                aria-label="项目组筛选"
                className={SELECT_CLS}
                data-name="conversations-group-filter">
                <option value="">全部</option>
                {workspaces.length > 0 && <option value={UNGROUPED}>未分组</option>}
                {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                ))}
            </select>
            <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                aria-label="项目筛选"
                className={SELECT_CLS}
                data-name="conversations-project-filter">
                <option value="">全部项目</option>
                {groupFilter === '' && <option value={UNASSIGNED}>未归属</option>}
                {groupPaths.map((p) => (
                    <option key={p} value={p}>{projectLabel(p)}</option>
                ))}
            </select>
        </div>
    )

    // ── 渲染：加载状态 ──────────────────────────────────────
    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <div
                        className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    <span className="text-sm text-[var(--text-secondary)]">加载中...</span>
                </div>
            </div>
        )
    }

    // ── 渲染：错误状态 ──────────────────────────────────────
    if (error) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <svg className="w-10 h-10 text-[var(--error)]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span className="text-sm text-[var(--error)]">{error}</span>
                    <button
                        onClick={loadData}
                        className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                     data-name="conversations-dialog-button">
                        重试
                    </button>
                </div>
            </div>
        )
    }

    // ── 渲染：空状态（保留筛选条：筛出空结果后仍可切回，否则成为死路）──
    if (conversations.length === 0) {
        return (
            <div className="flex flex-col h-full min-h-0">
                {filterBar}
                <div className="flex flex-1 items-center justify-center py-20">
                    <div className="flex flex-col items-center gap-3">
                        <svg className="w-10 h-10 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="1.5">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span className="text-sm text-[var(--text-secondary)]">暂无会话</span>
                    </div>
                </div>
            </div>
        )
    }

    // ── 渲染：正常列表 ──────────────────────────────────────
    return (
        <div className="flex flex-col h-full min-h-0">
            {filterBar}
            {/* 工具栏 */}
            <div className="flex items-center gap-3 gap-y-2 px-5 py-3 border-b border-[var(--border-muted)] flex-wrap">
                {/* 全选 / 反选 */}
                <button
                    onClick={() => setSelectedIds(new Set(conversations.map((c) => c.id)))}
                    className={BTN_BORDERED}
                 data-name="conversations-dialog-select-all-button">
                    全选
                </button>
                <button
                    onClick={() => {
                        setSelectedIds((prev) => {
                            const currentIds = new Set(conversations.map((c) => c.id))
                            const inverted = new Set(
                                [...currentIds].filter((id) => !prev.has(id))
                            )
                            return inverted
                        })
                    }}
                    className={BTN_BORDERED}
                 data-name="conversations-dialog-invert-selection-button">
                    反选
                </button>

                {/* 分隔线 */}
                <div className="w-px h-4 bg-[var(--border-muted)] shrink-0" aria-hidden="true"/>

                {/* 按时间快捷选择 */}
                {TIME_PRESETS.map(({days, label}, i) => (
                    <button
                        key={days}
                        onClick={() => selectByTime(days)}
                        className={BTN_GHOST}
                     data-name={`conversations-dialog-time-preset-${i}`}>
                        {label}
                    </button>
                ))}

                {/* 取消选中 */}
                <button
                    onClick={() => setSelectedIds(new Set())}
                    className={BTN_GHOST}
                 data-name="conversations-dialog-clear-selection-button">
                    取消选中
                </button>

                {/* ml-auto 替换 flex-1，换行时不占满整行 */}
                <div className="ml-auto flex items-center gap-3 shrink-0">
                    {selectedCount > 0 && (
                        <span className="text-xs text-[var(--text-secondary)]">
                            已选 {selectedCount} 项
                        </span>
                    )}

                    <button
                        onClick={handleDeleteSelected}
                        disabled={selectedCount === 0 || deleting}
                        className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0 ${
                            selectedCount === 0
                                ? 'bg-[var(--surface-muted)] text-[var(--text-muted)] opacity-60 cursor-not-allowed'
                                : deleting
                                    ? 'bg-[color-mix(in_srgb,var(--error)_20%,transparent)] text-[var(--error)] cursor-not-allowed'
                                    : 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_20%,transparent)]'
                        }`}
                     data-name="conversations-dialog-delete-button">
                        {deleting ? (
                            <>
                                <div
                                    className="w-3.5 h-3.5 border-2 border-[var(--error)] border-t-transparent rounded-full animate-spin"/>
                                删除中...
                            </>
                        ) : (
                            <>
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <path
                                        d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                </svg>
                                删除选中{selectedCount > 0 ? ` (${selectedCount})` : ''}
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* 表格头部 */}
            <div
                className="grid grid-cols-[32px_1fr_180px_80px_80px_140px] gap-2 px-5 py-2 text-xs text-[var(--text-secondary)] border-b border-[var(--border-muted)] bg-[var(--surface-muted)]">
                <div/>
                <div>标题</div>
                <div>项目</div>
                <div className="text-right">消息数</div>
                <div className="text-right">Block 数</div>
                <div className="text-right">最后更新</div>
            </div>

            {/* 表格行 */}
            <div className="flex-1 overflow-y-auto min-h-0">
                {conversations.map((conv) => (
                    <label
                        key={conv.id}
                        className={`grid grid-cols-[32px_1fr_180px_80px_80px_140px] gap-2 px-5 py-2.5 text-sm border-b border-[var(--border-muted)] cursor-pointer transition-colors hover:bg-[var(--surface-muted)] ${
                            deleting ? 'pointer-events-none opacity-50' : ''
                        }`}
                    >
                        <div className="flex items-center">
                            <input
                                type="checkbox"
                                checked={selectedIds.has(conv.id)}
                                onChange={() => toggleSelect(conv.id)}
                                disabled={deleting}
                                className="w-3.5 h-3.5 rounded border-[var(--border)] text-[var(--text-brand)] focus:ring-[var(--focus-ring)] accent-[var(--brand-primary)]"
                            data-name="conversations-dialog-input"/>
                        </div>
                        <div className="flex items-center truncate text-[var(--text-primary)]">
                            {conv.title || '(无标题)'}
                        </div>
                        <div
                            className="flex items-center truncate text-xs text-[var(--text-secondary)]"
                            title={conv.workspacePath}
                            data-name="conversations-dialog-project-cell">
                            {conv.workspacePath ? getBasename(conv.workspacePath) : '未归属'}
                        </div>
                        <div className="flex items-center justify-end text-[var(--text-secondary)] tabular-nums">
                            {conv.messageCount}
                        </div>
                        <div className="flex items-center justify-end text-[var(--text-secondary)] tabular-nums">
                            {conv.blockCount}
                        </div>
                        <div className="flex items-center justify-end text-[var(--text-secondary)] text-xs tabular-nums">
                            {formatRelativeTime(conv.updatedAt)}
                        </div>
                    </label>
                ))}
            </div>

            {/* 底部统计 */}
            <div className="px-5 py-2.5 border-t border-[var(--border-muted)] text-xs text-[var(--text-secondary)]">
                共 {totals.conversations} 个会话，{totals.messages} 条消息，{totals.blocks} 个记录块
            </div>
        </div>
    )
}
