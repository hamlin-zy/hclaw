/**
 * useScheduleListState — 定时任务列表的状态与动作（ui-02 组件拆分）
 *
 * 从 ScheduleDialog.tsx 抽出：搜索词 / 状态筛选 / 运行中跟踪 / 行内展开 / 编辑弹窗
 * / 删除与立即执行等动作全部集中在此，组件退回纯视图。
 * 逻辑逐行搬自原实现，行为不变（含「运行中」复位定时器的卸载兜底）。
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {ScheduleUI, useScheduleStore} from '../stores/scheduleStore'
import {useSettingsStore} from '../stores/settingsStore'
import {confirm} from '../components/ConfirmDialog'
import type {ScheduleFormData} from '../components/dialogs/ScheduleEditModal'
import type {ScheduleRecord, ScheduleResult} from '@shared/types/schedule'
import {fuzzyFilter} from '../lib/search'

/** 列表筛选维度 —— 同时也是统计维度（筛选行即统计行） */
export type ScheduleListTab = 'user' | 'system' | 'enabled' | 'disabled'

/**
 * 筛选行/统计行的**唯一**枚举来源：key 与 label 同源，杜绝「启用/运行中」这类两套命名。
 * 顺序即展示顺序。
 *
 * 「失败」曾是第四档（2026-09-16 产品决定移除）：失败没有聚合筛选与计数的价值，
 * 按行表达即可（卡片状态圆点 + 「上次：失败」文案）。
 */
export const SCHEDULE_LIST_TABS: ReadonlyArray<{key: ScheduleListTab; label: string}> = [
    {key: 'user', label: '用户'},
    {key: 'system', label: '系统任务'},
    {key: 'enabled', label: '启用'},
    {key: 'disabled', label: '禁用'},
]

/**
 * 单个任务是否命中某个筛选维度 —— 筛选与计数**共用同一谓词**。
 *
 * 注意失败的唯一取值：`ScheduleRunStatus` 是 `'none' | 'running' | 'success' | 'failure'`，
 * 界面上曾拿 `'failed'` / `'error'` 去比，导致失败筛选、失败计数、失败状态色恒不命中。
 * 「失败」不再是一个筛选维度（见 SCHEDULE_LIST_TABS），但这条取值知识仍然有效：
 * 凡按行表达失败（状态圆点 / 「上次：失败」文案）都必须认 `'failure'`。
 */
export function matchesTab(s: ScheduleUI, tab: ScheduleListTab): boolean {
    switch (tab) {
        case 'user':
            return !s.isSystem
        case 'system':
            return s.isSystem
        case 'enabled':
            return s.enabled
        case 'disabled':
            return !s.enabled
        default:
            return true
    }
}

/**
 * 写失败回声的**唯一**格式：动作名 + 可读原因（原因直接透出内核给的 `res.error`）。
 *
 * 六条写路径（新建 / 编辑 / 启用禁用 / 删除 / 暂停恢复 / 立即执行-停止）共用它，
 * 不再各写一句临时文案。新建与编辑的失败另有弹窗内回声（见 ScheduleEditModal），
 * 那里也用同一句式样，只是承载在弹窗内而非 toast。
 */
export function formatWriteFailure(action: string, error?: string): string {
    return `${action}失败：${error || '未知错误'}`
}

/**
 * 异常 → 可读原因。
 *
 * 六条写路径的**抛异常分支**与各自的 `{ok:false}` 分支共用同一个出口
 * （`reportWriteFailure` → `formatWriteFailure` 的「失败：」句式），不再另立
 * 「异常：」一式。切换前的实况是同为「这次写没成功」却有两套措辞：删除 / 停止走
 * 「失败：」，立即执行 / 暂停 / 启用走「异常：」——同一件事在同一个 toast 位上换词，
 * 读屏用户与肉眼用户都会以为是两类问题。本函数只负责把异常压成一句可读原因。
 */
