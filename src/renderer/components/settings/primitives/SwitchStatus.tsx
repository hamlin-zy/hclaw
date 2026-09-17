/**
 * 开关的状态文案：「已启用 / 已禁用」并按状态取色（spec §3.1 开关行统一形态）。
 *
 * 渲染出的 class 与文案与各站点原内联 span 逐字一致；`className` 用于各站点保留自身间距
 * （如 FormRow 内需要 `ml-2`），传空时不产生多余空格。
 */
export default function SwitchStatus({on, className}: {on: boolean; className?: string}) {
    const prefix = className ? `${className} ` : ''
    const stateClass = on ? 'text-[var(--text-brand)]' : 'text-[var(--text-secondary)]'
    return (
        <span className={`${prefix}text-xs font-medium ${stateClass}`}>
            {on ? '已启用' : '已禁用'}
        </span>
    )
}
