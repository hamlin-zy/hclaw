/**
 * ScheduleUtils — 定时任务窗口共享的纯函数与令牌表（ui-02 组件拆分）
 *
 * 从 ScheduleDialog.tsx 抽出：原先定义在组件体内、每次渲染都重建的常量表
 * （配置态 chip、执行结果圆点色、任务类型标签/配色）在此提升为模块级单例，并全部改用
 * `globals.css` 的语义令牌 —— 组件内不再出现十六进制字面量与 Tailwind 原生调色板类名
 * （设计契约 C5：色值唯一来源是 CSS 变量）。
 *
 * ui-06 重构后删除了旧的「单一状态」表（`STATUS_CONFIG` / `getScheduleStatus` /
 * `getStatusDotClass` / `getStatusLabel` / `getLastRunStatusLabel` / `getLastRunStatusClass`）：
 * 它把 `running` 映射到 `--info` 且标签口径为「运行正常 / 禁用」，与新的
 * 「配置态（C3）」+「执行结果（C1，running 用 `--brand-primary`）」双载体口径直接冲突，
 * 留着就是一份会静默违反 C1/C6 的第二真相。
 *
 * 本文件是纯模块（无 JSX），供 ScheduleDialog / ScheduleCard 共用。
 */

import type {ScheduleUI} from '../../stores/scheduleStore'
import type {ScheduleRunStatus} from '@shared/types/schedule'
import type {ScheduleWorkspaceHealth, ScheduleWorkspaceState} from '@shared/types/scheduleWorkspace'

// ─── 配置态（C3）：启用 / 已暂停 / 已禁用 ─────────────

/**
 * 配置态三值。与「执行结果」是两个互不重复的载体：
 * 配置态回答「这个任务该不该跑」，执行结果回答「上一次跑成什么样」。
 *
 * 口径（enabled=false 且 paused=true 同时出现）：**禁用优先**——
 * 「禁用」是「这个任务不该存在」这一层更重的意思，暂停是「先别跑、配置都留着」。
 * 两者都真时对外只呈现「已禁用」，避免同一行出现两个语义相邻的 chip；
 * 暂停标记不会丢：恢复入口仍按 `paused` 呈现（见 `getPauseActionLabel`）。
 */
export type ScheduleConfigState = 'enabled' | 'paused' | 'disabled'

export function getConfigState(schedule: Pick<ScheduleUI, 'enabled' | 'paused'>): ScheduleConfigState {
    if (!schedule.enabled) return 'disabled'
    if (schedule.paused) return 'paused'
    return 'enabled'
}

/**
 * 配置态 chip 的文案与**唯一一处**配色。
 *
 * 契约 C3：启用是默认事实不给颜色（`--text-secondary`）；暂停是唯一需要被注意的
 * 配置偏离，允许 `--warning` 作填充（底 `--warning-muted` + 边 `--warning`）；
 * 禁用落 `--text-muted`。「暂停」与「禁用」同时用**文案**区分（「已暂停」≠「已禁用」），
 * 不靠颜色。这里的小字只用文字级令牌，`--warning` 仅作边框/底色（C2/C7 不禁其非文字用法）。
 */
const CONFIG_CHIP: Record<ScheduleConfigState, { label: string; className: string }> = {
    enabled: {
        label: '启用',
        className: 'bg-[var(--surface-muted)] border-[var(--border)] text-[var(--text-secondary)]',
    },
    paused: {
        label: '已暂停',
        className: 'bg-[var(--warning-muted)] border-[var(--warning)] text-[var(--text-secondary)]',
    },
    disabled: {
        label: '已禁用',
        className: 'bg-[var(--surface-muted)] border-[var(--border)] text-[var(--text-muted)]',
    },
}

export function getConfigChip(state: ScheduleConfigState): { label: string; className: string } {
    return CONFIG_CHIP[state]
}

/** 暂停/恢复动作的可读名（也是按钮的 `aria-label`）：暂停态只给「恢复」入口，反之亦然。 */
export function getPauseActionLabel(paused: boolean): string {
    return paused ? '恢复' : '暂停'
}

// ─── 工作目录（不可用 = 任务跑不起来） ──────────────

/** 健康度缺省值：拿不到判定结果时按「可用」呈现，不制造假故障、不禁用按钮。 */
export const WORKSPACE_HEALTH_OK: ScheduleWorkspaceHealth = {state: 'ok', path: null, reason: null}

/**
 * 只有这一态允许任务跑（与主进程的拦截口径一致，见 src/main/scheduler/scheduleWorkspace.ts）。
 * 判定本身不在这里做 —— 这里只读主进程给的结果，渲染层不造第二真相。
 */
