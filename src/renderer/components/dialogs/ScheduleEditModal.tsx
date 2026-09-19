/**
 * ScheduleEditModal - 定时任务新建/编辑弹窗
 *
 * 特性：
 * 1. 简化为"可用能力"和"本地脚本"两种模式
 * 2. 可用能力：搜索 + 点选列表（合并 Agent/Skill/命令，去重）
 * 3. 本地脚本：输入框 + 浏览按钮 + 系统脚本类型提示
 * 4. 任务提示词替代 JSON 参数
 * 5. 小白友好 Cron 配置器（每天/每周/每月/间隔/高级）
 *    - 主路径四种说法 + 高级；原始表达式只在高级模式的输入框里出现
 *    - 折叠摘要是人话（几点/周几/几号），不与原始表达式混排
 *    - 时/分/间隔值均为可键盘输入、上下键步进的数字输入；「几号」用 1..31 的日期网格直接点
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Switch} from '../common/Switch'
import CapabilityPicker from '../common/CapabilityPicker'
import ThemedSelect from '../ThemedSelect'
import type {ThemedSelectOption} from '../ThemedSelect'
import {confirm} from '../ConfirmDialog'
import {CronMode, MONTHLY_DATES, WEEKDAY_LABELS} from './scheduleCron'
import {useScheduleFormState} from '../../hooks/useScheduleFormState'
import type {WorkspaceSelectionStatus} from './ScheduleUtils'
import type {ScheduleResult} from '@shared/types/schedule'
import {INPUT_FOCUS} from '../../lib/inputFocus'


// ─── 类型定义 ─────────────────────────────────────

export interface ScheduleFormData {
    id?: string
    name: string
    description: string
    taskType: 'agent' | 'skill' | 'command' | 'script'
    taskTarget: string
    taskPrompt: string
    cronExpression: string
    enabled: boolean
    workspaceId: string | null
}

/**
 * 保存结果：实现方（父层）**必须**返回内核的 {ok,data|error}（同步或 Promise 皆可）供弹窗回显。
 *
 * 旧契约里的 `| void` 与实现语义矛盾：返回 void 时弹窗得不到结果，`saving` 永不复位，
 * 保存按钮会永久停在「保存中…」且置灰。故此处只保留结果形状，不接受「不返回」。
 */
type SaveOutcome = ScheduleResult<unknown>

interface ScheduleEditModalProps {
    initial?: Partial<ScheduleFormData>
    /**
     * 保存。**可等待**：返回 `{ok:false,error}` 时弹窗留在原地显示原因、表单原样保留
     * （旧形状是 void，父层在发请求前就关窗，失败既无声又丢表单）。
     * 成功的关窗由父层负责——父层才持有「弹窗开关」这份状态。
     */
    onSave: (data: ScheduleFormData) => SaveOutcome | Promise<SaveOutcome>
    onClose: () => void
    penetrable?: boolean
    /**
     * 是否为系统任务（本票）：系统任务的 name / taskType / taskTarget（执行什么）由
     * 出厂定义锁定，编辑弹窗里禁用这些入口；description、cron 配置、任务提示词仍可改。
     */
    isSystem?: boolean
}

// ─── 公共样式 ─────────────────────────────────────

/** 文本输入共用非焦点类；焦点样式统一由 INPUT_FOCUS 提供（拼在标签上） */
const inputCls =
    'w-full px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border)]'

const labelCls = 'block text-[11px] font-medium text-[var(--text-muted)] mb-1'

/**
 * 「保存中」锁定的超时兜底（毫秒）。
 *
 * 依据：这条往返全程在本机进程内（渲染层 → IPC → 主进程 → SQLite 写），**不涉及网络**，
 * 正常耗时是毫秒级；把「主进程繁忙 + 磁盘队列 + IPC 排队」一并算上，可接受的量级也远在 1s 以内。
 * 取 **15s** 有两个参照：
 *   1. 与仓库既有「一次跨进程往返的最坏可接受等待」同档 —— `src/main/agent/mcp/client.ts:34`
 *      的 MCP 握手默认超时即 15s，是同一量级的跨进程调用；
 *   2. 比正常量级高两个数量级以上（不误伤冷启动 / 慢机），又低于用户开始怀疑「界面卡死了」
 *      的耐心阈值。
 * 它**不是**对内核的超时承诺（内核没有超时契约），只是解开按钮锁定的保险丝。
 */
const SAVE_TIMEOUT_MS = 15_000

