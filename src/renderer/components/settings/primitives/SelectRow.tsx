import type {ReactNode} from 'react'
import ThemedSelect, {type ThemedSelectOption} from '../../ThemedSelect'
import InfoTip from './InfoTip'

/**
 * 「标签 + InfoTip + 全宽下拉」行基元（spec §3.1 表单行统一形态）。
 *
 * label 与 select 分行（fullWidth）且文案不换行，避免布局挤压变形；
 * hint 是控件下方的补充说明（如「当前模式语义」类提示）。
 *
 * 收编站点均为 label class `flex items-center gap-1 … whitespace-nowrap` + 无 hint 提示色差异的行；
 * 「链接打开方式」（label 无 flex/nowrap）与「外观」（无 tip、选项含 disabled、尾随提示为 --warning）
 * 不属于本形态，仍各站点自渲染。
 */
export default function SelectRow({label, tip, hint, value, onChange, options, ariaLabel}: {
    label: string
    tip?: string
    hint?: ReactNode
    value: string
    onChange: (value: string) => void
    options: ThemedSelectOption[]
    ariaLabel?: string
}) {
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)] whitespace-nowrap">
                {label}{tip && <InfoTip text={tip}/>}
            </label>
            <ThemedSelect
                fullWidth
                value={value}
                onChange={onChange}
                options={options}
                ariaLabel={ariaLabel ?? label}
            />
            {hint && <p className="text-2xs text-[var(--text-secondary)]">{hint}</p>}
        </div>
    )
}
