// 快捷键键位卡公共原语（卡外壳 + 静态键位行）：设置页与 PM 快捷键说明弹窗共用同一真源
import type {ComponentType, ReactNode} from 'react'
import type {IconProps} from '../icons'

export type ShortcutEntry = { label: string; keys: ReactNode }

/** 键位卡外壳：组标题条 + divide-y 行容器（可自定义组的行经 children 传入）
    公共原语，设置页与 PM 快捷键说明弹窗共用 */
export function GroupCard({title, icon: GroupIcon, children}: { title: string; icon: ComponentType<IconProps>; children: ReactNode }) {
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

/** 不支持自定义的静态键位行（跟随组展示，只读）
    公共原语，设置页与 PM 快捷键说明弹窗共用 */
export function StaticRow({item}: { item: ShortcutEntry }) {
    return (
        <div className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--surface-muted)] transition-colors">
            <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
            <div className="flex items-center gap-1 shrink-0 ml-4">
                {item.keys}
            </div>
        </div>
    )
}
