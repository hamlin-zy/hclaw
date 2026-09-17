/**
 * ScheduleCard — 定时任务列表的行卡片（ui-02 组件拆分）
 *
 * 从 ScheduleDialog.tsx 抽出：只负责单行的展示 + 交互回调上抛，
 * 不持有任何列表状态（状态由 useScheduleListState 持有，经 props 传入）。
 * 组件体内不再定义任何常量表，配色一律取自 ScheduleUtils 的语义令牌表。
 *
 * ui-06 重构后的行内载体分工（设计契约 C1/C3/C6/D2/M3）：
 * - **配置态**只有一个中性偏色的 chip（启用 / 已暂停 / 已禁用），文案区分，只有暂停带色；
 * - **执行结果**只有一处彩色载体：一个状态色圆点 + 文案（运行中/成功/失败/未执行）；
 * - 类型徽标只出现一次（原实现名称行与第二行各渲染一次，属 D2 违规）；
 * - 列表行内不再出现 cron 表达式原文，改为 `describeCron` 的人话摘要（H3）；
 * - 行可聚焦，鼠标点击展开执行记录；键盘 Enter = 编辑（H6）。展开状态的 `aria-expanded`
 *   落在行内「执行记录」按钮上，**不在行本体上**（A6：行本体上「点=展开 / Enter=编辑」
 *   与 disclosure 语义自相矛盾，读屏用户按 Enter 拿不到它承诺的展开）。
 */

import React from 'react'
import type {ScheduleUI} from '../../stores/scheduleStore'
import {Switch} from '../common/Switch'
import type {ScheduleWorkspaceHealth} from '@shared/types/scheduleWorkspace'
import {describeCron} from './scheduleCron'
import {
    TASK_TYPE_CLASS,
    TASK_TYPE_CLASS_FALLBACK,
    TASK_TYPE_LABEL,
    WORKSPACE_HEALTH_OK,
    formatTime,
    getConfigChip,
    getConfigState,
    getPauseActionLabel,
    getRunActionLabel,
    getRunResultDotClass,
    getRunResultLabel,
    getRunResultState,
    getWorkspaceChip,
    isWorkspaceRunnable,
} from './ScheduleUtils'

/**
 * 行内动作按钮（暂停 / 立即执行 / 执行记录 / 编辑 / 删除）的公共静态基类。
 *
 * 只抽**对所有按钮、所有状态都恒成立**的那部分，且**刻意不含文字色与任何 hover 态**，
 * 理由是等价性（同名属性规则的胜出者由 Tailwind 生成表顺序决定，不由书写顺序决定）：
 *   - `hover:text-[var(--text-primary)]`（暂停 / 立即执行 / 执行记录 / 编辑）与删除键的
 *     `hover:text-[var(--text-danger)]` 是同名属性规则，写进基类会改变胜出者；
 *   - 文字色同理：「执行记录」按钮**展开态**取 `--text-primary`、收起态取 `--text-muted`，
 *     基类若写死 `--text-muted`，展开态就会多出一条同属性规则，胜负同样不再确定。
 * 故文字色与 hover 态一律留在各按钮自己的 class 里，基类只收敛三者公共的静态部分，
 * 保证每个按钮最终的 class token 集合与收敛前**逐一相同**。
 */
const ROW_ACTION_BTN = 'p-1.5 rounded transition-colors'

/** 高亮文本中的搜索关键词 */
function highlightText(text: string, query: string): React.ReactNode {
    if (!query.trim()) return text
    const q = query.trim()
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx === -1) return text
    return (
        <>
            {text.slice(0, idx)}
            <span className="bg-[var(--warning-muted)] text-[var(--text-primary)] rounded px-0.5">
                {text.slice(idx, idx + q.length)}
            </span>
            {text.slice(idx + q.length)}
        </>
    )
}

export interface ScheduleCardProps {
    schedule: ScheduleUI
    /** 本地/后端判定为「正在跑」——决定按钮是「停止」还是「立即执行」 */
    isRunning: boolean
    searchQuery: string
    onEdit: () => void
    onDelete: () => void
    onToggleRun: () => void
    onTogglePause: () => void
    onToggleEnabled: () => void
    onToggleExpand: () => void
    /** 该行是否已展开执行记录（同一时刻全局只有一行为真） */
    isExpanded: boolean
    /**
     * 该任务的工作目录健康度（主进程判定，见 src/main/scheduler/scheduleWorkspace.ts）。
     * 缺省按「可用」处理：拿不到判定时不显示失效标记、不禁用「立即执行」，
     * 免得把一次取数失败演成用户看得见的假故障。
     */
    workspaceHealth?: ScheduleWorkspaceHealth
}

