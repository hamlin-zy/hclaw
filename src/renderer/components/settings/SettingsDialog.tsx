import {useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent} from 'react'
import {useSettingsStore} from '../../stores/settingsStore'
import {useThemeStore} from '../../stores/themeStore'
import {applyThemeClass} from '../../lib/theme'
import {
    AgentIcon, BrainIcon, KeyboardIcon, LayoutIcon, LinkIcon, SettingsIcon, SuccessIcon,
} from '../icons'
import type {IconProps} from '../icons'
import GeneralTab from './tabs/GeneralTab'
import AppearanceTab from './tabs/AppearanceTab'
import AgentTab from './tabs/AgentTab'
import ModelTab from './tabs/ModelTab'
import ChannelsTab from './tabs/ChannelsTab'
import ShortcutsTab from './tabs/ShortcutsTab'

/**
 * 新设置壳（T18；spec §3.1/§3.3/§4.5/§4.6）：侧栏六 Tab + 内容区单列居中 + footer 保存。
 *
 * 相对旧 `dialogs/SettingsDialog.tsx`（T20 切换后删除）的壳级差异：
 * - Tab 分类：6 页（子 Agent 已并入 Agent 运行页）；「恢复全部默认」唯一入口移到侧栏底部；
 * - 加载三态（loading / loaded / failed）：加载完成前禁用内容区与保存，防止以
 *   DEFAULT_SETTINGS 为基座生成 pending 后覆盖写库（旧壳只有 loaded 布尔门闩）；
 * - 保存反馈（已保存 ✓ / 保存失败）与 Tab a11y（tablist 键盘导航 + roving tabindex）。
 */
type TabKey = 'general' | 'appearance' | 'agent' | 'model' | 'channels' | 'shortcuts'

const TABS: Array<{key: TabKey; label: string; icon: ComponentType<IconProps>; Component: ComponentType}> = [
    {key: 'general', label: '通用', icon: SettingsIcon, Component: GeneralTab},
    {key: 'appearance', label: '外观与显示', icon: LayoutIcon, Component: AppearanceTab},
    {key: 'agent', label: 'Agent 运行', icon: AgentIcon, Component: AgentTab},
    {key: 'model', label: '模型参数', icon: BrainIcon, Component: ModelTab},
    {key: 'channels', label: 'IM 配置', icon: LinkIcon, Component: ChannelsTab},
    {key: 'shortcuts', label: '快捷键', icon: KeyboardIcon, Component: ShortcutsTab},
]

/** 键 → 组件表由 TABS 派生（单一真源；避免两表漂移导致 ActiveTab 为 undefined 的运行时崩溃） */
const CONTENT = Object.fromEntries(TABS.map((t) => [t.key, t.Component])) as Record<TabKey, ComponentType>

/** 重置反馈闪现时长（spec §4.5：三入口一致的 1.5s） */
const RESET_DONE_TTL = 1500
/** 保存成功反馈的自动收起时长（spec §4.5：~800ms） */
const SAVE_DONE_TTL = 800

/** 焦点环统一样式（Tab 与侧栏按钮共用；不用 transition-all——见 focusOutlineFlash 护栏）
 *  颜色走 --focus-ring：该令牌按主题取「对 surface / surface-muted 都 ≥3:1」的档位
 *  （globals.css:204-206 证 --brand-primary 白底仅 2.33:1，键盘焦点不可见）。 */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]'