export function isWorkspaceRunnable(health: ScheduleWorkspaceHealth | undefined): boolean {
    return (health?.state ?? 'ok') === 'ok'
}

/**
 * 行内「工作目录」标记的文案与**唯一一处**配色。
 *
 * 契约约束（逐条对上）：
 * - C2：危险小字只允许 `--text-danger`；底色走 `--error-muted`（语义色是给底色/粗线用的，
 *   不得当 ≤14px 文字色），并且只授权了「`--error-muted` 作底 + `--text-danger` 作文字」
 *   这一种组合 —— **没有**授权 `--error` 作边框，故描边回到中性 `--border`。
 * - C3：这是「配置异常」而非执行结果，故不挪用状态色当文字色。
 * - C6：同一事实只有这一处彩色载体（「立即执行」禁用只是交互态，不上色）。
 * - D1：字号沿用本窗口既有徽标档 `text-2xs`(10/14)。
 * 四态文案各自可辨，不合并成一句笼统的「有问题」。
 */
const WORKSPACE_BADGE_CLASS = 'bg-[var(--error-muted)] border-[var(--border)] text-[var(--text-danger)]'

const WORKSPACE_CHIP_LABEL: Record<Exclude<ScheduleWorkspaceState, 'ok'>, string> = {
    unset: '未设置工作目录',
    missing: '工作目录失效',
    unavailable: '工作目录不可用',
}

/** 行内标记；可用（或拿不到判定）时返回 null —— 不渲染、不占位 */
export function getWorkspaceChip(
    health: ScheduleWorkspaceHealth | undefined,
): {label: string; className: string} | null {
    const state = health?.state ?? 'ok'
    if (state === 'ok') return null
    return {label: WORKSPACE_CHIP_LABEL[state], className: WORKSPACE_BADGE_CLASS}
}

/**
 * 「立即执行 / 停止」按钮的可访问名。
 * 禁用原因必须能被读屏软件读出（只靠视觉等于没有），故把它写进按钮名里。
 *
 * **正在运行的任务永远给「停止」入口**：工作目录失效只该拦「立即执行」（跑起来这件事），
 * 不该连「让它停下来」一起砍掉 —— 任务在目录尚可用时启动、运行中目录被删，用户更需要
 * 停掉它。原先 isRunning 走在 runnable 判定之后，失效 + 运行中会返回
 * 「立即执行不可用：…」，用户就再也点不到「停止」了。
 */
export function getRunActionLabel(
    isRunning: boolean,
    health: ScheduleWorkspaceHealth | undefined,
): string {
    if (isRunning) return '停止'
    if (isWorkspaceRunnable(health)) return '立即执行'
    // 兜底原因用「不改变」的措辞：拿不到 reason 时也不能给出一个空的可访问名
    const reason = health?.reason || '工作目录不可用'
    return `立即执行不可用：${reason}`
}

// ─── 工作目录选择（弹窗下拉 + 保存校验的唯一判定口径） ──────

/**
 * 保存/展示用的工作目录判定四态。
 *
 * 与行内健康度的四态**不是**同一件事：那边问「这条任务跑得起来吗」（主进程判定），
 * 这边问「用户在下拉里选的这个值，现在能不能存下去」。故本类型只在渲染层成立。
 */
export type WorkspaceSelectionStatus = 'ok' | 'unset' | 'invalid' | 'unready'

export interface WorkspaceSelectionVerdict {
    status: WorkspaceSelectionStatus
    /** 用户可读的原因；status 为 ok 时为 null。弹窗内联提示与保存拦截**取的是同一句**。 */
    message: string | null
}

/** 工作区列表的取回状态（`ready: false` = 尚未取回 / 取数失败） */
export interface WorkspaceListSnapshot {
    ready: boolean
    ids: readonly string[]
}

export const WORKSPACE_LIST_UNREADY_MESSAGE = '工作区列表尚未就绪（或加载失败），无法校验工作目录'
export const WORKSPACE_UNSET_MESSAGE = '请选择工作目录'
export const WORKSPACE_INVALID_MESSAGE = '工作目录已失效，请重新选择一个现存的工作目录'

/**
 * 判定「当前 workspaceId + 工作区列表」这一对事实，得出唯一结论。
 *
 * 这是弹窗内联提示与保存校验**共用**的那一处判定（票 11 复核 B1：此前是两份独立实现，
 * 一份有 length 守卫、一份没有，于是同屏能出现「已失效」与「放行」两个相反结论）。
 *
 * 三态口径（缺一不可）：
 * - 列表**已取回且命中** → ok，可保存；
 * - 列表**已取回但未命中** → invalid，拦下并说「已失效，请重新选择一个现存的工作目录」；
 * - 列表**未取回 / 取数失败 / 空表** → unready，**拦下**（手里没有列表就断言某个 id 失效是
 *   假结论，放行则是拿未校验的 id 落库 —— 两种都不行），并说「无法校验」+ 由调用方给出重试入口。
 *
 * 空表与未取回同档是刻意的：一条工作区都没有时，任何 id 都不可能「现存」。
 */