/**
 * 表单控件的 id（`<label htmlFor>` ↔ 控件，H6）。
 * 弹窗同一时刻只挂一个实例，故用常量而非 useId 生成的随机串——
 * 常量让 DOM 断言（`getByLabelText`）与人工排查都能一眼对上。
 */
const FIELD_IDS = {
    name: 'schedule-edit-field-name',
    description: 'schedule-edit-field-description',
    scriptPath: 'schedule-edit-field-script-path',
    taskPrompt: 'schedule-edit-field-task-prompt',
    modeLabel: 'schedule-edit-group-mode',
    whenLabel: 'schedule-edit-group-when',
} as const

// 模块级常量表（原为组件体内每次渲染重建）
const CRON_MODE_TABS: Array<{key: CronMode; label: string}> = [
    {key: 'daily', label: '每天'},
    {key: 'weekly', label: '每周'},
    {key: 'monthly', label: '每月'},
    {key: 'interval', label: '间隔'},
    {key: 'custom', label: '高级'},
]

const INTERVAL_UNIT_OPTIONS = [
    {value: 'minutes', label: '分钟'},
    {value: 'hours', label: '小时'},
]

/**
 * 「未设置项目」占位项的 value。
 * 它只在当前任务确实没有工作目录时出现在列表里，且恒为 disabled —— 能被看见、
 * 点不动、也绝不会被选中，因此不会变成一条可选路径（旧的 `value: ''`「默认工作目录」
 * 是可以选中的，正是它把任务落到了非注册目录上）。
 */
const UNSET_WORKSPACE_PLACEHOLDER_VALUE = '__unset_workspace__'

/**
 * 禁用占位项的文案。
 *
 * `unready` 单独给一句**中性**的话是刻意的：列表没到手时无从判断某个 id 是否现存，
 * 此刻说「已失效」就是一次无依据的结论 —— 复核 R3 里合法的 `ws-1` 正是这样被显示成
 * 「工作目录已失效（原值：ws-1）」，用户既看不懂也无法反驳。
 */
function workspacePlaceholderLabel(status: WorkspaceSelectionStatus, workspaceId: string | null): string {
    if (!workspaceId) return '未设置项目'
    if (status === 'invalid') return `项目已失效（原值：${workspaceId}）`
    if (status === 'unready') return `项目待校验（原值：${workspaceId}）`
    return `未设置项目`
}


/**
 * 数字字段：原生 `type="number"` —— 键盘直接输入，↑↓ 上下键步进（step=1），
 * 输入越界时收敛到 [min, max]。时/分/日期/间隔值共用。
 */
function NumField({value, min, max, onValue, dataName, ariaLabel}: {
    value: number
    min: number
    max: number
    onValue: (n: number) => void
    dataName: string
    ariaLabel: string
}) {
    return (
        <input type="number" inputMode="numeric" min={min} max={max} step={1}
               value={value} aria-label={ariaLabel}
               onChange={e => {
                   const n = parseInt(e.target.value, 10)
                   if (Number.isNaN(n)) return
                   onValue(Math.max(min, Math.min(max, n)))
               }}
               className={`w-14 px-2 py-1 text-xs bg-[var(--surface)] rounded border border-[var(--border)] text-center text-[var(--text-primary)] ${INPUT_FOCUS}`}
               data-name={dataName}/>
    )
}

// ─── 主组件 ─────────────────────────────────────────

