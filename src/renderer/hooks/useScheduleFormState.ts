/**
 * useScheduleFormState — 定时任务新建/编辑表单的状态与动作（ui-02 组件拆分）
 *
 * 从 ScheduleEditModal.tsx 抽出：字段值、cron 配置、工作目录列表、平台探测、
 * 初始值回填、模式切换与保存组装全部集中在此，弹窗退回纯视图。
 * 逻辑逐行搬自原实现，行为不变。
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {ScheduleFormData} from '../components/dialogs/ScheduleEditModal'
import {checkWorkspaceSelection} from '../components/dialogs/ScheduleUtils'
import type {WorkspaceSelectionVerdict} from '../components/dialogs/ScheduleUtils'
import {
    CronConfig,
    CronMode,
    configToCron,
    cronToConfig,
    cronToHuman,
    makeDefaultConfig,
    seedFromCustomExpr,
} from '../components/dialogs/scheduleCron'

export type ScheduleTaskType = 'agent' | 'skill' | 'command' | 'script'
/** 表单模式：可用能力 / 本地脚本 */
export type ScheduleInputMode = 'capability' | 'script'

/**
 * `CronConfig` 的**字段级**等价判定（ui-09 复核整改 · dirty 误报）。
 *
 * 只比字段，不比对象引用：`updateCron` 每次都会 `{...prev, ...patch}` 造一个新对象，
 * 引用比较永远为假，等于没判。数组字段（`weeklyDays`）逐元素比。
 */
function sameCronConfig(a: CronConfig, b: CronConfig): boolean {
    return a.mode === b.mode
        && a.dailyHour === b.dailyHour && a.dailyMin === b.dailyMin
        && a.weeklyHour === b.weeklyHour && a.weeklyMin === b.weeklyMin
        && a.monthlyDate === b.monthlyDate && a.monthlyHour === b.monthlyHour && a.monthlyMin === b.monthlyMin
        && a.intervalValue === b.intervalValue && a.intervalUnit === b.intervalUnit
        && a.customExpr === b.customExpr
        && a.unrecognized === b.unrecognized && a.customReason === b.customReason
        && a.weeklyDays.length === b.weeklyDays.length
        && a.weeklyDays.every((d, i) => d === b.weeklyDays[i])
}

interface UseScheduleFormStateArgs {
    initial?: Partial<ScheduleFormData>
    onSave: (data: ScheduleFormData) => void
}

