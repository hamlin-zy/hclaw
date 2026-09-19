/**
 * ScheduleDialog - 定时任务管理主页面
 *
 * 提供定时任务的查看、搜索、新建、编辑、删除、暂停/恢复、立即执行、
 * 执行记录查看等功能，支持按状态筛选。
 *
 * ui-02 组件拆分后本文件只承担「列表视图」：
 * - 状态与动作 → `useScheduleListState`（src/renderer/hooks）
 * - 行卡片 → `ScheduleCard`
 * - 行内执行记录 → `ScheduleConversationsPanel`（脚本类 → `ScheduleScriptLogPanel`）
 * - 状态/类型令牌表与纯函数 → `ScheduleUtils`
 */

import React, {useCallback, useRef} from 'react'
import {Toast} from '../usage/statsParts'
import {ScheduleEditModal} from './ScheduleEditModal'
import ScheduleCard from './ScheduleCard'
import ScheduleConversationsPanel from './ScheduleConversationsPanel'
import {ScheduleDisableConfirm} from './ScheduleDisableConfirm'
import {ScheduleEmptyState, ScheduleListError, ScheduleListLoading} from './ScheduleListStates'
import {INPUT_FOCUS} from '../../lib/inputFocus'
import {
    SCHEDULE_LIST_TABS,
    ScheduleListTab,
    useScheduleListState,
} from '../../hooks/useScheduleListState'

// ─── 模块级常量表（原为组件体内每次渲染重建） ─────────

/**
 * 筛选后无结果的针对性文案——与「一条都没有」区分：
 * 有搜索词时指向搜索词，否则指向当前筛选维度（沿用筛选行的说法）。
 */
function filteredEmptyCopy(activeTab: ScheduleListTab, searchQuery: string): {title: string; hint: string} {
    const q = searchQuery.trim()
    if (q) {
        return {title: `没有匹配“${q}”的定时任务`, hint: '换个更短的关键词，或清除筛选查看全部任务。'}
    }
    const label = SCHEDULE_LIST_TABS.find(t => t.key === activeTab)?.label ?? ''
    return {title: `没有「${label}」的定时任务`, hint: '切换筛选条件，或清除筛选查看全部任务。'}
}

// ─── 主组件 ─────────────────────────────────────────