export default function ScheduleCard({
                                         schedule,
                                         isRunning,
                                         searchQuery,
                                         onEdit,
                                         onDelete,
                                         onToggleRun,
                                         onTogglePause,
                                         onToggleEnabled,
                                         onToggleExpand,
                                         isExpanded,
                                         workspaceHealth = WORKSPACE_HEALTH_OK,
                                     }: ScheduleCardProps) {
    const configState = getConfigState(schedule)
    const configChip = getConfigChip(configState)
    const runState = getRunResultState(schedule.lastRunStatus, isRunning)
    const runDotClass = getRunResultDotClass(runState)
    const runLabel = getRunResultLabel(runState)
    const runTime = formatTime(schedule.lastRunAt)

    const taskTypeClass = TASK_TYPE_CLASS[schedule.taskType] || TASK_TYPE_CLASS_FALLBACK
    const taskTypeLabel = TASK_TYPE_LABEL[schedule.taskType] || schedule.taskType

    // 暂停 / 恢复入口只在「启用」时给出（禁用优先的口径，见 ScheduleUtils.getConfigState）：
    // 禁用态行内已呈现「已禁用」，此时再给「恢复」会与禁用语义同框且点了看不到可见变化；
    // 用户重新启用后「恢复」自然出现（paused 标记不丢）。
    const pauseLabel = getPauseActionLabel(schedule.paused)
    const showPauseAction = schedule.enabled

    // 工作目录不可用 ⇒ 跑不起来（cron 到点与「立即执行」都拦）。
    // 行内给一个标记说明现状，「立即执行」禁用并把原因写进可访问名（只靠视觉等于没说）。
    const workspaceChip = getWorkspaceChip(workspaceHealth)
    const workspaceRunnable = isWorkspaceRunnable(workspaceHealth)
    const runActionLabel = getRunActionLabel(isRunning, workspaceHealth)

    return (
        <div className={`mx-1 rounded-md transition-colors ${
            isExpanded ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]'
        }`}>
            <div className="flex items-start gap-3 px-3 py-2">
                {/*
                  行本体：可聚焦，鼠标点击 = 展开执行记录，键盘 Enter = 编辑（H6）。
                  用原生 button 而非 div+role，保证 Tab 序与读屏语义；动作按钮是它的兄弟节点，
                  不嵌套在 button 内（避免 interactive 元素嵌套）。

                  **不设 `aria-expanded`**（ui-09 复核整改 · A6）：同一元素上鼠标点击是「展开」、
                  键盘 Enter 是「编辑」，而 `aria-expanded` 声明的是 disclosure 控件——读屏用户
                  按 Enter 拿不到它承诺的展开，语义自相矛盾。H6 明文要求「Enter 编辑」，故保留
                  Enter=编辑，展开状态的声明**完全交给行内「执行记录」按钮**（它带
                  `aria-expanded` + 「展开/收起执行记录」可访问名，是唯一自洽的 disclosure 入口）。

                  **不设 `aria-label`**（H2）：`aria-label` 会覆盖由内容推导的可访问名，读屏聚焦该行时
                  将只听到任务名、听不到配置态 / 上次执行结果 + 相对时间 / 人话频率摘要。可访问名直接由
                  行内可见内容合成（状态色点是纯装饰，已 `aria-hidden`，不参与命名）。
                */}
                <button
                    type="button"
                    onClick={onToggleExpand}
                    onKeyDown={e => {
                        // Enter = 编辑（H6）。行本体原先把 Enter 当「展开」用；展开已由行内
                        // 「执行记录」按钮（aria-expanded）承担，键盘能力只增不减。
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            onEdit()
                        }
                    }}
                    className="flex-1 min-w-0 text-left bg-transparent border-none p-0 cursor-pointer rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand-primary)]"
                    data-name="schedule-dialog-row">
                    {/* 第一行：名称 + 类型徽标（仅此一处）+ 配置态 chip */}
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                            {highlightText(schedule.name, searchQuery)}
                        </span>
                        <span className={`text-2xs px-1 py-0.5 rounded shrink-0 ${taskTypeClass}`}>
                            {taskTypeLabel}
                        </span>
                        <span
                            className={`text-2xs px-1.5 py-0.5 rounded border shrink-0 ${configChip.className}`}
                            data-name="schedule-dialog-config-chip">
                            {configChip.label}
                        </span>
                        {/*
                          工作目录失效标记：与配置态 chip 同一徽标位（D2：不新开第三行）。
                          它是「跑不起来」这一事实的唯一彩色载体（C6）。
                        */}
                        {workspaceChip && (
                            <span
                                className={`text-2xs px-1.5 py-0.5 rounded border shrink-0 ${workspaceChip.className}`}
                                data-name="schedule-dialog-workspace-chip">
                                {workspaceChip.label}
                            </span>
                        )}
                    </div>

                    {/* 第二行：上次执行结果（色点 + 文案）+ 相对时间 + 人话频率摘要 + 执行次数
                        窄宽度下这一行的定宽片段会超过可用宽度 —— 用 overflow-hidden 就地裁掉，
                        而不是让整行把列表撑出**横向滚动条**（X8：窄宽度只降级，不出横向滚动）。 */}
                    <div
                        className="flex items-center gap-2 mt-1 text-xs text-[var(--text-secondary)] overflow-hidden"
                        data-name="schedule-dialog-meta">
                        <span className="inline-flex items-center gap-1 shrink-0">
                            <span
                                className={`inline-block w-1.5 h-1.5 rounded-full ${runDotClass}`}
                                aria-hidden="true"
                            />
                            上次: <span>{runLabel}</span>
                        </span>
                        <span className="shrink-0">{runTime}</span>
                        <span className="shrink-0 text-[var(--text-muted)]">·</span>
                        <span className="shrink-0" data-name="schedule-dialog-frequency">
                            {describeCron(schedule.cronExpression)}
                        </span>
                        <span className="shrink-0 text-[var(--text-muted)]">·</span>
                        <span className="shrink-0">执行 {schedule.runCount} 次</span>
                        <span className="shrink-0 text-[var(--text-muted)]">·</span>
                        <span className="truncate">{highlightText(schedule.taskTarget, searchQuery)}</span>
                    </div>
                </button>

                {/* 操作按钮 */}
                <div className="flex items-center gap-0.5 flex-shrink-0 pt-0.5">
                    {/* 启用/禁用开关（交互控件，按 C6 不计入「彩色载体」） */}
                    <Switch
                        checked={schedule.enabled}
                        onChange={(checked) => checked !== schedule.enabled && onToggleEnabled()}
                        ariaLabel={schedule.enabled ? '禁用' : '启用'}
                    />

                    {/* 暂停 / 恢复（暂停态必须同时有恢复入口） */}
                    {showPauseAction && (
                        <button
                            type="button"
                            onClick={onTogglePause}
                            className={`${ROW_ACTION_BTN} text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--warning-muted)]`}
                            title={pauseLabel}
                            aria-label={pauseLabel}
                            data-name="schedule-dialog-pause-button">
                            {schedule.paused ? (
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                            ) : (
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                    <rect x="6" y="5" width="4" height="14"/>
                                    <rect x="14" y="5" width="4" height="14"/>
                                </svg>
                            )}
                        </button>
                    )}

                    {/* 立即执行 / 停止 —— 名实相符。
                        工作目录不可用时禁用「立即执行」：cron 到点会被主进程拦下，手动这条路
                        也必须一致，否则用户点得到、跑不动，还以为是「点了没反应」。
                        **但正在运行的任务不受此限**：失效只该拦「跑起来」，不该连「停下来」一起
                        砍掉 —— 任务正常运行中目录被删，用户更需要能停掉它（票 11 复核 S3）。
                        禁用原因写进 title 与 aria-label（两者都真实承载原因，不靠视觉表达）。 */}
                    <button
                        type="button"
                        onClick={onToggleRun}
                        disabled={!workspaceRunnable && !isRunning}
                        className={`${ROW_ACTION_BTN} text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] disabled:opacity-40 disabled:cursor-not-allowed`}
                        title={runActionLabel}
                        aria-label={runActionLabel}
                        data-name="schedule-dialog-toggle-run-button">
                        {isRunning ? (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <rect x="6" y="6" width="12" height="12"/>
                            </svg>
                        ) : (
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        )}
                    </button>

                    {/* 执行记录（与行本体同义；显式的可点图标，两者共用一个 aria-expanded 状态） */}
                    <button
                        type="button"
                        onClick={onToggleExpand}
                        className={`${ROW_ACTION_BTN} ${
                            isExpanded
                                ? 'text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]'
                        }`}
                        title="执行记录"
                        aria-label={isExpanded ? '收起执行记录' : '展开执行记录'}
                        aria-expanded={isExpanded}
                        data-name="schedule-dialog-history-button">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2" aria-hidden="true">
                            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                        </svg>
                    </button>

                    {/* 编辑 —— 暂停态仍可用 */}
                    <button
                        type="button"
                        onClick={onEdit}
                        className={`${ROW_ACTION_BTN} text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]`}
                        title="编辑"
                        aria-label="编辑"
                        data-name="schedule-dialog-edit-button">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2" aria-hidden="true">
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                        </svg>
                    </button>

                    {/* 删除 */}
                    <button
                        type="button"
                        onClick={onDelete}
                        className={`${ROW_ACTION_BTN} text-[var(--text-muted)] hover:text-[var(--text-danger)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]`}
                        title="删除"
                        aria-label="删除"
                        data-name="schedule-dialog-delete-button">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2" aria-hidden="true">
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