export function ScheduleEditModal({initial, onSave, onClose, isSystem = false}: ScheduleEditModalProps) {
    const fileInputRef = useRef<HTMLInputElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    /**
     * 写失败回声（弹窗内）：失败时留在窗前显示原因，表单内容原样保留。
     * 与列表侧走同一句式（动作名 + 可读原因），只是承载在弹窗里而非 toast ——
     * 若两处同时播报，读屏会连着念两遍同一件事。
     */
    const [saveError, setSaveError] = useState<string | null>(null)
    /** 提交中：按钮置灰并换文案，避免连点重复提交（表单内容不动） */
    const [saving, setSaving] = useState(false)
    /** 超时兜底的定时器（结果返回即清；卸载时清） */
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    /**
     * 最近一次提交的序号。迟到的结果只允许**最新一次**提交写状态：
     * 超时解锁后用户可能再点一次保存，此时上一次的 Promise 若姗姗来迟，
     * 它的回声不该盖掉新一轮的状态（也就不会出现「重复提交」式的双重回声）。
     */
    const submitSeqRef = useRef(0)

    // 卸载兜底：清掉待触发的超时定时器（不变式：卸载后不留 setTimeout）
    useEffect(() => () => {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    }, [])

    /**
     * 包一层可等待的 onSave：父层 await 到结果才决定关不关窗，
     * 这里只负责把失败原因留在弹窗内。
     *
     * 超时兜底（本票）：`onSave` 若返回一个**永不 resolve** 的 Promise，按钮会永久停在
     * 「保存中…」并置灰。超时后**只解除锁定并给一句可读回声**——不关窗（那次写到底成没成
     * 还不知道，关窗等于替用户下结论）、也不吞掉最终结果（Promise 后来 resolve/reject 仍照
     * 常处理，见下方 seq 守卫）。
     */
    const handleSubmit = useCallback(async (data: ScheduleFormData) => {
        const seq = ++submitSeqRef.current
        const action = data.id ? '编辑' : '新建'
        setSaveError(null)
        setSaving(true)

        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = setTimeout(() => {
            saveTimeoutRef.current = null
            if (seq !== submitSeqRef.current) return
            setSaving(false)
            setSaveError(`${action}超时：${SAVE_TIMEOUT_MS / 1000} 秒内未收到保存结果。弹窗未关闭，可再点一次「保存」。`)
        }, SAVE_TIMEOUT_MS)

        let outcome: SaveOutcome
        try {
            outcome = await onSave(data)
        } catch (err: unknown) {
            outcome = {ok: false, error: err instanceof Error ? err.message : String(err)}
        }

        // 已有更新的一次提交：旧结果一律不写状态（既不覆盖新回声，也不重复提交）
        if (seq !== submitSeqRef.current) return
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current)
            saveTimeoutRef.current = null
        }
        // 只有失败才回到本地状态：成功时父层已把弹窗关掉（这里再 setState 是往已卸载
        // 组件上写，白白触发一次 act 之外的状态更新）。
        // `outcome &&` 是运行期兜底：契约已要求必须返回结果对象，历史 mock/父层漏返回时
        // 不能在这里抛 TypeError。
        if (outcome && !outcome.ok) {
            setSaving(false)
            setSaveError(`${action}失败：${outcome.error || '未知错误'}`)
        }
    }, [onSave])

    // 表单状态与动作集中在 useScheduleFormState（ui-02 拆分）
    const {
        platform,
        dirty,
        name, setName,
        description, setDescription,
        taskTarget, setTaskTarget,
        taskPrompt, setTaskPrompt,
        enabled, setEnabled,
        error,
        mode,
        cron, updateCron,
        cronChangedFrom,
        cronExpanded, setCronExpanded,
        workspaceId, setWorkspaceId,
        workspaces,
        workspaceVerdict,
        retryWorkspaces,
        initializing,
        cronHuman,
        scriptTypeHint,
        handleCapabilitySelect,
        handleModeSwitch,
        applyScriptFile,
        handleSave,
    } = useScheduleFormState({initial, onSave: handleSubmit, isSystem})

    /**
     * 工作目录判定的**唯一来源**是本 hook 里的 `workspaceVerdict`（由 ScheduleUtils 的
     * checkWorkspaceSelection 算出）—— 保存校验用的是**同一个** verdict 对象，
     * 本组件只负责把它翻译成界面文字。
     *
     * 旧实现这里另写了一份 `!workspaceId || !workspaces.some(...)`，注释却自称「共用同一处」，
     * 而那是不成立的：两份独立实现一份有 length 守卫、一份没有，于是列表取数失败时
     * 同屏能出现「工作目录已失效」与「保存放行」两个相反结论（票 11 复核 B1）。
     */
    const workspaceStatus = workspaceVerdict.status
    const workspaceOptions = useMemo<ThemedSelectOption[]>(() => {
        const options: ThemedSelectOption[] = []
        // 当前值算不到「现存工作区」时，**动态插入一项禁用占位**把原值摆出来
        // （标明已失效 / 未设置 / 待校验），而不是静默显示为空。占位项恒 disabled：
        // 它是「现状说明」，不是一条可选路径。
        if (workspaceStatus !== 'ok') {
            options.push({
                value: workspaceId || UNSET_WORKSPACE_PLACEHOLDER_VALUE,
                label: workspacePlaceholderLabel(workspaceStatus, workspaceId),
                disabled: true,
            })
        }
        options.push(...workspaces.map(ws => ({value: ws.id, label: `${ws.name} (${ws.path})`})))
        return options
    }, [workspaceStatus, workspaceId, workspaces])


    /**
     * 有未保存改动时的关闭闸门（§6 #18）——Esc / 右上角 X / 底部「取消」共用它，
     * 三条路径不会再各自为政（旧实现三条都直接置位关窗，改动静默丢失）。
     */
    const promptOpenRef = useRef(false)
    const requestClose = useCallback(async () => {
        if (!dirty) {
            onClose()
            return
        }
        // 提醒框已经开着时（用户正在决定），本次 Esc 属于提醒框——ConfirmDialog 自己
        // 会把它结算成「取消」。这里若不设闸，Esc 会一层层叠出新的提醒框。
        if (promptOpenRef.current) return
        promptOpenRef.current = true
        try {
            const discard = await confirm({
                title: '放弃未保存的改动？',
                message: '这个定时任务有未保存的改动，关闭后将会丢失。',
                confirmText: '放弃改动',
                cancelText: '继续编辑',
                confirmVariant: 'warning',
            })
            if (discard) onClose()
        } finally {
            promptOpenRef.current = false
        }
    }, [dirty, onClose])

    /**
     * `saveError` 不得长期滞留：用户一旦改动**任一**表单字段，就清掉上一次的写失败回声。
     * 不这样做的话，一个历史服务端错误会永远挂在 live region 上——既不是当前事实，
     * 又会在本地校验失败时（那时 `error` 才是唯一真相）继续顶着旧文案。
     * 字段值由 useScheduleFormState 持有，故本效果只能放在它调用之后。
     */
    useEffect(() => {
        setSaveError(null)
    }, [name, description, taskTarget, taskPrompt, enabled, workspaceId, mode, cron])

    // ESC 关闭（有未保存改动时先问一句，见 requestClose）
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') void requestClose()
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [requestClose])

    // textarea 自动增高
    const autoResize = () => {
        const el = textareaRef.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = el.scrollHeight + 'px'
    }

    useEffect(autoResize, [taskPrompt])

    // 浏览文件按钮
    const handleBrowse = () => {
        fileInputRef.current?.click()
    }
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            // Electron 中 File 对象有 path 属性返回完整路径
            applyScriptFile(file as any)
        }
        // 清空 input 以允许重复选择同一文件
        e.target.value = ''
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
                 onClick={e => e.stopPropagation()} data-name="schedule-edit-modal-div">
                <div className="px-5 py-3 border-b border-[var(--border-muted)] flex items-center justify-between">
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">
                        {!initial?.id ? '新建定时任务' : '编辑定时任务'}
                    </h3>
                    {/* 纯图标按钮：名字只能来自 aria-label（`title` 是兜底、不能只靠它，H6） */}
                    <button onClick={() => void requestClose()}
                            aria-label="关闭"
                            className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]" data-name="schedule-edit-modal-button">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
                    {/* 名称 + 描述 —— 宽处并排（双栏），窄处降级为单栏（X8：只用 md: 断点） */}
                    <div className="flex flex-col md:flex-row gap-2" data-name="schedule-edit-modal-name-row">
                        <div className="flex-1 min-w-0">
                            <label htmlFor={FIELD_IDS.name} className={labelCls}>任务名称</label>
                            <input id={FIELD_IDS.name} type="text" value={name} onChange={e => setName(e.target.value)}
                                   placeholder="例如: 每日代码审查" disabled={isSystem}
                                   className={`${inputCls} ${INPUT_FOCUS} ${isSystem ? 'opacity-50 cursor-not-allowed' : ''}`} data-name="schedule-edit-modal-input"/>
                        </div>
                        <div className="flex-1 min-w-0">
                            <label htmlFor={FIELD_IDS.description} className={labelCls}>描述 <span className="opacity-60">(可选)</span></label>
                            <input id={FIELD_IDS.description} type="text" value={description} onChange={e => setDescription(e.target.value)}
                                   placeholder="简短描述" className={`${inputCls} ${INPUT_FOCUS}`} autoFocus data-name="schedule-edit-modal-description-input"/>
                        </div>
                    </div>

                    {/*
                      项目：`ThemedSelect` 是自绘控件（不是原生表单元素，`<label htmlFor>`
                      点不到它），故控件名由它自己的 `aria-label` 提供，与这里的可见文字**同字**——
                      两者一旦改字必须同时改，否则可见标签与可访问名就会说两件事。
                      这里刻意不套 `role="group" aria-labelledby`：那会让「项目」同时成为组的
                      名字和控件的名字，`getByLabelText('项目')` 会一次命中两个节点。
                    */}
                    <div>
                        <span className={labelCls}>项目</span>
                        <ThemedSelect
                            value={workspaceId || ''}
                            onChange={v => setWorkspaceId(v || null)}
                            options={workspaceOptions}
                            placeholder={isSystem ? '系统任务不区分项目' : '未设置项目（必选）'}
                            ariaLabel="项目"
                            /* 系统任务不绑定项目（spec：仅 description/cron/taskArgs 可编辑），
                               workspace 选择器与 name/taskType/taskTarget 一并锁定 */
                            /* 列表没到手时列表里空无一物，展开一个空面板没有意义 —— 置灰并把
                               注意力引到下面的重试入口。 */
                            disabled={isSystem || workspaceStatus === 'unready'}
                        />
                        {workspaceStatus === 'ok' ? (
                            <p className="mt-0.5 text-2xs text-[var(--text-secondary)]">
                                {isSystem ? '系统任务不区分项目，创建的会话归入未归属分组' : '定时任务创建的会话将归属于此项目'}
                            </p>
                        ) : (
                            <p className="mt-0.5 text-2xs text-[var(--text-secondary)]"
                               data-name="schedule-edit-modal-workspace-warning">
                                {workspaceVerdict.message}
                            </p>
                        )}
                        {/*
                          列表未就绪（尚未取回 / 取数失败 / 空表）时的**显式重试入口**（复核 B1）。
                          体例沿用列表侧失败态的 ScheduleListError：一个真实可点的原生按钮，
                          文案是动作本身。这里刻意**不**用 role="alert"：弹窗内 live region
                          全弹窗只有一处（写失败 / 本地校验那一个），再挂一个会让读屏重复播报。
                        */}
                        {workspaceStatus === 'unready' && (
                            <button
                                type="button"
                                onClick={() => void retryWorkspaces()}
                                data-name="schedule-edit-modal-workspace-retry-button"
                                className="mt-1 inline-flex items-center rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]">
                                重试加载项目列表
                            </button>
                        )}
                    </div>

                    {/* 模式选择：两个按钮是一个「组」，组名落在可见标签上 */}
                    <div role="group" aria-labelledby={FIELD_IDS.modeLabel}>
                        <span id={FIELD_IDS.modeLabel} className={labelCls}>执行什么？</span>
                        {/*
                          系统任务的「执行什么」由出厂定义锁定：两个模式按钮整体禁用并视觉降级
                          （disabled 只挡鼠标键盘，视觉降级让「点不动」可被看见）。
                        */}
                        <div className={`flex gap-2 ${isSystem ? 'opacity-50' : ''}`}>
                            <button onClick={() => handleModeSwitch('capability')} disabled={isSystem}
                                    aria-pressed={mode === 'capability'}
                                    className={`flex-1 px-3 py-2 text-xs rounded-lg border transition-colors ${isSystem ? 'cursor-not-allowed' : ''} ${
                                        mode === 'capability'
                                            ? 'bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] border-[var(--border-emphasis)] text-[var(--text-primary)] font-medium'
                                            : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                    }`} data-name="schedule-edit-modal-capability-mode-button">
                                <div className="font-medium">可用能力</div>
                                <div className="text-2xs opacity-70 mt-0.5">从 Agent / Skill / 命令中选择</div>
                            </button>
                            <button onClick={() => handleModeSwitch('script')} disabled={isSystem}
                                    aria-pressed={mode === 'script'}
                                    className={`flex-1 px-3 py-2 text-xs rounded-lg border transition-colors ${isSystem ? 'cursor-not-allowed' : ''} ${
                                        mode === 'script'
                                            ? 'bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] border-[var(--border-emphasis)] text-[var(--text-primary)] font-medium'
                                            : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                    }`} data-name="schedule-edit-modal-script-mode-button">
                                <div className="font-medium">本地脚本</div>
                                <div className="text-2xs opacity-70 mt-0.5">执行本地文件系统中的脚本</div>
                            </button>
                        </div>
                    </div>

                    {/* 可用能力 — 搜索 + 列表（系统任务锁定 taskTarget：整块只读降级） */}
                    {mode === 'capability' && (
                        <div className={isSystem ? 'pointer-events-none opacity-50' : ''} aria-disabled={isSystem}>
                            <CapabilityPicker selected={taskTarget} onSelect={handleCapabilitySelect} autoFocus={false}/>
                        </div>
                    )}

                    {/* 本地脚本 — 路径输入 + 浏览 */}
                    {mode === 'script' && (
                        <div>
                            <label htmlFor={FIELD_IDS.scriptPath} className={labelCls}>脚本路径</label>
                            <div className="flex gap-2">
                                <input id={FIELD_IDS.scriptPath} type="text" value={taskTarget} onChange={e => setTaskTarget(e.target.value)}
                                       placeholder="例如: C:\scripts\backup.ps1" disabled={isSystem}
                                       className={`flex-1 px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border)] font-mono ${INPUT_FOCUS} ${isSystem ? 'opacity-50 cursor-not-allowed' : ''}`} data-name="schedule-edit-modal-script-path-input"/>
                                <button onClick={handleBrowse} disabled={isSystem}
                                        className={`px-3 py-1.5 text-xs rounded-md bg-[var(--surface-muted)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] border border-[var(--border)] transition-colors flex-shrink-0 ${isSystem ? 'opacity-50 cursor-not-allowed' : ''}`} data-name="schedule-edit-modal-browse-button">
                                    浏览
                                </button>
                            </div>
                            <p className="mt-0.5 text-2xs text-[var(--text-secondary)]">{scriptTypeHint}</p>
                            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange}
                                   accept={platform === 'win32' ? '.bat,.ps1,.cmd,.exe' : '.sh,.zsh,.bash'} data-name="schedule-edit-modal-file-input"/>
                        </div>
                    )}

                    {/* 任务提示词 — 自动增高 */}
                    <div>
                        <label htmlFor={FIELD_IDS.taskPrompt} className={labelCls}>
                            任务提示词
                            <span className="opacity-60 font-normal ml-1">(可选)</span>
                        </label>
                        <textarea id={FIELD_IDS.taskPrompt} ref={textareaRef}
                                  value={taskPrompt}
                                  onChange={e => {
                                      setTaskPrompt(e.target.value)
                                      requestAnimationFrame(autoResize)
                                  }}
                                  placeholder={mode === 'script'
                                      ? '描述脚本的用途和预期输出（仅作记录用途）'
                                      : '告诉 AI 要做什么，例如：请对 src/main 目录下的所有 TypeScript 文件做代码审查'}
                                  className={`${inputCls} resize-none min-h-[80px] overflow-hidden ${INPUT_FOCUS}`} data-name="schedule-edit-modal-textarea"/>
                        {mode !== 'script' && (
                            <p className="mt-0.5 text-2xs text-[var(--text-secondary)]">作为 Agent 的初始指令。留空则使用能力本身的默认行为。</p>
                        )}
                    </div>

                    {/* Cron 配置 — 默认折叠 */}
                    <div role="group" aria-labelledby={FIELD_IDS.whenLabel}>
                        <span id={FIELD_IDS.whenLabel} className={labelCls}>什么时候执行？</span>
                        <button type="button"
                                onClick={() => setCronExpanded(!cronExpanded)}
                                aria-expanded={cronExpanded}
                                className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-[var(--surface-muted)] rounded-md border border-[var(--border)] hover:bg-[var(--surface)] transition-colors text-left" data-name="schedule-edit-modal-toggle-cron-button">
                            <span className="flex-1 min-w-0">
                                <span className="text-[var(--text-muted)]">频率: </span>
                                <span className="text-[var(--text-primary)] font-medium">{cronHuman}</span>
                            </span>
                            <svg className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ${cronExpanded ? 'rotate-180' : ''}`}
                                 viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M6 9l6 6 6-6"/>
                            </svg>
                        </button>

                        {cron.unrecognized && (
                            <div role="status"
                                 className="mt-1.5 flex items-start gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--surface-muted)] border border-[var(--border)] text-[11px] text-[var(--text-secondary)]"
                                 data-name="schedule-edit-modal-cron-unrecognized-notice">
                                <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                    <circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>
                                </svg>
                                {/* I-3：措辞不得说错话。真的不像四种说法（unparsed）与
                                    语义可归类但写法写不回（not-writable）是两件事，分开说。 */}
                                <span>
                                    {cron.customReason === 'not-writable'
                                        ? '这条表达式的写法没能原样对应「每天 / 每周 / 每月 / 间隔」，已按原样保留在「高级」模式；保存时不会被改写。'
                                        : '这条表达式不是标准的分 时 日 月 周 五段格式，已按原样保留在「高级」模式；保存时不会被改写。'}
                                </span>
                            </div>
                        )}

                        {/* I-1：从「高级」切走时显式告知频率已更改（原表达式仍可用「高级」页签找回） */}
                        {cronChangedFrom && (
                            <div role="status"
                                 className="mt-1.5 flex items-start gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--surface-muted)] border border-[var(--border)] text-[11px] text-[var(--text-secondary)]"
                                 data-name="schedule-edit-modal-cron-changed-notice">
                                <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                    <circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>
                                </svg>
                                {/* 只说不会说错的话：表达式能抽出的字段已填进当前模式，抽不出的保持默认，
                                    故不承诺「已按原表达式填入」，只保证原文可找回。 */}
                                <span>
                                    频率已更改（原：<span className="font-mono">{cronChangedFrom}</span>）。
                                    各字段已尽量按原表达式填入；原表达式仍可在「高级」里找回。
                                </span>
                            </div>
                        )}

                        {cronExpanded && (
                            <>
                                <div className="flex gap-1 mt-1.5 mb-2 flex-wrap">
                                    {CRON_MODE_TABS.map((tab, i) => (
                                        <button key={tab.key} type="button" onClick={() => updateCron({mode: tab.key})}
                                                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
                                                    cron.mode === tab.key
                                                        ? 'bg-[color-mix(in_srgb,var(--brand-primary)_15%,transparent)] text-[var(--text-primary)] font-medium'
                                                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--surface)]'
                                                }`} data-name={`schedule-edit-modal-cron-tab-${i}`}>
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>

                                <div className="bg-[var(--surface-muted)] rounded-md p-3 space-y-2">
                                    {cron.mode === 'daily' && (
                                        <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                            <span>每天</span>
                                            <NumField value={cron.dailyHour} min={0} max={23}
                                                      onValue={v => updateCron({dailyHour: v})}
                                                      dataName="schedule-edit-modal-daily-hour-input" ariaLabel="每天 小时"/>
                                            <span>:</span>
                                            <NumField value={cron.dailyMin} min={0} max={59}
                                                      onValue={v => updateCron({dailyMin: v})}
                                                      dataName="schedule-edit-modal-daily-minute-input" ariaLabel="每天 分钟"/>
                                        </div>
                                    )}
                                    {cron.mode === 'weekly' && (
                                        <div className="space-y-2">
                                            <div className="flex gap-1" role="group" aria-label="每周执行的星期">
                                                {WEEKDAY_LABELS.map((label, i) => (
                                                    <button key={i} type="button"
                                                            aria-pressed={cron.weeklyDays[i]} aria-label={`周${label}`}
                                                            onClick={() => {
                                                                const days = [...cron.weeklyDays]
                                                                days[i] = !days[i]
                                                                updateCron({weeklyDays: days})
                                                            }}
                                                            className={`w-7 h-7 text-xs rounded-full transition-colors ${
                                                                cron.weeklyDays[i]
                                                                    ? 'bg-[var(--brand-primary)] text-white'
                                                                    : 'bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)]'
                                                            }`} data-name={`schedule-edit-modal-weekday-${i}`}>
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                                <span>时间</span>
                                                <NumField value={cron.weeklyHour} min={0} max={23}
                                                          onValue={v => updateCron({weeklyHour: v})}
                                                          dataName="schedule-edit-modal-weekly-hour-input" ariaLabel="每周 小时"/>
                                                <span>:</span>
                                                <NumField value={cron.weeklyMin} min={0} max={59}
                                                          onValue={v => updateCron({weeklyMin: v})}
                                                          dataName="schedule-edit-modal-weekly-minute-input" ariaLabel="每周 分钟"/>
                                            </div>
                                            {cron.weeklyDays.every(d => !d) && (
                                                <p className="text-2xs text-[var(--text-secondary)]">未选任何星期时，按「每天」执行。</p>
                                            )}
                                        </div>
                                    )}
                                    {cron.mode === 'monthly' && (
                                        <div className="space-y-2">
                                            {/* I-2：每月**直接点几号** —— 日期网格覆盖 1..31。
                                                每个格子是原生 <button>，天然可聚焦 / 可 Tab / Enter·Space 激活，
                                                因此不与验收 7 的键盘要求冲突；网格是该模式选日期的唯一入口。 */}
                                            <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                                <span>每月</span>
                                                <span className="font-medium">{cron.monthlyDate} 日</span>
                                            </div>
                                            <div className="grid grid-cols-7 gap-1" role="group" aria-label="每月几号">
                                                {MONTHLY_DATES.map(d => (
                                                    <button key={d} type="button"
                                                            aria-pressed={cron.monthlyDate === d}
                                                            aria-label={`${d} 号`}
                                                            onClick={() => updateCron({monthlyDate: d})}
                                                            className={`h-7 text-xs rounded transition-colors ${
                                                                cron.monthlyDate === d
                                                                    ? 'bg-[var(--brand-primary)] text-white font-medium'
                                                                    : 'bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text-primary)]'
                                                            }`} data-name={`schedule-edit-modal-monthly-date-${d}`}>
                                                        {d}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                                <span>时间</span>
                                                <NumField value={cron.monthlyHour} min={0} max={23}
                                                          onValue={v => updateCron({monthlyHour: v})}
                                                          dataName="schedule-edit-modal-monthly-hour-input" ariaLabel="每月 小时"/>
                                                <span>:</span>
                                                <NumField value={cron.monthlyMin} min={0} max={59}
                                                          onValue={v => updateCron({monthlyMin: v})}
                                                          dataName="schedule-edit-modal-monthly-minute-input" ariaLabel="每月 分钟"/>
                                            </div>
                                            <p className="text-2xs text-[var(--text-secondary)]">每月只支持单个日期；多个日期请用「高级」表达式。</p>
                                        </div>
                                    )}
                                    {cron.mode === 'interval' && (
                                        <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                            <span>每</span>
                                            <NumField value={cron.intervalValue} min={1} max={999}
                                                      onValue={v => updateCron({intervalValue: v})}
                                                      dataName="schedule-edit-modal-interval-value-input" ariaLabel="间隔数值"/>
                                            <ThemedSelect
                                                value={cron.intervalUnit}
                                                onChange={v => updateCron({intervalUnit: v as 'minutes' | 'hours'})}
                                                options={INTERVAL_UNIT_OPTIONS}
                                                ariaLabel="间隔单位"
                                            />
                                        </div>
                                    )}
                                    {cron.mode === 'custom' && (
                                        <div>
                                            <input type="text" value={cron.customExpr}
                                                   onChange={e => updateCron({customExpr: e.target.value})}
                                                   placeholder="0 9 * * 1-5"
                                                   className={`w-full px-3 py-1.5 text-xs font-mono bg-[var(--surface)] rounded border border-[var(--border)] text-[var(--text-primary)] ${INPUT_FOCUS}`} data-name="schedule-edit-modal-custom-cron-input"/>
                                            <p className="mt-1 text-2xs text-[var(--text-secondary)]">
                                                格式: 分 时 日 月 周 &nbsp;
                                                {/* 原为可点的 <span>：键盘 Tab 到不了、读屏也不认它是控件，
                                                    换成原生 button（H6「键盘全程可用」）。 */}
                                                <button type="button"
                                                        onClick={() => window.electronAPI?.openExternal?.('https://crontab.guru/')}
                                                        className="text-[var(--text-secondary)] underline hover:text-[var(--text-primary)] bg-transparent border-none p-0 cursor-pointer" data-name="schedule-edit-modal-span">crontab.guru 查看帮助 ↗</button>
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>

                    {/* 启用 - 开关样式（可见文字即控件名：`Switch` 只收 ariaLabel） */}
                    <div className="flex items-center gap-1.5 justify-end pt-1">
                        <span className="text-xs text-[var(--text-primary)]">创建后立即启用</span>
                        <Switch checked={enabled} onChange={setEnabled} ariaLabel="创建后立即启用"/>
                    </div>

                    {/*
                      本地校验文案优先于写失败回声：校验失败时 onSave 根本不会被调用，
                      saveError 必然陈旧。若让陈旧的 saveError 顶在前面，用户看到的是错的，
                      而且 live region 文本不变 → 读屏不会重播 → 校验失败变成静默。
                    */}
                    {(error || saveError) && (
                        <div role="alert"
                             className="p-2 rounded-md bg-[var(--error-muted)] border border-[var(--error)] text-[11px] text-[var(--text-danger)]"
                             data-name="schedule-edit-modal-error">
                            {error || saveError}
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-muted)] bg-[var(--surface-muted)]">
                    {/* 初值未就绪（新建路径正在问「当前项目」）时的等待态：按钮置灰 + 说清楚在等什么
                        （复核 S1：此前按钮可点，点了却报「请选择项目」——那是用户没做过的动作）。 */}
                    {initializing && (
                        <span className="mr-auto text-2xs text-[var(--text-secondary)]"
                              data-name="schedule-edit-modal-initializing-hint">正在读取当前项目…</span>
                    )}
                    <button onClick={() => void requestClose()}
                            className="px-3 py-1.5 text-xs rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors" data-name="schedule-edit-modal-cancel-button">取消</button>
                    <button onClick={handleSave} disabled={saving || initializing}
                            className="px-4 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed" data-name="schedule-edit-modal-save-button">{saving ? '保存中…' : '保存'}</button>
                </div>
            </div>
        </div>
    )
}
