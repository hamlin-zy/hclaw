import {useCallback, useEffect, useRef, useState} from 'react'
import {Kbd, KbdCombo} from '../common/Kbd'
import {Switch} from '../common/Switch'
import ImagePreviewModal from '../common/ImagePreviewModal'
import {useSettingsStore} from '../../stores/settingsStore'
import {useThemeStore} from '../../stores/themeStore'
import {applyThemeClass} from '../../lib/theme'
import {SystemSettings} from '@shared/types'
import {confirm} from '../ConfirmDialog'

type Category = keyof SystemSettings | 'shortcuts'

/** 校验非负整数，0 或 NaN 时返回 null（触发危险提示） */
function clampPositive(value: number | undefined, fallback: number): number {
    if (value === undefined || isNaN(value) || value < 0) return fallback
    return value
}

/** 深色系主题（dark/远山黛）遮罩默认更暗，保证可读性 */
function isDarkTheme(theme: string): boolean {
    return theme === 'dark' || theme === 'yuanshandai'
}

export default function SettingsDialog() {
    const {
        settings,
        pendingSettings,
        isDirty,
        updatePending,
        saveSettings,
        discardChanges,
        resetCategoryToDefault,
        resetAllToDefault,
    } = useSettingsStore()
    const [activeTab, setActiveTab] = useState<Category>('ui')
    const [saving, setSaving] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [hclawDir, setHclawDir] = useState('')
    const [origHclawDir, setOrigHclawDir] = useState('')

    // ── 历史背景图 ──
    const [historyImages, setHistoryImages] = useState<Array<{path: string; name: string; size: number; mtime: number}>>([])
    const [previewSrc, setPreviewSrc] = useState<string | null>(null)

    // 加载当前系统配置目录
    useEffect(() => {
        window.electronAPI?.configGetHclawDir().then((dir) => {
            setHclawDir(dir)
            setOrigHclawDir(dir)
        })
    }, [])

    // ── 设置窗口为独立 JS 堆：打开时须显式加载已保存设置 ──
    // 否则显示默认值（settingsStore 无 persist 中间件，初始值 = DEFAULT_SETTINGS），
    // 且保存时以默认值为基座覆盖写库，丢失已保存配置。
    // loaded 门闩：加载完成前禁止保存（loadSettings 是异步 IPC，防止用户提前修改时
    // updatePending 以 DEFAULT_SETTINGS 为基座生成 pending、保存覆盖写库的竞态）。
    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                await useSettingsStore.getState().loadSettings()
                if (cancelled) return
                setLoaded(true)
                // 独立 JS 堆的 CSS 同步：loadSettings 内部 resolveAndApplyTheme 已更新 themeStore，
                // 但 CSS class 仍是窗口打开时的 initialTheme，此处 applyThemeClass 对齐，避免分叉。
                if (window.electronAPI) {
                    applyThemeClass(useThemeStore.getState().theme)
                }
            } catch (err) {
                console.warn('[SettingsDialog] 加载已保存设置失败:', err)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [])

    const saveHclawDir = useCallback(async (dir: string) => {
        setOrigHclawDir(dir)
        await window.electronAPI?.configSetHclawDir(dir)
        // 重启动作在 onConfirm 内处理（确认时执行，取消时不执行），无需检查返回值
        await confirm({
            title: '需要重启应用',
            message: '系统配置目录已更改，重启后才能生效。是否立即重启？',
            confirmText: '立即重启',
            cancelText: '稍后重启',
            confirmVariant: 'warning',
            onConfirm: async () => {
                await window.electronAPI?.invoke('app-restart')
            },
        })
    }, [])

    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings

    // 背景启用时加载历史图片列表（数据目录 data/backgrounds/ 下的图片）
    // ⚠️ 必须放在 current 定义之后（useEffect 闭包引用 current）
    useEffect(() => {
        if (!current.ui.background?.enabled) {
            setHistoryImages([])
            return
        }
        window.electronAPI?.backgroundList?.().then(list => {
            if (list) setHistoryImages(list)
        })
    }, [current.ui.background?.enabled])

    // ── 删除历史背景图 ──
    // 删除文件后刷新列表；若删除的是当前背景，则自动切换：
    // 优先切到列表中的"下一个"（被删项在原列表的后一位），
    // 没有下一个则切到第一个；无候选图则清空背景设置。
    const handleDeleteHistoryImage = useCallback(async (img: {path: string; name: string}) => {
        const confirmed = await confirm({
            title: '删除背景图',
            message: `确定删除这张背景图吗？\n${img.name}`,
            confirmText: '删除',
            cancelText: '取消',
            confirmVariant: 'danger',
        })
        if (!confirmed) return

        const deletedCurrent = current.ui.background?.imagePath === img.path
        const oldIdx = historyImages.findIndex(h => h.path === img.path)

        await window.electronAPI?.backgroundRemove(img.path)
        const list = (await window.electronAPI?.backgroundList?.()) ?? []
        setHistoryImages(list)

        if (deletedCurrent) {
            const bg = current.ui.background!
            if (list.length > 0) {
                // 被删项在原列表的"后一位"（删除后整体前移）优先；越界则第一个
                const next = list[Math.min(oldIdx, list.length - 1)] ?? list[0]
                updatePending('ui', {
                    background: {...bg, imagePath: next.path, enabled: true},
                })
            } else {
                // 无候选图 → 清空背景设置
                updatePending('ui', {
                    background: {...bg, enabled: false, imagePath: ''},
                })
            }
        }
    }, [current.ui.background, historyImages, updatePending])

    const handleSave = useCallback(async () => {
        if (!loaded) return
        setSaving(true)
        try {
            // 图片背景启用时强制使用深色系主题：
            // 浅色模式/十样锦 的白色毛玻璃叠在背景图上会变白雾，观感差。
            // 背景从禁用→启用 且当前是浅色系 → 保存前自动切为深色模式。
            const base = pendingSettings ?? settings
            const bg = base.ui.background
            const theme = base.ui.theme
            if (bg?.enabled && (theme === 'light' || theme === 'shiyangjin')) {
                // 直接更新 pending 并走 saveSettings（内部会 resolveAndApplyTheme）
                // 注意：pendingSettings 可能为 null（未修改直接保存），需以 settings 为基座
                useSettingsStore.setState({
                    pendingSettings: {...base, ui: {...base.ui, theme: 'dark'}},
                    isDirty: true,
                })
            }
            await saveSettings()
        } catch (err) {
            console.error('[SettingsDialog] 保存失败:', err)
        } finally {
            setSaving(false)
        }
    }, [loaded, saveSettings, pendingSettings, settings])

    const handleDiscard = useCallback(() => {
        discardChanges()
    }, [discardChanges])

    // ── 恢复默认按钮反馈（点击后短暂显示"已恢复默认"） ──
    const [resetFeedback, setResetFeedback] = useState<string | null>(null)
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleResetCategory = useCallback((category: keyof SystemSettings) => {
        resetCategoryToDefault(category)
        setResetFeedback(`${category}-tab`)
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        resetTimerRef.current = setTimeout(() => setResetFeedback(null), 1500)
    }, [resetCategoryToDefault])

    const handleResetAll = useCallback(() => {
        resetAllToDefault()
        setResetFeedback('all')
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        resetTimerRef.current = setTimeout(() => setResetFeedback(null), 1500)
    }, [resetAllToDefault])

    // 组件卸载时清除重置反馈计时器
    useEffect(() => {
        return () => {
            if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        }
    }, [])

    /** 内容区顶部的「恢复本页默认」按钮（shortcuts 只读 Tab 不渲染） */
    const renderResetSectionButton = (category: keyof SystemSettings) => (
        <div className="flex justify-end">
            <button
                onClick={() => handleResetCategory(category)}
                className={`px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
                    resetFeedback === `${category}-tab`
                        ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                }`}
            >
                {resetFeedback === `${category}-tab` ? '✓ 已恢复默认' : '恢复本页默认'}
            </button>
        </div>
    )

    const renderAgentSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
            {renderResetSectionButton('agent')}
            <NumberField
                label="最大轮次 (maxTurns)"
                description="Agent 推理循环的最大迭代次数"
                value={current.agent.maxTurns}
                onChange={(v) => updatePending('agent', {maxTurns: clampPositive(v, 500)})}
                min={1}
                fallback={500}
            />
            <NumberField
                label="重试次数 (retryCount)"
                description="LLM 超时或异常时的自动重试次数"
                value={current.agent.retryCount}
                onChange={(v) => updatePending('agent', {retryCount: clampPositive(v, 10)})}
                min={1}
                fallback={10}
            />
            <div className="grid grid-cols-2 gap-4">
                <NumberField
                    label="首次重试延迟 (s)"
                    description="首次重试的等待时间，后续按指数增加"
                    value={current.agent.initialRetryDelay / 1000}
                    onChange={(v) => updatePending('agent', {initialRetryDelay: clampPositive(v, 5) * 1000})}
                    min={1}
                    fallback={5}
                    decimals={1}
                />
                <NumberField
                    label="最大重试延迟 (s)"
                    description="重试间隔上限"
                    value={current.agent.maxRetryDelay / 1000}
                    onChange={(v) => updatePending('agent', {maxRetryDelay: clampPositive(v, 120) * 1000})}
                    min={1}
                    fallback={120}
                    decimals={1}
                />
            </div>
            <NumberField
                label="LLM 超时时间 (s)"
                description="单次 LLM 调用的超时时间"
                value={current.agent.llmTimeout / 1000}
                onChange={(v) => updatePending('agent', {llmTimeout: clampPositive(v, 600) * 1000})}
                min={10}
                fallback={600}
                decimals={1}
            />
            <NumberField
                label="交接引导阈值 (%)"
                description="发送消息时，若当前会话上下文占用超过此比例，将弹窗询问是否交接到新会话；单次任务执行中上下文超过此比例时，也会按下方「单轮内溢出处理」触发自动交接或优雅停止。默认 50%。设 0 同时关闭发送前弹窗与单轮内保护（不推荐——可能裸报窗口超限错误）。"
                value={Math.round((current.agent.handoffThresholdRatio ?? 0.5) * 100)}
                onChange={(v) => updatePending('agent', {handoffThresholdRatio: Math.min(100, Math.max(0, Math.round(v))) / 100})}
                min={0}
                fallback={50}
            />
            <div className="grid grid-cols-1 gap-2">
                <label className="flex items-center justify-between text-sm">
                    <span>
                        单轮内溢出处理
                        <span className="ml-1 text-xs text-[var(--text-secondary)]">
                            单次任务执行中上下文接近窗口上限时的处理。自动交接：自动总结并交接到新会话继续执行；优雅停止：停止本轮并提示手动处理。
                        </span>
                    </span>
                    <select
                        className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1 text-sm"
                        value={current.agent.midLoopOverflowMode ?? 'auto-handoff'}
                        onChange={(e) => updatePending('agent', {midLoopOverflowMode: e.target.value as 'auto-handoff' | 'graceful-stop'})}
                    >
                        <option value="auto-handoff">自动交接（推荐）</option>
                        <option value="graceful-stop">优雅停止</option>
                    </select>
                </label>
            </div>
        </div>
    )

    const renderSubagentSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
            {renderResetSectionButton('subagent')}
            <NumberField
                label="最大并发数 (maxConcurrency)"
                description="子 Agent 同时运行的最大数量"
                value={current.subagent?.maxConcurrency ?? 3}
                onChange={(v) => updatePending('subagent', {maxConcurrency: clampPositive(v, 3)})}
                min={1}
                fallback={3}
            />
            <NumberField
                label="默认超时时间 (s)"
                description="子 Agent 任务的默认超时时间"
                value={(current.subagent?.defaultTimeout ?? 15 * 60 * 1000) / 1000}
                onChange={(v) => updatePending('subagent', {defaultTimeout: clampPositive(v, 900) * 1000})}
                min={10}
                fallback={900}
                decimals={0}
            />
            <NumberField
                label="重试次数 (retryAttempts)"
                description="子 Agent 任务失败时的重试次数，0 表示不重试"
                value={current.subagent?.retryAttempts ?? 0}
                onChange={(v) => updatePending('subagent', {retryAttempts: clampPositive(v, 0)})}
                min={0}
                fallback={0}
            />
            <NumberField
                label="深入了解度 (maxDepth)"
                description="子 Agent 嵌套的最大层级深度，防止无限递归。默认 3"
                value={current.subagent?.maxDepth ?? 3}
                onChange={(v) => updatePending('subagent', {maxDepth: clampPositive(v, 3)})}
                min={1}
                max={10}
                fallback={3}
                decimals={0}
            />
            <div className="flex items-center justify-between py-2">
                <div>
                    <label className="text-xs text-[var(--text-muted)]">启用优先级调度 (priorityEnabled)</label>
                    <p className="text-[10px] text-[var(--text-muted)]">启用后可根据任务优先级调整调度顺序</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={current.subagent?.priorityEnabled ?? false} onChange={(checked) => updatePending('subagent', {priorityEnabled: checked})} />
                    <span className={`ml-2 text-xs font-medium ${current.subagent?.priorityEnabled ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'}`}>
                        {current.subagent?.priorityEnabled ? '已启用' : '已禁用'}
                    </span>
                </div>
            </div>
        </div>
    )

    const renderModelSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
            {renderResetSectionButton('model')}
            <NumberField
                label="默认最大 Token 数 (maxTokens)"
                description="LLM 输出的最大 Token 数"
                value={current.model.defaultMaxTokens}
                onChange={(v) => updatePending('model', {defaultMaxTokens: clampPositive(v, 8000)})}
                min={1}
                fallback={8000}
            />
            <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">默认温度 (temperature)</label>
                <div className="flex items-center gap-3">
                    <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        className="flex-1 accent-[var(--brand)]"
                        value={current.model.defaultTemperature}
                        onChange={(e) => updatePending('model', {defaultTemperature: parseFloat(e.target.value)})}
                    />
                    <input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        className="w-16 bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded px-2 py-1.5 text-sm text-center outline-none focus:border-[var(--brand)]"
                        value={current.model.defaultTemperature}
                        onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (!isNaN(v) && v >= 0) updatePending('model', {defaultTemperature: Math.min(2, v)})
                        }}
                        onBlur={(e) => {
                            const v = parseFloat(e.target.value)
                            if (isNaN(v) || v < 0) updatePending('model', {defaultTemperature: 0})
                        }}
                    />
                </div>
                <p className="text-[10px] text-[var(--text-muted)]">0 = 确定性输出，2 = 高随机性。建议代码任务使用 0。</p>
            </div>
        </div>
    )


    const renderShortcutsSettings = () => {

        type ShortcutEntry = { label: string; keys: React.ReactNode }

        const groups: { title: string; icon: string; items: ShortcutEntry[] }[] = [
            {
                title: '面板 & 窗口', icon: '⊞',
                items: [
                    {
                        label: '切换左侧栏',
                        keys: (<KbdCombo keys={['Ctrl', 'B']}/>),
                    },
                    {
                        label: '切换明暗主题',
                        keys: (<KbdCombo keys={['Ctrl', 'Shift', 'T']}/>),
                    },
                ],
            },
            {
                title: '输入 & 会话', icon: '⌨',
                items: [
                    {
                        label: '发送消息',
                        keys: <Kbd>Enter</Kbd>,
                    },
                    {
                        label: '换行',
                        keys: (<KbdCombo keys={['Shift', 'Enter']}/>),
                    },
                    {
                        label: '命令选择弹窗',
                        keys: (<KbdCombo keys={['Ctrl', 'K']}/>),
                    },
                    {
                        label: '上一条输入历史',
                        keys: (<KbdCombo keys={['Ctrl', '↑']}/>),
                    },
                    {
                        label: '下一条输入历史',
                        keys: (<KbdCombo keys={['Ctrl', '↓']}/>),
                    },
                    {
                        label: '新建会话',
                        keys: (<KbdCombo keys={['Ctrl', 'N']}/>),
                    },
                    {
                        label: '上一个会话',
                        keys: (<KbdCombo keys={['Alt', '↑']}/>),
                    },
                    {
                        label: '下一个会话',
                        keys: (<KbdCombo keys={['Alt', '↓']}/>),
                    },
                    {
                        label: '粘贴剪贴板内容',
                        keys: (<KbdCombo keys={['Ctrl', 'V']}/>),
                    },
                    {
                        label: '查找消息',
                        keys: (<KbdCombo keys={['Ctrl', 'F']}/>),
                    },
                ],
            },
            {
                title: 'Agent & 权限', icon: '⚡',
                items: [
                    {
                        label: '中断 Agent 执行',
                        keys: <Kbd>Esc</Kbd>,
                    },
                    {
                        label: '允许当前工具调用',
                        keys: <Kbd>Enter</Kbd>,
                    },
                ],
            },
            {
                title: '全局快捷键', icon: '🌐',
                items: [
                    {
                        label: '隐藏 / 显示 HClaw 窗口',
                        keys: (<KbdCombo keys={['Ctrl', 'Shift', 'Space']}/>),
                    },
                ],
            },
        ]

        return (
            <div className="space-y-5 pb-2">
                <div
                    className="bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded-lg p-3">
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        以下快捷键在 HClaw 窗口激活时生效。
                        全局快捷键 <KbdCombo keys={['Ctrl', 'Shift', 'Space']}/> 在应用外也可隐藏/显示窗口。
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-4">
                    {groups.map((group) => (
                        <div
                            key={group.title}
                            className="border border-[var(--border)] rounded-xl bg-[var(--surface)] overflow-hidden"
                        >
                            <div
                                className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-muted)] bg-[var(--surface-muted)]/40">
                                <span className="text-xs opacity-60">{group.icon}</span>
                                <h4 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                                    {group.title}
                                </h4>
                            </div>
                            <div className="divide-y divide-[var(--border-muted)]">
                                {group.items.map((item) => (
                                    <div
                                        key={item.label}
                                        className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--surface-muted)]/40 transition-colors"
                                    >
                                        <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
                                        <div className="flex items-center gap-1 shrink-0 ml-4">
                                            {item.keys}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        )
    }

    const renderUiSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
            {renderResetSectionButton('ui')}
            <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">系统配置目录</label>
                <div className="flex gap-2">
                    <input
                        type="text"
                        className="flex-1 bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)] font-mono"
                        value={hclawDir}
                        onChange={(e) => setHclawDir(e.target.value)}
                        onBlur={() => {
                            if (hclawDir !== origHclawDir) {
                                saveHclawDir(hclawDir)
                            }
                        }}
                        placeholder="默认：~/.hclaw"
                    />
                    <button
                        className="px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--surface-muted)] rounded border border-[var(--border-muted)] transition-colors whitespace-nowrap"
                        onClick={async () => {
                            const dir = await window.electronAPI?.openFolderDialog()
                            if (dir) {
                                setHclawDir(dir)
                                saveHclawDir(dir)
                            }
                        }}
                        title="选择目录"
                    >
                        浏览
                    </button>
                    <button
                        className="px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--surface-muted)] rounded border border-[var(--border-muted)] transition-colors"
                        onClick={() => {
                            setHclawDir('')
                            saveHclawDir('')
                        }}
                        title="重置为默认值"
                    >
                        重置
                    </button>
                </div>
                <p className="text-[10px] text-[var(--text-muted)]">修改后重启应用生效。留空表示使用默认路径 ~/.hclaw</p>
            </div>
            <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">外观</label>
                <select
                    className="w-full bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]"
                    value={current.ui.theme}
                    onChange={(e) => updatePending('ui', {theme: e.target.value as 'light' | 'dark' | 'yuanshandai' | 'shiyangjin' | 'system'})}
                >
                    <option value="system">跟随系统</option>
                    <option value="light" disabled={!!current.ui.background?.enabled}>
                        浅色模式{current.ui.background?.enabled ? '（背景开启时不可用）' : ''}
                    </option>
                    <option value="dark">深色模式</option>
                    <option value="yuanshandai">远山黛</option>
                    <option value="shiyangjin" disabled={!!current.ui.background?.enabled}>
                        十样锦{current.ui.background?.enabled ? '（背景开启时不可用）' : ''}
                    </option>
                </select>
                {current.ui.background?.enabled && (current.ui.theme === 'light' || current.ui.theme === 'shiyangjin') && (
                    <p className="text-[10px] text-[var(--warning)]">图片背景开启时使用浅色系主题，保存后将自动切换为深色模式</p>
                )}
            </div>
            <div className="space-y-3 border-t border-[var(--border-muted)] pt-3">
                <div className="flex items-center justify-between">
                    <div>
                        <label className="text-xs text-[var(--text-muted)]">本地图片背景</label>
                        <p className="text-[10px] text-[var(--text-muted)]">将本地图片作为整个窗口背景，内容层毛玻璃显示</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Switch
                            checked={current.ui.background?.enabled ?? false}
                            onChange={(checked) => updatePending('ui', {
                                background: {
                                    enabled: checked,
                                    imagePath: current.ui.background?.imagePath ?? '',
                                    overlay: current.ui.background?.overlay ?? (isDarkTheme(current.ui.theme) ? 50 : 30),
                                    blur: current.ui.background?.blur ?? 16,
                                }
                            })}
                        />
                        <span className={`ml-2 text-xs font-medium ${current.ui.background?.enabled ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'}`}>
                            {current.ui.background?.enabled ? '已启用' : '已禁用'}
                        </span>
                    </div>
                </div>

                {current.ui.background?.enabled && (
                    <div className="space-y-3">
                        {/* 选图 + 预览 */}
                        <div className="flex items-center gap-3">
                            {current.ui.background.imagePath ? (
                                <div
                                    className="w-24 h-14 rounded border border-[var(--border)] bg-cover bg-center shrink-0 cursor-zoom-in"
                                    style={{backgroundImage: `url(${current.ui.background.imagePath})`}}
                                    onClick={() => setPreviewSrc(current.ui.background!.imagePath)}
                                    title="点击放大查看"
                                />
                            ) : (
                                <div className="w-24 h-14 rounded border border-dashed border-[var(--border)] flex items-center justify-center text-[10px] text-[var(--text-muted)] shrink-0">
                                    未选择图片
                                </div>
                            )}
                            <div className="flex flex-col gap-1.5">
                                <button
                                    className="px-2.5 py-1.5 text-xs bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded text-[var(--text-primary)] hover:border-[var(--brand-primary)] transition-colors"
                                    onClick={async () => {
                                        const result = await window.electronAPI?.backgroundPick()
                                        if (result?.path) {
                                            updatePending('ui', {
                                                background: {
                                                    ...current.ui.background!,
                                                    imagePath: result.path,
                                                }
                                            })
                                            // 刷新历史列表（新图已拷入 backgrounds 目录）
                                            const list = await window.electronAPI?.backgroundList?.()
                                            if (list) setHistoryImages(list)
                                        }
                                    }}
                                >
                                    选择图片
                                </button>
                                {current.ui.background.imagePath && (
                                    <button
                                        className="px-2.5 py-1.5 text-xs text-[var(--error)] hover:bg-[var(--surface-muted)] rounded transition-colors"
                                        onClick={async () => {
                                            const bg = current.ui.background!
                                            await window.electronAPI?.backgroundRemove(bg.imagePath)
                                            updatePending('ui', {
                                                background: {
                                                    ...bg,
                                                    enabled: false,
                                                    imagePath: '',
                                                }
                                            })
                                            const list = await window.electronAPI?.backgroundList?.()
                                            if (list) setHistoryImages(list)
                                        }}
                                    >
                                        清除背景
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* 历史图片缩略图条 */}
                        {historyImages.length > 0 && (
                            <div className="space-y-1.5">
                                <label className="text-[11px] text-[var(--text-muted)]">历史图片</label>
                                <div className="flex gap-2 overflow-x-auto pb-1">
                                    {historyImages.map(img => {
                                        const isActive = current.ui.background?.imagePath === img.path
                                        return (
                                            <div key={img.path} className="relative group shrink-0">
                                                <div
                                                    className={`w-16 h-10 rounded border bg-cover bg-center cursor-pointer transition-all ${
                                                        isActive
                                                            ? 'border-[var(--brand-primary)] ring-2 ring-[var(--brand-primary)]/30'
                                                            : 'border-[var(--border)] hover:border-[var(--brand-primary)]'
                                                    }`}
                                                    style={{backgroundImage: `url(${img.path})`}}
                                                    onClick={() => updatePending('ui', {
                                                        background: {...current.ui.background!, imagePath: img.path}
                                                    })}
                                                    title={img.name}
                                                />
                                                {/* 放大查看按钮（hover 显示） */}
                                                <button
                                                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow text-[var(--text-muted)] hover:text-[var(--brand-primary)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setPreviewSrc(img.path)
                                                    }}
                                                    title="放大查看"
                                                >
                                                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                        <circle cx="11" cy="11" r="8"/>
                                                        <path d="m21 21-4.3-4.3"/>
                                                    </svg>
                                                </button>
                                                {/* 删除按钮（hover 显示，位于放大镜下方） */}
                                                <button
                                                    className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow text-[var(--text-muted)] hover:text-[var(--error)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        handleDeleteHistoryImage(img)
                                                    }}
                                                    title="删除"
                                                >
                                                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                        <polyline points="3 6 5 6 21 6"/>
                                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                                        <line x1="10" y1="11" x2="10" y2="17"/>
                                                        <line x1="14" y1="11" x2="14" y2="17"/>
                                                    </svg>
                                                </button>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        )}

                        {/* 遮罩强度 */}
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <label className="text-[11px] text-[var(--text-muted)]">遮罩强度</label>
                                <span className="text-[11px] text-[var(--text-muted)]">{current.ui.background.overlay}%</span>
                            </div>
                            <input
                                type="range" min={0} max={100} value={current.ui.background.overlay}
                                onChange={(e) => updatePending('ui', {
                                    background: {...current.ui.background!, overlay: Number(e.target.value)}
                                })}
                                className="w-full accent-[var(--brand-primary)]"
                            />
                        </div>

                        {/* 模糊强度 */}
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <label className="text-[11px] text-[var(--text-muted)]">模糊强度</label>
                                <span className="text-[11px] text-[var(--text-muted)]">{current.ui.background.blur}px</span>
                            </div>
                            <input
                                type="range" min={0} max={40} value={current.ui.background.blur}
                                onChange={(e) => updatePending('ui', {
                                    background: {...current.ui.background!, blur: Number(e.target.value)}
                                })}
                                className="w-full accent-[var(--brand-primary)]"
                            />
                        </div>
                    </div>
                )}
            </div>
            <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">链接打开方式</label>
                <select
                    className="w-full bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]"
                    value={current.linkOpening?.mode ?? 'ask'}
                    onChange={(e) => updatePending('linkOpening', {mode: e.target.value as 'builtin' | 'system' | 'ask'})}
                >
                    <option value="ask">每次询问</option>
                    <option value="builtin">内置浏览器</option>
                    <option value="system">系统浏览器</option>
                </select>
            </div>
        </div>
    )

    const renderChannelSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
            {renderResetSectionButton('channels')}
            <div className="flex items-center justify-between py-2">
                <div>
                    <label className="text-xs text-[var(--text-muted)]">连接后发送打招呼信息</label>
                    <p className="text-[10px] text-[var(--text-muted)]">渠道连接成功后，自动发送问候消息给登录用户</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={current.channels?.sendGreeting ?? true} onChange={(checked) => updatePending('channels', {sendGreeting: checked})} />
                    <span className={`ml-2 text-xs font-medium ${current.channels?.sendGreeting ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'}`}>
                        {current.channels?.sendGreeting ? '已启用' : '已禁用'}
                    </span>
                </div>
            </div>

            <NumberField
                label="连接超时时间 (秒)"
                description="渠道建立连接的超时时间，超时后标记为连接失败"
                value={current.channels?.connectionTimeout ?? 30}
                onChange={(v) => updatePending('channels', {connectionTimeout: clampPositive(v, 30)})}
                min={5}
                fallback={30}
            />
        </div>
    )

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex h-full overflow-hidden">
                {/* Sidebar Tabs */}
                <div className="w-40 border-r border-[var(--border-muted)] p-2 space-y-1 bg-[var(--surface-muted)]/30">
                    {[
                        {id: 'ui', label: '通用设置', icon: '⚙️'},
                        {id: 'agent', label: 'Agent 运行', icon: '🤖'},
                        {id: 'subagent', label: '子 Agent', icon: '🔀'},
                        {id: 'model', label: '模型参数', icon: '🧠'},
                        {id: 'channels', label: '渠道配置', icon: '🔗'},
                        {id: 'shortcuts', label: '快捷键', icon: '⌨️'},
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as Category)}
                            className={`w-full text-left px-3 py-2.5 rounded text-xs transition-colors ${
                                activeTab === tab.id
                                    ? 'bg-[var(--surface-muted)] text-[var(--text-primary)] font-medium shadow-sm'
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                            }`}
                        >
                            <span className="mr-2.5">{tab.icon}</span>
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Content Area */}
                <div className="flex-1 p-8 overflow-y-auto bg-[var(--surface)]">
                    <div className="max-w-2xl mx-auto h-full">
                        {activeTab === 'agent' && renderAgentSettings()}
                        {activeTab === 'model' && renderModelSettings()}

                        {activeTab === 'ui' && renderUiSettings()}
                        {activeTab === 'subagent' && renderSubagentSettings()}
                        {activeTab === 'channels' && renderChannelSettings()}
                        {activeTab === 'shortcuts' && renderShortcutsSettings()}

                        <div className="flex justify-end mt-6">
                            <button
                                onClick={handleResetAll}
                                className={`px-3 py-1.5 text-[11px] rounded-md border transition-colors ${
                                    resetFeedback === 'all'
                                        ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                                        : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--error)] hover:border-[var(--error)]'
                                }`}
                            >
                                {resetFeedback === 'all' ? '✓ 已恢复全部默认' : '恢复全部默认'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* 历史图片放大预览（复用项目看图组件：缩放/拖动/旋转） */}
            {previewSrc && (
                <ImagePreviewModal
                    src={previewSrc}
                    alt="背景图片预览"
                    onClose={() => setPreviewSrc(null)}
                />
            )}

            {/* Footer: Save / Discard */}
            {isDirty && (
                <div
                    className="flex items-center justify-end gap-2 px-6 py-3 border-t border-[var(--border-muted)] bg-[var(--surface)] shrink-0">
                    <span className="text-[11px] text-[var(--text-muted)] mr-auto">
                        有未保存的更改
                    </span>
                    <button
                        onClick={handleDiscard}
                        className="px-3 py-1.5 text-[11px] font-medium rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                    >
                        放弃
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!loaded || saving}
                        className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-[var(--brand-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                        {saving ? '保存中...' : '保存'}
                    </button>
                </div>
            )}
        </div>
    )
}

/** 快捷键展示用的小组件 */
/** 带校验的数字输入框：空值/0 时显示 fallback 值，触发视觉警告 */
function NumberField({
                         label,
                         description,
                         value,
                         onChange,
                         min = 1,
                         max,
                         fallback,
                         decimals = 0,
                     }: {
    label: string
    description: string
    value: number
    onChange: (v: number) => void
    min?: number
    max?: number
    fallback: number
    decimals?: number
}) {
    const isDangerous = value <= 0 || isNaN(value)

    return (
        <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">{label}</label>
            <input
                type="number"
                step={decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : 1}
                min={min}
                max={max}
                className={`w-full bg-[var(--surface-muted)] border rounded px-3 py-1.5 text-sm outline-none transition-colors ${
                    isDangerous
                        ? 'border-red-500 focus:border-red-500'
                        : 'border-[var(--border-muted)] focus:border-[var(--brand)]'
                }`}
                value={value}
                onChange={(e) => {
                    const parsed = decimals > 0 ? parseFloat(e.target.value) : parseInt(e.target.value)
                    onChange(parsed)
                }}
            />
            {isDangerous && (
                <p className="text-[10px] text-red-500">值无效，已还原为 {fallback}</p>
            )}
            <p className="text-[10px] text-[var(--text-muted)]">{description}</p>
        </div>
    )
}
