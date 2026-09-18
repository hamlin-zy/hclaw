import {useEffect, useState, type ComponentType, type ReactNode} from 'react'
import {Kbd, KbdCombo} from '../../common/Kbd'
import {useSettingsStore} from '../../../stores/settingsStore'
import {ShortcutRow} from '../ShortcutRow'
import {PAGE_FIELD_SETS} from '../primitives/fieldSets'
import {PageResetRow} from '../primitives/ResetButton'
import {SHORTCUT_DEFS, mergeOverrides, type ShortcutAction} from '../../../../shared/shortcuts'
import {CommandIcon, GlobeIcon, KeyboardIcon, LayoutIcon} from '../../icons'
import type {IconProps} from '../../icons'

type ShortcutEntry = { label: string; keys: ReactNode }

/** 可自定义组名（取自 SHORTCUT_DEFS 的 group 字段） */
type ShortcutGroupName = '面板 & 窗口' | '输入 & 会话' | '全局'

/** 四张键位卡（3 个可自定义组 + 静态的 Agent & 权限卡）——顺序即卡片顺序；无 group = 只渲染静态行 */
const GROUP_CARDS: { title: string; icon: ComponentType<IconProps>; group?: ShortcutGroupName; staticItems: ShortcutEntry[] }[] = [
    {
        title: '面板 & 窗口', icon: LayoutIcon, group: '面板 & 窗口',
        staticItems: [{label: '功能菜单（左下角三横线）', keys: <Kbd>Alt</Kbd>}],
    },
    {
        title: '输入 & 会话', icon: KeyboardIcon, group: '输入 & 会话',
        staticItems: [
            {label: '发送消息', keys: <Kbd>Enter</Kbd>},
            {label: '换行', keys: <KbdCombo keys={['Shift', 'Enter']}/>},
            {label: '粘贴剪贴板内容', keys: <KbdCombo keys={['Ctrl', 'V']}/>},
            {label: '查找消息', keys: <KbdCombo keys={['Ctrl', 'F']}/>},
        ],
    },
    {title: '全局', icon: GlobeIcon, group: '全局', staticItems: []},
    {
        title: 'Agent & 权限', icon: CommandIcon,
        staticItems: [
            {label: '中断 Agent 执行', keys: <Kbd>Esc</Kbd>},
            {label: '允许当前工具调用', keys: <Kbd>Enter</Kbd>},
        ],
    },
]

/** 键位卡外壳：组标题条 + divide-y 行容器（可自定义组的行经 children 传入） */
function GroupCard({title, icon: GroupIcon, children}: { title: string; icon: ComponentType<IconProps>; children: ReactNode }) {
    return (
        <div className="border border-[var(--border)] rounded-xl bg-[var(--surface)] overflow-hidden">
            <div
                className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-muted)] bg-[var(--surface-muted)]">
                <span className="opacity-60 flex items-center"><GroupIcon className="w-3.5 h-3.5"/></span>
                <h4 className="text-xs font-semibold text-[var(--text-secondary)]">
                    {title}
                </h4>
            </div>
            <div className="divide-y divide-[var(--border-muted)]">
                {children}
            </div>
        </div>
    )
}

/** 不支持自定义的静态键位行（跟随组展示，只读） */
function StaticRow({item}: { item: ShortcutEntry }) {
    return (
        <div className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--surface-muted)] transition-colors">
            <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
            <div className="flex items-center gap-1 shrink-0 ml-4">
                {item.keys}
            </div>
        </div>
    )
}

/**
 * 快捷键 Tab（spec §3.1）：四组键位卡（面板 & 窗口 / 输入 & 会话 / 全局 / Agent & 权限）。
 *
 * 迁移自旧 `dialogs/SettingsDialog.tsx`（`renderShortcutsSettings`，L487-624）：
 * 改键即时保存路径逐字不动（`updateSettings({shortcuts: {overrides}})`；pending 镜像由 store 负责，
 * 本组件不自行镜像/清理），列表显示读已保存值 `settings.shortcuts?.overrides`（非 pending，旧语义）；
 * globalFailures 订阅与失败态展示自旧壳组件体迁入本组件。
 * 组标题按 spec §4.3 改为 12px 加粗 + 次要色（原 11px + uppercase/tracking-wider 不再保留）；
 * 旧「全部恢复默认」改名「键位恢复默认」（逻辑不变），与页级 ResetButton 语义区分。
 */
export default function ShortcutsTab() {
    const {settings, updateSettings} = useSettingsStore()

    // ── 快捷键：全局键注册失败结果（Task 3 推送；空对象 = 无失败）──
    const [globalFailures, setGlobalFailures] = useState<Record<string, string>>({})
    useEffect(() => {
        const off = window.electronAPI?.onShortcutsGlobalFailures?.(setGlobalFailures)
        return () => off?.()
    }, [])

    const overrides = settings.shortcuts?.overrides ?? {}
    const effective = mergeOverrides(overrides)

    const handleOverrideChange = (id: ShortcutAction, acc: string | null) => {
        // shortcuts 为浅合并：必须传完整 overrides（先取 store 现值再改单个 id）
        const newOverrides = {...overrides}
        if (acc === null) delete newOverrides[id]
        else newOverrides[id] = acc
        // 镜像 settingsStore saveSettings 顺序：configWrite 先写库 → settingsUpdate 广播
        updateSettings({shortcuts: {overrides: newOverrides}}).catch((err) => {
            console.error('[Settings] 快捷键保存失败:', err)
        })
    }

    const handleResetAll = () => {
        updateSettings({shortcuts: {overrides: {}}}).catch((err) => {
            console.error('[Settings] 快捷键恢复默认失败:', err)
        })
    }

    return (
        <div className="space-y-[var(--space-spacious)]">
            <PageResetRow paths={PAGE_FIELD_SETS.shortcuts}/>

            <div className="flex items-stretch justify-between gap-3">
                <div
                    className="flex-1 flex items-center gap-2 bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded-lg px-3 py-2">
                    <span aria-hidden="true" className="opacity-50 shrink-0 flex items-center"><KeyboardIcon className="w-4 h-4"/></span>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        点击绑定框可自定义，修改立即生效。全局快捷键在应用外也可触发。
                    </p>
                </div>
                <button
                    data-name="settings-shortcuts-reset-button"
                    onClick={handleResetAll}
                    className="shrink-0 self-start text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]
                               border border-[var(--border)] hover:border-[var(--border-emphasis)]
                               hover:bg-[var(--surface-muted)]
                               rounded-md px-2.5 py-1.5 transition-colors cursor-pointer"
                >
                    键位恢复默认
                </button>
            </div>

            <div className="grid grid-cols-1 gap-4">
                {GROUP_CARDS.map(({title, icon, group, staticItems}) => (
                    <GroupCard key={title} title={title} icon={icon}>
                        {group && (SHORTCUT_DEFS.filter(d => d.group === group)).map((def) => (
                            <ShortcutRow
                                key={def.id}
                                def={def}
                                current={effective[def.id]}
                                overrides={overrides}
                                onChange={handleOverrideChange}
                                globalFailure={globalFailures[def.id]}
                            />
                        ))}
                        {staticItems.map((item) => <StaticRow key={item.label} item={item}/>)}
                    </GroupCard>
                ))}
            </div>
        </div>
    )
}