function throwReason(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

export function useScheduleListState() {
    const {schedules, loading, error, loadSchedules, create, update, delete: deleteSchedule, stop, pause, resume, runNow, restoreDefault, workspaceHealth, driftMap} =
        useScheduleStore()

    const [searchQuery, setSearchQuery] = useState('')
    const [activeTab, setActiveTab] = useState<ScheduleListTab>('user')

    // 编辑弹窗状态
    const [editModalOpen, setEditModalOpen] = useState(false)
    const [editingSchedule, setEditingSchedule] = useState<ScheduleUI | null>(null)

    // 运行中状态跟踪
    const [runningTasks, setRunningTasks] = useState<Set<string>>(new Set())

    // 行内展开的执行记录：同一时刻只允许展开一行（避免列表被撑散、滚动位置漂移）。
    // 由 Set 收敛为单个 id，`null` = 全部收起。
    const [expandedScheduleId, setExpandedScheduleId] = useState<string | null>(null)
    /**
     * 写操作失败回声的**唯一**载体（新建/编辑另在弹窗内呈现，见 ScheduleEditModal）。
     * 原先散落的 launchError 只是「立即执行」一条路径的临时 toast 变量，本票统一到此。
     */
    const [writeError, setWriteError] = useState<string | null>(null)
    /** 六条写路径共用的失败回声入口 */
    const reportWriteFailure = useCallback((action: string, error?: string) => {
        setWriteError(formatWriteFailure(action, error))
    }, [])
    // 「运行中」状态复位定时器集合：同一时刻可能有多个任务并发启动，故用 Set 记账
    const runResetTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
    // 卸载兜底：清理所有「运行中」复位定时器
    useEffect(() => () => {
        runResetTimers.current.forEach(clearTimeout)
        runResetTimers.current.clear()
    }, [])
    /** 「运行中」标记的清除出口：停止动作与复位计时器共用（纯函数式 Set 更新，无闭包依赖） */
    const clearRunning = useCallback((id: string) => {
        setRunningTasks(prev => {
            const next = new Set(prev)
            next.delete(id)
            return next
        })
    }, [])

    // 加载数据
    useEffect(() => {
        loadSchedules()
    }, [])

    // ─── 过滤逻辑（搜索是筛选行的输入，状态是筛选行的选择） ─────

    /** 搜索词命中的集合：筛选行的计数取自它，故计数与筛选结果永远一致 */
    const searchFiltered = useMemo(() => {
        if (!searchQuery.trim()) return schedules
        // 模糊子序列匹配
        return fuzzyFilter(schedules, searchQuery, ['name', 'description', 'cronExpression', 'taskTarget', 'taskType'])
    }, [schedules, searchQuery])

    /** 当前筛选维度下真正展示出来的集合 */
    const filteredSchedules = useMemo(
        () => searchFiltered.filter(s => matchesTab(s, activeTab)),
        [searchFiltered, activeTab],
    )

    // ─── 计数：与筛选同一维度、同一谓词、同一集合 ────────

    const filterCounts = useMemo(() => {
        const counts = {} as Record<ScheduleListTab, number>
        for (const tab of SCHEDULE_LIST_TABS) {
            counts[tab.key] = searchFiltered.filter(s => matchesTab(s, tab.key)).length
        }
        return counts
    }, [searchFiltered])

    // ─── 操作处理 ─────────────────────────────────────

    const handleNew = useCallback(() => {
        setEditingSchedule(null)
        setEditModalOpen(true)
    }, [])

    const handleEdit = useCallback((schedule: ScheduleUI) => {
        setEditingSchedule(schedule)
        setEditModalOpen(true)
    }, [])

    const handleCloseEdit = useCallback(() => {
        setEditModalOpen(false)
        setEditingSchedule(null)
    }, [])

    /**
     * 新建 / 编辑 —— **可等待**，且失败不关窗。
     *
     * 旧实现在发请求之前就把弹窗关了：`create` / `update` 的返回值被丢掉，
     * 失败既无声、用户刚填的表单也一起没了。现在把结果原样交回弹窗，
     * 「成功才关窗、失败留在窗前显示原因」（见 ScheduleEditModal 的 saveError）。
     * 这里不再额外 toast：弹窗内已有 role="alert" 的可读回声，重复播报反而干扰读屏。
     */
    const handleEditModalSave = useCallback(async (data: ScheduleFormData): Promise<ScheduleResult<ScheduleRecord>> => {
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

        try {
            const result = data.id ? await update(data.id, payload) : await create(payload)
            // 只有成功才关窗：失败时弹窗留在原地显示原因、用户填的内容原样保留
            if (result.ok) {
                setEditModalOpen(false)
                setEditingSchedule(null)
            }
            return result
        } catch (err: unknown) {
            return {ok: false, error: throwReason(err)}
        }
    }, [create, update])

    const handleDelete = useCallback(async (schedule: ScheduleUI) => {
        await confirm({
            title: '删除定时任务',
            message: `确定要删除定时任务"${schedule.name}"吗？\n此操作不可撤销。`,
            confirmText: '确认删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                // 桥接层抛异常也要有回声：裸 await 会让异常逃成 unhandled rejection，
                // 用户看到的只是「点了删除，什么都没发生」。
                try {
                    const result = await deleteSchedule(schedule.id)
                    if (!result.ok) reportWriteFailure('删除', result.error)
                } catch (err: unknown) {
                    reportWriteFailure('删除', throwReason(err))
                }
            },
        })
    }, [deleteSchedule, reportWriteFailure])

    /**
     * 立即执行 / 停止 —— 名实相符（设计契约 §6 #12）。
     *
     * 本地 `runningTasks` 命中「运行中」时，这个按钮的含义是**停止**：走 `store.stop`，
     * 绝不再次 `runNow`（旧实现在这条路径上重复启动，按钮 `title="停止"` 却名不副实）。
     * 非运行中才是「立即执行」，其失败提示行为保持不变。
     */
    const handleToggleRun = useCallback(async (schedule: ScheduleUI) => {
        // 运行中 → 真的是「停止」
        if (runningTasks.has(schedule.id)) {
            // 与删除同理：裸 await 会让桥接层异常逃成 unhandled rejection，用户只看到「点了没反应」
            try {
                const result = await stop(schedule.id)
                if (!result.ok) reportWriteFailure('停止', result.error)
            } catch (err: unknown) {
                reportWriteFailure('停止', throwReason(err))
            }
            clearRunning(schedule.id)
            return
        }

        // 非运行中 → 立即执行。
        // 后端仍残留 running（上次执行卡死）时先 stop 清理后端状态，再启动（既有行为不变）。
        // 这里的兜底刷新走**静默**：它是后台补扫，不该把列表换成 loading 态、丢掉滚动位置（M4）。
        if (schedule.lastRunStatus === 'running') {
            // 补扫清理后端残留 running 状态：同样不能裸 await（异常逃逸即无回声）
            try {
                await stop(schedule.id)
            } catch (err: unknown) {
                reportWriteFailure('停止', throwReason(err))
            }
            await loadSchedules({silent: true})
        }

        setRunningTasks(prev => new Set(prev).add(schedule.id))

        try {
            const result = await runNow(schedule.id)
            if (!result.ok) {
                reportWriteFailure('立即执行', result.error)
            }
        } catch (err: unknown) {
            reportWriteFailure('立即执行', throwReason(err))
        } finally {
            // 定时器只负责清本地「运行中」标记：真实状态由主进程广播 `updated`
            // 就地更新那一行，旧实现在这里再整表 loadSchedules() 会闪一下并重置滚动位置。
            const timer = setTimeout(() => {
                runResetTimers.current.delete(timer)
                clearRunning(schedule.id)
            }, 2000)
            runResetTimers.current.add(timer)
        }
    }, [stop, runNow, loadSchedules, runningTasks, reportWriteFailure, clearRunning])

    /** 行内展开/收起执行记录：同一时刻只允许展开一行。 */
    const handleToggleExpand = useCallback((scheduleId: string) => {
        setExpandedScheduleId(prev => (prev === scheduleId ? null : scheduleId))
    }, [])

    /**
     * 暂停 / 恢复 —— 一等的行内动作，与「禁用」是两个动作。
     * 失败时留下可读回声，与其余写路径共用同一个出口（本票统一后的正式机制）。
     */
    const handleTogglePause = useCallback(async (schedule: ScheduleUI) => {
        const wasPaused = schedule.paused
        const action = wasPaused ? '恢复' : '暂停'
        try {
            const result = wasPaused ? await resume(schedule.id) : await pause(schedule.id)
            if (!result.ok) reportWriteFailure(action, result.error)
        } catch (err: unknown) {
            reportWriteFailure(action, throwReason(err))
        }
    }, [pause, resume, reportWriteFailure])

    /**
     * 启用 / 禁用 —— **不做乐观翻转**：开关始终由 `schedule.enabled`（真实数据）驱动，
     * 本地不预改状态；失败时开关自然停在原位，配合可读原因，不留「以为自己点上了」的假象。
     *
     * 系统任务的禁用特殊（本票）：禁用「记忆沉淀」这类系统任务会连带关闭记忆功能，
     * 影响面超出这一行本身，故先弹确认框（ScheduleDisableConfirm），用户确认后才执行。
     */
    const handleToggleEnabled = useCallback(async (schedule: ScheduleUI) => {
        if (schedule.isSystem && schedule.enabled) {
            setDisableConfirmSchedule(schedule)
            return
        }
        const action = schedule.enabled ? '禁用' : '启用'
        try {
            const result = await update(schedule.id, {enabled: !schedule.enabled})
            if (!result.ok) reportWriteFailure(action, result.error)
        } catch (err: unknown) {
            reportWriteFailure(action, throwReason(err))
        }
    }, [update, reportWriteFailure])

    // ─── 系统任务禁用确认（记忆功能联动） ────────────────

    /** 待确认禁用的系统任务（null = 确认框关闭） */
    const [disableConfirmSchedule, setDisableConfirmSchedule] = useState<ScheduleUI | null>(null)

    const handleCancelDisable = useCallback(() => setDisableConfirmSchedule(null), [])

    /** 确认禁用：禁用任务 + 同步关闭记忆功能（记忆文件不删除，重新启用任务不自动恢复记忆开关） */
    const handleConfirmDisable = useCallback(async (schedule: ScheduleUI) => {
        setDisableConfirmSchedule(null)
        const action = '禁用'
        try {
            const result = await update(schedule.id, {enabled: false})
            if (!result.ok) {
                reportWriteFailure(action, result.error)
                return
            }
        } catch (err: unknown) {
            reportWriteFailure(action, throwReason(err))
            return
        }
        // 任务禁用成功后才动记忆开关：任务没禁掉就不该连带关功能
        try {
            await useSettingsStore.getState().updateSettings({memory: {enabled: false}})
        } catch (err: unknown) {
            reportWriteFailure('关闭记忆功能', throwReason(err))
        }
    }, [update, reportWriteFailure])

    // ─── 系统任务「还原默认」 ────────────────────────────

    /** 还原默认：把系统任务的配置恢复到出厂定义（Task 11 的 scheduler-restore-default 通道） */
    const handleRestoreDefault = useCallback(async (scheduleId: string) => {
        try {
            const result = await restoreDefault(scheduleId)
            if (!result.ok) reportWriteFailure('还原默认', result.error)
        } catch (err: unknown) {
            reportWriteFailure('还原默认', throwReason(err))
        }
    }, [restoreDefault, reportWriteFailure])

    /** 清除全部筛选（筛选后无结果时的出路），并把列表带回「用户」 */
    const handleClearFilters = useCallback(() => {
        setActiveTab('user')
        setSearchQuery('')
    }, [])

    return {
        schedules,
        loading,
        error,
        reload: loadSchedules,
        /**
         * 任务 id → 工作目录健康度（主进程唯一判定，见 src/main/scheduler/scheduleWorkspace.ts）。
         * 消费方按 id 取值时要容缺（替身 store 未必带这个字段）：取不到就当作「全部可用」，
         * 不显示失效标记、不禁用按钮（见 ScheduleCard 的默认值）。
         */
        workspaceHealth,
        /**
         * 系统任务 id → 漂移信息（主进程唯一判定，见 scheduleOps.systemScheduleDrift）。
         * 消费方按 id 取值时容缺：取不到按「已漂移」处理（还原默认按钮不禁用）。
         */
        driftMap,
        handleClearFilters,
        searchQuery,
        setSearchQuery,
        activeTab,
        setActiveTab,
        filteredSchedules,
        filterCounts,
        runningTasks,
        expandedScheduleId,
        editModalOpen,
        editingSchedule,
        writeError,
        setWriteError,
        reportWriteFailure,
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
    }
}
