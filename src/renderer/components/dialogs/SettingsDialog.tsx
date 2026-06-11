import React, {useCallback, useEffect, useState} from 'react'
import {Switch} from '../common/Switch'
import {useSettingsStore} from '../../stores/settingsStore'
import {SystemSettings} from '@shared/types'
import {confirm} from '../ConfirmDialog'

type Category = keyof SystemSettings | 'shortcuts'

/** 校验非负整数，0 或 NaN 时返回 null（触发危险提示） */
function clampPositive(value: number | undefined, fallback: number): number {
    if (value === undefined || isNaN(value) || value < 0) return fallback
    return value
}

export default function SettingsDialog() {
    const {
        settings,
        pendingSettings,
        isDirty,
        loadSettings,
        updatePending,
        saveSettings,
        discardChanges
    } = useSettingsStore()
    const [activeTab, setActiveTab] = useState<Category>('ui')
    const [saving, setSaving] = useState(false)
    const [hclawDir, setHclawDir] = useState('')
    const [origHclawDir, setOrigHclawDir] = useState('')

    // 加载当前系统配置目录
    useEffect(() => {
        window.electronAPI?.configGetHclawDir().then((dir) => {
            setHclawDir(dir)
            setOrigHclawDir(dir)
        })
    }, [])

    const saveHclawDir = useCallback(async (dir: string) => {
        setOrigHclawDir(dir)
        await window.electronAPI?.configSetHclawDir(dir)
        const confirmed = await confirm({
            title: '需要重启应用',
            message: '系统配置目录已更改，重启后才能生效。是否立即重启？',
            confirmText: '立即重启',
            cancelText: '稍后重启',
            confirmVariant: 'warning',
            onConfirm: async () => {
                await window.electronAPI?.invoke('app-restart')
            },
        })
        if (confirmed) {
            // restart already handled in onConfirm
        }
    }, [])

    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings

    const handleSave = useCallback(async () => {
        setSaving(true)
        try {
            await saveSettings()
        } catch (err) {
            console.error('[SettingsDialog] 保存失败:', err)
        } finally {
            setSaving(false)
        }
    }, [saveSettings])

    const handleDiscard = useCallback(() => {
        discardChanges()
    }, [discardChanges])

    const renderAgentSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
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
                label="上下文压缩阈值 (k tokens)"
                description="输入 Token 超过此值时触发自动压缩"
                value={current.agent.compactThreshold / 1000}
                onChange={(v) => updatePending('agent', {compactThreshold: clampPositive(v, 700) * 1000})}
                min={1}
                fallback={700}
                decimals={0}
            />
        </div>
    )

    const renderSubagentSettings = () => (
        <div className="space-y-[var(--space-relaxed)]">
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
                        label: '切换右侧栏',
                        keys: (<KbdCombo keys={['Ctrl', 'Shift', 'B']}/>),
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
                <label className="text-xs text-[var(--text-muted)]">语言</label>
                <select
                    className="w-full bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]"
                    value={current.ui.language}
                    onChange={(e) => updatePending('ui', {language: e.target.value})}
                >
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English (Placeholder)</option>
                </select>
            </div>
            <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">外观</label>
                <select
                    className="w-full bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]"
                    value={current.ui.theme}
                    onChange={(e) => updatePending('ui', {theme: e.target.value as 'light' | 'dark' | 'yuanshandai' | 'shiyangjin' | 'system'})}
                >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色模式</option>
                    <option value="dark">深色模式</option>
                    <option value="yuanshandai">远山黛</option>
                    <option value="shiyangjin">十样锦</option>
                </select>
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
                    </div>
                </div>
            </div>

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
                        disabled={saving}
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
function Kbd({children}: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 text-[11px] font-mono font-semibold
                        bg-[var(--surface-overlay)] text-[var(--text-secondary)]
                        border border-[var(--border-emphasis)] rounded-md
                        shadow-[0_1px_1px_rgba(0,0,0,0.08)]
                        min-w-[22px] h-[18px] leading-none
                        select-none">
            {children}
        </kbd>
    )
}

/** 组合键：Ctrl + Shift + X */
function KbdCombo({keys}: { keys: string[] }) {
    return (
        <div className="flex items-center gap-0.5">
            {keys.map((key, i) => (
                <React.Fragment key={key}>
                    {i > 0 && <span className="text-[10px] text-[var(--text-muted)] mx-0.5">+</span>}
                    <Kbd>{key}</Kbd>
                </React.Fragment>
            ))}
        </div>
    )
}

/** 带校验的数字输入框：空值/0 时显示 fallback 值，触发视觉警告 */
function NumberField({
                         label,
                         description,
                         value,
                         onChange,
                         min = 1,
                         fallback,
                         decimals = 0,
                     }: {
    label: string
    description: string
    value: number
    onChange: (v: number) => void
    min?: number
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