export function useScheduleFormState({initial, onSave}: UseScheduleFormStateArgs) {
    const [platform, setPlatform] = useState('win32')

    const [name, setNameRaw] = useState('')
    const [description, setDescriptionRaw] = useState('')
    const [taskType, setTaskType] = useState<ScheduleTaskType>('agent')
    const [taskTarget, setTaskTargetRaw] = useState('')
    const [taskPrompt, setTaskPromptRaw] = useState('')
    const [enabled, setEnabledRaw] = useState(true)
    const [error, setError] = useState<string | null>(null)
    /**
     * 「用户是否动过表单」——只由**用户交互**置位（ui-09）。
     *
     * 刻意不做「当前值 vs 初始值」的快照比对：初始化副作用会异步回填工作目录
     * （`workspace.getCurrent()`），cron 的读回也不保证等价（见 §6 #19），比对法
     * 会把「刚打开什么都没做」误判成有改动，于是关窗时无端弹提醒。这里以
     * 「setter 被调用」为准：初值回填走原始 setter（不计入），用户路径走下面
     * 的包装 setter（计入）。
     */
    const [dirty, setDirty] = useState(false)
    const touch = useCallback(() => setDirty(true), [])
    // 模式切换: 'capability' | 'script'
    const [mode, setMode] = useState<ScheduleInputMode>('capability')
    const [cron, setCron] = useState<CronConfig>(makeDefaultConfig())
    /**
     * 用户从「高级」切走时，被放下的是哪条原始表达式（I-1）。
     * 原表达式并未丢失（点回「高级」仍在输入框里），这里只是**显式告知**「频率已更改」，
     * 避免「点一下页签，原频率静默被 9:00 覆盖」而用户毫无察觉。
     */
    const [cronChangedFrom, setCronChangedFrom] = useState<string | null>(null)
    const [cronExpanded, setCronExpanded] = useState(false)
    const cronRef = useRef(cron)
    // 工作目录
    const [workspaceId, setWorkspaceIdRaw] = useState<string | null>(null)
    const [workspaces, setWorkspaces] = useState<Array<{id: string; name: string; path: string}>>([])
    /**
     * 工作区列表是否**已成功取回**（取回但为空也算已取回）。
     * 与 `workspaces` 一起构成 checkWorkspaceSelection 的输入：二者都不是布尔能表达的
     * 「列表没到手」这一态，故必须分开存。
     */
    const [workspacesReady, setWorkspacesReady] = useState(false)
    /**
     * 初值是否还在回填中（票 11 复核 S1）。
     * 新建路径要异步问一次「当前工作目录」当默认值；这一次往返没落地前点保存，会被
     * 「工作目录必填」拦下 —— 而用户根本没做过「不选目录」这个动作。故未就绪时保存按钮置灰。
     */
    const [initializing, setInitializing] = useState(true)

    // ─── 用户路径 setter（包装后才计入 dirty） ─────────────
    // 初值回填（下面的初始化副作用）与内部派生一律走 <name>Raw，不算改动。
    const setName = useCallback((v: string) => { touch(); setNameRaw(v) }, [touch])
    const setDescription = useCallback((v: string) => { touch(); setDescriptionRaw(v) }, [touch])
    const setTaskTarget = useCallback((v: string) => { touch(); setTaskTargetRaw(v) }, [touch])
    const setTaskPrompt = useCallback((v: string) => { touch(); setTaskPromptRaw(v) }, [touch])
    const setEnabled = useCallback((v: boolean) => { touch(); setEnabledRaw(v) }, [touch])
    const setWorkspaceId = useCallback((v: string | null) => { touch(); setWorkspaceIdRaw(v) }, [touch])

    // 检测平台
    useEffect(() => {
        // @ts-ignore - getPlatform is available at runtime via preload
        window.electronAPI?.getPlatform?.().then((p: string) => setPlatform(p || 'win32')).catch(() => {})
    }, [])

    /**
     * 取回工作区列表。**只有取回成功才算就绪**：桥接缺失、Promise reject、返回的不是数组，
     * 一律保持「未就绪」——手里没有列表时，工作目录一个都校验不了（票 11 复核 B1）。
     * 失败态的重试入口由弹窗提供，故这里必须是个可重复调用的回调。
     */
    const loadWorkspaces = useCallback(async () => {
        try {
            const list = await window.electronAPI?.workspace?.list?.()
            if (Array.isArray(list)) {
                setWorkspaces(list)
                setWorkspacesReady(true)
                return
            }
        } catch {
            // 静默：失败态由「未就绪 + 重试入口」承载，不在这里另造一份错误文案
        }
        setWorkspaces([])
        setWorkspacesReady(false)
    }, [])

    // 加载工作目录列表
    useEffect(() => {
        void loadWorkspaces()
    }, [loadWorkspaces])

    /**
     * 初始化回填（票 11 复核 R9）。
     *
     * 旧实现依赖 `[initial]`，而父层每次渲染都新建 `initial` 字面量 → 引用恒变 → 每次父层
     * 重渲染都重跑回填，用户输入的名字、选好的工作目录被**静默还原**。本票新增的工作目录
     * 健康度广播又显著抬高了父层重渲染频次（每 1~2 次运行状态广播一次），于是「重新选一个
     * 可用目录」的动作会在下一次广播后被打回失效值 —— 功能直接不可用。
     *
     * 修法：以 `initial.id`（新建时为 null 的哨兵键）为依赖，并用 ref 记住「这个键已回填过」，
     * 从而同一次打开内只跑一次；换任务（id 变）时才重新回填。
     */
    const initialRef = useRef(initial)
    const initedForRef = useRef<string | null | undefined>(undefined)

    useEffect(() => {
        initialRef.current = initial
    })

    /**
     * 新建路径的合理默认：当前会话所在的工作目录。
     * 只用于**新建**；编辑路径不回填（见下）。
     */
    const backfillCurrentWorkspace = useCallback(async () => {
        try {
            const current = await window.electronAPI?.workspace?.getCurrent?.()
            if (current) setWorkspaceIdRaw(current.id)
        } catch {
            // 取不到（桥接缺失 / 无当前工作区）就留空：由用户显式选一个
        } finally {
            setInitializing(false)
        }
    }, [])

    const initialId = initial?.id ?? null

    // 初始化
    useEffect(() => {
        if (initedForRef.current === initialId) return
        initedForRef.current = initialId
        const init = initialRef.current

        if (init) {
            // 初值回填走原始 setter：用户还没动过任何东西，不算「未保存的改动」
            setNameRaw(init.name ?? '')
            setDescriptionRaw(init.description ?? '')
            setTaskType(init.taskType ?? 'agent')
            setTaskTargetRaw(init.taskTarget ?? '')
            setTaskPromptRaw(init.taskPrompt ?? '')
            setEnabledRaw(init.enabled ?? true)
            setMode(init.taskType === 'script' ? 'script' : 'capability')
            // II-5：区分「新建（undefined）」与「已存在的空表达式（''）」。空串必须走 cronToConfig('')，
            // 落高级模式（customExpr=''）——否则会被 makeDefaultConfig 的「每天 9:00」顶替，
            // 而 handleSave 的空表达式校验门只看 custom 模式，等于静默改频率。
            if (init.cronExpression !== undefined) {
                const restored = cronToConfig(init.cronExpression)
                cronRef.current = restored
                setCron(restored)
            }
            // 初始化工作目录
            if (init.workspaceId) {
                setWorkspaceIdRaw(init.workspaceId)
                setInitializing(false)
            } else if (init.id) {
                // **编辑**存量任务且它本来就没有工作目录：不回填。
                // 回填的后果（复核 S2）是把「用户完全没碰过的字段」静默改掉 —— 只改个名字
                // 保存，workspace_id 就被绑到现在的工作区上，而用户对此零输入、关窗也没有提醒。
                // 正确做法是把空摆出来（「未设置工作目录（必选）」），由用户显式选一个。
                setInitializing(false)
            } else {
                // 新建（带部分初值但无 id）：照旧给「当前工作区」这个合理默认
                void backfillCurrentWorkspace()
            }
        } else {
            // 新建时默认使用当前会话的工作目录
            void backfillCurrentWorkspace()
        }
    }, [initialId, backfillCurrentWorkspace])


    const cronExpr = useMemo(() => configToCron(cron), [cron])
    const cronHuman = useMemo(() => cronToHuman(cron), [cron])

    // 脚本类型提示文案
    const scriptTypeHint = useMemo(() => {
        switch (platform) {
            case 'win32': return 'Windows 系统: .bat, .ps1, .cmd, .exe'
            case 'darwin': return 'macOS 系统: .sh, .zsh, .bash'
            case 'linux': return 'Linux 系统: .sh, .bash'
            default: return '脚本文件 (.sh, .bat, .ps1 等)'
        }
    }, [platform])

    // 选择可用能力
    const handleCapabilitySelect = useCallback((target: string, type: string) => {
        setTaskTarget(target)
        setTaskType(type as ScheduleTaskType)
    }, [setTaskTarget])

    // 模式切换
    const handleModeSwitch = useCallback((newMode: ScheduleInputMode) => {
        // ui-09 复核整改（A3）：切到**已经是选中态**的模式按钮是无实质改动，
        // 不置脏——否则点一下当前模式再按 Esc 会白弹一次「放弃未保存的改动？」。
        if (newMode === mode) return
        touch()
        setMode(newMode)
        if (newMode === 'script') {
            setTaskType('script')
        }
    }, [touch, mode])

    // 选中本地脚本文件
    const applyScriptFile = useCallback((file: {path?: string; name: string}) => {
        setTaskTarget(file.path || file.name)
        setTaskType('script')
        setMode('script')
    }, [setTaskTarget])

    /**
     * 工作目录判定 —— 弹窗内联提示与保存校验**共用的那一份结论**（票 11 复核 B1）。
     * 判定函数只在 ScheduleUtils 里有一份实现（checkWorkspaceSelection），这里只是喂数据。
     */
    const workspaceVerdict = useMemo<WorkspaceSelectionVerdict>(
        () => checkWorkspaceSelection(workspaceId, {ready: workspacesReady, ids: workspaces.map(ws => ws.id)}),
        [workspaceId, workspacesReady, workspaces],
    )

    const handleSave = useCallback(() => {
        setError(null)
        if (!name.trim()) return setError('任务名称不能为空')
        if (mode === 'capability' && !taskTarget.trim()) return setError('请选择一个可用能力')
        if (mode === 'script' && !taskTarget.trim()) return setError('请填写脚本路径')
        // II-5：高级表达式清空后不能静默写成别的频率（cron 列 NOT NULL 也挡不住空串），拒存。
        if (cron.mode === 'custom' && !cron.customExpr.trim()) return setError('请填写 cron 表达式')
        // 工作目录必填：任务必须归属一个现存工作区。
        // 落不了地就拦在弹窗内（原因写进同一处 role="alert" 的 live region，不关窗、表单不丢）。
        // 判定与弹窗内联提示共用 workspaceVerdict —— 同一句话，不可能出现「提示说已失效、
        // 保存却放行」或「提示说可用、保存说不行」这种同屏矛盾（复核 B1）。
        // 其中「列表未就绪 / 取数失败 / 空表」同样**拦**：手里没有列表就无从校验，
        // 放行等于把一个没校验过的 id 落库（复核 R3 的合法 ws-1 被显示成「已失效」+ 保存成功
        // 就是这么来的）。
        if (workspaceVerdict.status !== 'ok') {
            return setError(workspaceVerdict.message || '工作目录不可用')
        }

        onSave({
            ...(initial?.id ? {id: initial.id} : {}),
            name: name.trim(),
            description: description.trim(),
            taskType,
            taskTarget: taskTarget.trim(),
            taskPrompt: taskPrompt.trim(),
            cronExpression: cronExpr,
            enabled,
            workspaceId: workspaceId || null,
        })
    }, [initial, name, description, taskType, taskTarget, taskPrompt, cron, cronExpr, enabled, mode, onSave, workspaceId, workspaceVerdict])


    const updateCron = useCallback((patch: Partial<CronConfig>) => {
        const prev = cronRef.current
        const switchedAway = patch.mode !== undefined && patch.mode !== prev.mode
        // 用户一旦主动切换模式或改写表达式，就不再是「无法识别的原表达式」态，
        // 撤销发起初自动落入高级模式的告知（用户故事 32）。
        let next: CronConfig = {...prev, ...patch}
        if (switchedAway || patch.customExpr !== undefined) {
            next.unrecognized = false
            next.customReason = null
        }
        // I-1：切出「高级」时，把原表达式里的 时/分/星期/日期 播种到目标模式，
        // 并显式告知「频率已更改（原：…）」——两件事缺一，用户的原频率就被静默丢掉了。
        const leavingCustom = switchedAway && prev.mode === 'custom'
            && patch.mode !== undefined && patch.mode !== 'custom' && prev.customExpr.trim() !== ''
        if (leavingCustom) {
            next = {...next, ...seedFromCustomExpr(prev.customExpr, patch.mode as CronMode)}
            setCronChangedFrom(prev.customExpr)
        }
        if (patch.mode === 'custom' || patch.customExpr !== undefined) setCronChangedFrom(null)
        // ui-09 复核整改（A3）：值未变（点已是选中态的页签 / 重填同一个数）就不置脏。
        // 判定按**归一化后的字段值**做（sameCronConfig），不按对象引用：`next` 恒为新对象，
        // 引用比较必然为真，那等于没判。此时连 state 都不写，避免无谓重渲染。
        if (sameCronConfig(prev, next)) return
        touch()
        cronRef.current = next
        setCron(next)
    }, [touch])

    return {
        platform,
        /** 用户是否动过表单（未经保存）——关闭前的未保存提醒据此判断（ui-09） */
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
        /** 工作目录判定的唯一结论（内联提示与保存校验共用） */
        workspaceVerdict,
        /** 重试取回工作区列表（列表未就绪时的显式重试入口） */
        retryWorkspaces: loadWorkspaces,
        /** 初值是否仍在回填（未就绪时保存按钮应置灰，S1） */
        initializing,
        cronHuman,
        scriptTypeHint,
        handleCapabilitySelect,
        handleModeSwitch,
        applyScriptFile,
        handleSave,
    }
}