export function checkWorkspaceSelection(
    workspaceId: string | null | undefined,
    list: WorkspaceListSnapshot,
): WorkspaceSelectionVerdict {
    if (!list.ready || list.ids.length === 0) {
        return {status: 'unready', message: WORKSPACE_LIST_UNREADY_MESSAGE}
    }
    if (!workspaceId) return {status: 'unset', message: WORKSPACE_UNSET_MESSAGE}
    if (!list.ids.includes(workspaceId)) {
        return {status: 'invalid', message: WORKSPACE_INVALID_MESSAGE}
    }
    return {status: 'ok', message: null}
}

// ─── 执行结果（C1）：成功 / 失败 / 运行中 / 未执行 ──────

/**
 * 执行结果四值。这是**唯一**由状态色表达的事实：
 * 成功 `--success`、失败 `--error`、运行中 `--brand-primary`（作填充/圆点），未执行落中性。
 */
export type RunResultState = 'running' | 'success' | 'failure' | 'none'

export function getRunResultState(
    status: ScheduleRunStatus | null | undefined,
    isRunning: boolean,
): RunResultState {
    if (isRunning || status === 'running') return 'running'
    if (status === 'success') return 'success'
    if (status === 'failure') return 'failure'
    return 'none'
}

/**
 * 执行结果圆点的填充类名（状态色唯一的载体）。
 * 运行中用 `--brand-primary` **静态**填充：契约 M3 禁止列表行内的持续循环动画
 * （含 `animate-pulse`），运行中状态由静态色 + 文案（「运行中」）表达。
 */
const RUN_RESULT_DOT: Record<RunResultState, string> = {
    running: 'bg-[var(--brand-primary)]',
    success: 'bg-[var(--success)]',
    failure: 'bg-[var(--error)]',
    none: 'bg-[var(--text-muted)]',
}

export function getRunResultDotClass(state: RunResultState): string {
    return RUN_RESULT_DOT[state]
}

/** 执行结果的文案（与圆点同处一处，不再另置彩色徽标——C6 禁同一事实两处彩色载体）。 */
export function getRunResultLabel(state: RunResultState): string {
    switch (state) {
        case 'running':
            return '运行中'
        case 'success':
            return '成功'
        case 'failure':
            return '失败'
        default:
            return '未执行'
    }
}

// ─── 任务类型徽标 ─────────────────────────────────────

export const TASK_TYPE_LABEL: Record<string, string> = {
    agent: 'Agent',
    skill: 'Skill',
    command: 'Command',
    script: 'Script',
}

/**
 * 任务类型徽标配色。
 *
 * 四类任务需要一个「类别色」而非「状态色」——不能挪用 --success/--error/--warning
 * （设计契约 C1：状态色只管执行结果）。`globals.css` 里唯一的类别色族是 --ft-*
 * （code 蓝 / test 绿 / style 青 / markup 橙 / data 紫 / image 玫），它按主题逐一定义、
 * 且被 `scripts/audit-contrast.mjs` 当**文字级**令牌门禁（四主题 ≥4.5:1），
 * 故按色相就近取用：agent→紫(data)、skill→青(style)、command→橙(markup)、script→玫(image)。
 * 徽标底色沿用 `color-mix … 10%` 的既有 wash 写法（对齐 SkillsDialog 等已收敛文件）。
 */
export const TASK_TYPE_CLASS: Record<string, string> = {
    agent: 'bg-[color-mix(in_srgb,var(--ft-data)_10%,transparent)] text-[var(--ft-data)]',
    skill: 'bg-[color-mix(in_srgb,var(--ft-style)_10%,transparent)] text-[var(--ft-style)]',
    command: 'bg-[color-mix(in_srgb,var(--ft-markup)_10%,transparent)] text-[var(--ft-markup)]',
    script: 'bg-[color-mix(in_srgb,var(--ft-image)_10%,transparent)] text-[var(--ft-image)]',
}

/** 未知任务类型的兜底配色（原 bg-gray-500/10 text-gray-400） */
export const TASK_TYPE_CLASS_FALLBACK =
    'bg-[color-mix(in_srgb,var(--text-muted)_10%,transparent)] text-[var(--text-muted)]'

// ─── 时间 ─────────────────────────────────────────────

export const pad = (n: number) => String(n).padStart(2, '0')

export function formatTime(ts: number | null | undefined): string {
    if (!ts) return '-'
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - d.getTime()

    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`

    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}