export default function SettingsDialog() {
    const {
        settings,
        pendingSettings,
        isDirty,
        updatePending,
        saveSettings,
        discardChanges,
    } = useSettingsStore()

    const [activeTab, setActiveTab] = useState<TabKey>('general')
    const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
    const [saving, setSaving] = useState(false)
    const [resetDone, setResetDone] = useState(false)
    const [saveFeedback, setSaveFeedback] = useState<string | null>(null)

    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 组件卸载时清除两个反馈计时器
    useEffect(() => {
        return () => {
            if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        }
    }, [])

    // ── 加载已保存设置（设置窗口为独立 JS 堆：store 初始值 = DEFAULT_SETTINGS）──
    // 三态：loading（内容区置灰禁用）→ loaded / failed（顶部横幅 + 重试）。
    const load = useCallback(async () => {
        setLoadState('loading')
        const ok = await useSettingsStore.getState().loadSettings()
        // 独立 JS 堆的 CSS 同步：loadSettings 内部 resolveAndApplyTheme 已更新 themeStore，
        // 但 CSS class 仍是窗口打开时的 initialTheme，此处 applyThemeClass 对齐，避免分叉。
        if (ok && window.electronAPI) applyThemeClass(useThemeStore.getState().theme)
        setLoadState(ok ? 'loaded' : 'failed')
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    // ── Tab 切换 + 键盘导航（↑↓/←→ 循环、Home/End；roving tabindex 同步焦点）──
    const selectTab = useCallback((key: TabKey) => {
        setActiveTab(key)
        document.getElementById(`settings-tab-${key}`)?.focus()
    }, [])

    const handleTablistKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        const idx = TABS.findIndex((t) => t.key === activeTab)
        let next: number
        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                next = (idx + 1) % TABS.length
                break
            case 'ArrowUp':
            case 'ArrowLeft':
                next = (idx - 1 + TABS.length) % TABS.length
                break
            case 'Home':
                next = 0
                break
            case 'End':
                next = TABS.length - 1
                break
            default:
                return
        }
        e.preventDefault()
        selectTab(TABS[next].key)
    }, [activeTab, selectTab])

    // ── 侧栏底部「恢复全部默认」（新壳唯一入口；仅进 pending，保存后落盘）──
    const handleResetAll = useCallback(() => {
        useSettingsStore.getState().resetAllToDefault()
        setResetDone(true)
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        resetTimerRef.current = setTimeout(() => setResetDone(false), RESET_DONE_TTL)
    }, [])

    // ── 保存（行为序对齐旧壳 L163-187；新增成功/失败反馈）──
    const handleSave = useCallback(async () => {
        if (loadState !== 'loaded') return
        setSaving(true)
        try {
            // 图片背景启用时强制使用深色系主题：
            // 浅色模式/十样锦 的白色毛玻璃叠在背景图上会变白雾，观感差。
            // 背景从禁用→启用 且当前是浅色系 → 保存前自动切为深色模式。
            const base = pendingSettings ?? settings
            const bg = base?.ui?.background
            const theme = base?.ui?.theme
            if (bg?.enabled && (theme === 'light' || theme === 'shiyangjin')) {
                // 直接更新 pending 并走 saveSettings（内部会 resolveAndApplyTheme）
                // 注意：pendingSettings 可能为 null（未修改直接保存），updatePending 内部同类以 settings 为基座
                updatePending('ui', {theme: 'dark'})
            }
            await saveSettings()
            setSaveFeedback('已保存 ✓')
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
            saveTimerRef.current = setTimeout(() => setSaveFeedback(null), SAVE_DONE_TTL)
        } catch (err) {
            console.error('[SettingsDialog] 保存失败:', err)
            // 失败反馈常驻（pending 已保留可重试），并撤掉上一次成功反馈的收起计时器
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
            saveTimerRef.current = null
            setSaveFeedback('保存失败')
        } finally {
            setSaving(false)
        }
    }, [loadState, saveSettings, pendingSettings, settings, updatePending])

    const ActiveTab = CONTENT[activeTab]
    const gated = loadState !== 'loaded'

    // 放弃修改：清空 pending 后失败反馈不再成立（无待保存内容），一并收起
    const handleDiscard = useCallback(() => {
        discardChanges()
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        setSaveFeedback(null)
    }, [discardChanges])

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex h-full overflow-hidden">
                {/* Sidebar：Tab 列表区（可滚动）+ 底部固定区 */}
                <div className="w-40 shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--surface-muted)]">
                    <div
                        role="tablist"
                        aria-orientation="vertical"
                        aria-label="设置分类"
                        onKeyDown={handleTablistKeyDown}
                        className="flex-1 overflow-y-auto p-2 space-y-1"
                        data-name="settings-shell-tablist"
                    >
                        {TABS.map((tab) => {
                            const TabIcon = tab.icon
                            const selected = activeTab === tab.key
                            return (
                                <button
                                    key={tab.key}
                                    type="button"
                                    id={`settings-tab-${tab.key}`}
                                    role="tab"
                                    aria-selected={selected}
                                    aria-controls={`settings-panel-${tab.key}`}
                                    tabIndex={selected ? 0 : -1}
                                    onClick={() => selectTab(tab.key)}
                                    className={`w-full text-left px-3 py-2.5 rounded text-xs transition-colors ${FOCUS_RING} ${
                                        selected
                                            ? 'bg-[var(--surface-muted)] text-[var(--text-primary)] font-medium shadow-sm'
                                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                    }`}
                                    data-name={`settings-shell-tab-${tab.key}`}
                                >
                                    <span className="mr-2.5 inline-flex align-middle"><TabIcon className="w-3.5 h-3.5"/></span>
                                    {tab.label}
                                </button>
                            )
                        })}
                    </div>

                    <div className="shrink-0 border-t border-[var(--border)] p-2" data-name="settings-shell-reset-all-area">
                        <button
                            type="button"
                            onClick={handleResetAll}
                            disabled={gated}
                            className={`w-full text-left px-3 py-2 rounded text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--error)] hover:border-[var(--error)] transition-colors disabled:opacity-50 ${FOCUS_RING}`}
                            data-name="settings-shell-reset-all-button"
                        >
                            <span className="inline-flex items-center gap-1.5">
                                {/* 图标槽常驻（idle 时 invisible）+ 文案 min-w：切换文案不引起宽度跳动 */}
                                <SuccessIcon className={`w-3.5 h-3.5 shrink-0 ${resetDone ? '' : 'invisible'}`}/>
                                <span className="min-w-[6em]" aria-live="polite">
                                    {resetDone ? '已恢复全部默认' : '恢复全部默认'}
                                </span>
                            </span>
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                    {loadState === 'failed' && (
                        <div
                            role="alert"
                            className="flex items-center gap-3 px-8 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)] text-xs text-[var(--text-secondary)] shrink-0"
                            data-name="settings-shell-load-error-banner"
                        >
                            <span className="mr-auto">设置加载失败</span>
                            <button
                                type="button"
                                onClick={load}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors ${FOCUS_RING}`}
                                data-name="settings-shell-retry-button"
                            >
                                重试
                            </button>
                        </div>
                    )}
                    <div
                        role="tabpanel"
                        id={`settings-panel-${activeTab}`}
                        aria-labelledby={`settings-tab-${activeTab}`}
                        className={`flex-1 p-8 overflow-y-auto bg-[var(--surface)] ${gated ? 'opacity-60 pointer-events-none' : ''}`}
                        data-name="settings-shell-tabpanel"
                    >
                        <div className="max-w-2xl mx-auto h-full">
                            <ActiveTab/>
                        </div>
                    </div>
                </div>
            </div>

            {/* Footer: Save / Discard */}
            {(gated || isDirty || saveFeedback !== null) && (
                <div
                    className="flex items-center justify-end gap-2 px-6 py-3 border-t border-[var(--border-muted)] bg-[var(--surface)] shrink-0"
                    data-name="settings-shell-footer"
                >
                    <span className="text-xs text-[var(--text-secondary)] mr-auto" aria-live="polite">
                        {saveFeedback ?? (loadState === 'loading' ? '加载中...' : loadState === 'failed' ? '设置未加载，保存已禁用' : '有未保存的更改')}
                    </span>
                    <button
                        type="button"
                        onClick={handleDiscard}
                        disabled={gated}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors disabled:opacity-50 ${FOCUS_RING}`}
                        data-name="settings-shell-discard-button"
                    >
                        放弃
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={gated || !isDirty}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--brand-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 ${FOCUS_RING}`}
                        data-name="settings-shell-save-button"
                    >
                        {saving ? '保存中...' : '保存'}
                    </button>
                </div>
            )}
        </div>
    )
}