export default function ScheduleDialog() {
    const {
        schedules,
        loading,
        error,
        reload,
        handleClearFilters,
        searchQuery,
        setSearchQuery,
        activeTab,
        setActiveTab,
        filteredSchedules,
        filterCounts,
        workspaceHealth,
        driftMap,
        runningTasks,
        expandedScheduleId,
        editModalOpen,
        editingSchedule,
        writeError,
        setWriteError,
        handleNew,
        handleEdit,
        handleCloseEdit,
        handleEditModalSave,
        handleDelete,
        handleToggleRun,
        handleToggleExpand,
        handleTogglePause,
        handleToggleEnabled,
        disableConfirmSchedule,
        handleCancelDisable,
        handleConfirmDisable,
        handleRestoreDefault,
    } = useScheduleListState()

    // 筛选后无结果的针对性文案（与「一条都没有」区分）
    const emptyCopy = filteredEmptyCopy(activeTab, searchQuery)

    /**
     * 列表的 ↑↓ 键盘移动（H6「行可聚焦，↑↓ 移动」）。
     *
     * 行列元素由 DOM 顺序决定，而不是拿 `filteredSchedules` 的下标去查——两者本该一致，
     * 但 DOM 顺序是**看得到的真相**：万一渲染与数据错位，移动的仍然是用户眼前的那一行。
     * 事件从行本体冒泡上来，故先确认事件确实起自某一行（行内动作按钮上的方向键不参与）。
     */
    const listRef = useRef<HTMLDivElement | null>(null)
    const handleListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const rows = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>('[data-name="schedule-dialog-row"]') ?? [],
        )
        const current = (e.target as HTMLElement).closest?.('[data-name="schedule-dialog-row"]') as HTMLElement | null
        if (!current) return
        const idx = rows.indexOf(current)
        if (idx === -1) return
        const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1
        // 首/尾不越界：焦点留在原地，而不是绕回另一端（长列表里绕回是「走丢」）
        if (nextIdx < 0 || nextIdx >= rows.length) return
        e.preventDefault()
        rows[nextIdx].focus()
    }, [])

    // ─── 渲染 ─────────────────────────────────────────

    return (
        <div className="flex flex-col h-full min-h-[400px]">
            {/* ── 筛选行即统计行：同一维度只有一套枚举名，计数与筛选同源 ── */}
            <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-[var(--border-muted)]">
                {SCHEDULE_LIST_TABS.map(tab => {
                    const isActive = activeTab === tab.key
                    const count = filterCounts[tab.key]
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setActiveTab(tab.key)}
                            aria-pressed={isActive}
                            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                                isActive
                                    ? 'bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] text-[var(--text-primary)] font-medium'
                                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                            }`}
                            data-name="schedule-dialog-tab-button"
                        >
                            {tab.label}
                            {/* 零值不着色：计数一律中性文字色（「失败」tab 已移除，不再有危险着色维度） */}
                            <span
                                data-name={`schedule-dialog-tab-count-${tab.key}`}
                                className="ml-1 text-[var(--text-muted)]"
                            >
                                {count}
                            </span>
                        </button>
                    )
                })}
                <div className="flex-1"/>
                {/* 「系统任务」tab 只读：系统任务由出厂定义，不提供新建入口 */}
                {activeTab !== 'system' && (
                <button
                    onClick={handleNew}
                    className="px-3 py-1.5 text-xs font-medium rounded-md
                             bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--text-primary)]
                             hover:bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] transition-colors"
                 data-name="schedule-dialog-new-button">
                    新建
                </button>
                )}
            </div>

            {/* ── 搜索条 ── */}
            <div className="px-4 py-2 border-b border-[var(--border-muted)]">
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
                        aria-label="搜索定时任务"
                        className={`w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md
                                 text-[var(--text-primary)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                    data-name="schedule-dialog-input"/>
                </div>
            </div>

            {/* ── 任务列表（三态齐备：加载中 / 失败 / 空，空又分两义） ── */}
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <ScheduleListLoading/>
                ) : error ? (
                    <ScheduleListError error={error} onRetry={reload}/>
                ) : schedules.length === 0 ? (
                    <ScheduleEmptyState
                        title="还没有定时任务"
                        hint="定时任务会按你设定的时间自动执行 Agent、Skill、Command 或脚本，执行情况都能在这里查看。"
                        actionLabel="新建定时任务"
                        actionName="schedule-dialog-empty-new-button"
                        onAction={handleNew}
                        variant="primary"
                    />
                ) : filteredSchedules.length === 0 ? (
                    <ScheduleEmptyState
                        title={emptyCopy.title}
                        hint={emptyCopy.hint}
                        actionLabel="查看全部任务"
                        actionName="schedule-dialog-empty-clear-filter-button"
                        onAction={handleClearFilters}
                        variant="ghost"
                    />
                ) : (
                    <div className="py-1" ref={listRef} onKeyDown={handleListKeyDown} data-name="schedule-dialog-list">
                        {filteredSchedules.map(schedule => {
                            const isExpanded = expandedScheduleId === schedule.id
                            return (
                                <div key={schedule.id}>
                                    <ScheduleCard
                                        schedule={schedule}
                                        isRunning={runningTasks.has(schedule.id)}
                                        searchQuery={searchQuery}
                                        onEdit={() => handleEdit(schedule)}
                                        onDelete={() => handleDelete(schedule)}
                                        onToggleRun={() => handleToggleRun(schedule)}
                                        onTogglePause={() => handleTogglePause(schedule)}
                                        onToggleExpand={() => handleToggleExpand(schedule.id)}
                                        onToggleEnabled={() => handleToggleEnabled(schedule)}
                                        isExpanded={isExpanded}
                                        workspaceHealth={workspaceHealth?.[schedule.id]}
                                        isDrifted={driftMap?.[schedule.id]?.drifted ?? true}
                                        isSystem={schedule.isSystem}
                                        onRestoreDefault={() => handleRestoreDefault(schedule.id)}
                                    />
                                    {isExpanded && (
                                        <ScheduleConversationsPanel
                                            scheduleId={schedule.id}
                                            taskType={schedule.taskType}
                                        />
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
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
                    onClose={handleCloseEdit}
                    penetrable={true}
                    isSystem={editingSchedule?.isSystem === true}
                />
            )}
            {/* ── 系统任务禁用确认：禁用「记忆沉淀」会同步关闭记忆功能，先问一句 ── */}
            <ScheduleDisableConfirm
                open={disableConfirmSchedule !== null}
                onConfirm={() => disableConfirmSchedule && void handleConfirmDisable(disableConfirmSchedule)}
                onCancel={handleCancelDisable}
            />
            {/* ── 写操作失败回声（六条写路径共用；新建/编辑另在弹窗内呈现）──
                Toast 自带 role="alert"，读屏软件会播报（契约 H6） */}
            {writeError && (
                <Toast message={writeError} type="error" onClose={() => setWriteError(null)} />
            )}
        </div>
    )
}
