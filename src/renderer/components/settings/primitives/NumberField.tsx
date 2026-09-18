import {useId} from 'react'
import {INPUT_FOCUS} from '../../../lib/inputFocus'
import InfoTip from './InfoTip'

export interface NumberFieldProps {
    label: string
    value: number
    onChange: (value: number) => void
    min?: number
    max?: number
    fallback: number
    decimals?: number
    disabled?: boolean
    /** 单位后缀（秒 / % / K …），渲染在输入框右侧 */
    unit?: string
    /** 标签旁 InfoTip 说明（原 description 迁入） */
    tip?: string
}

/** 非负数值钳位：undefined/NaN/负数 时回落到 fallback；0 视为合法（如"关闭"、"不重试"等语义）。 */
export function clampPositive(value: number | undefined, fallback: number): number {
    if (value === undefined || isNaN(value) || value < 0) return fallback
    return value
}

/** 带校验的数字输入框：NaN / 低于 min 时展示错误态与回退提示（旧实现语义逐字保持） */
export default function NumberField({
                                        label, value, onChange,
                                        min = 1, max, fallback, decimals = 0, disabled = false, unit, tip,
                                    }: NumberFieldProps) {
    // a11y（spec §4.6）：label htmlFor 与输入框 aria-describedby 经 useId 稳定绑定
    const inputId = useId()
    const tipId = useId()
    // 依据 min 判断：允许 0 的字段（如阈值/重试）不能硬编码「0 即危险」（旧注释语义）
    const isDangerous = isNaN(value) || value < min
    // 校验色用令牌（护栏：settings/ 目录禁止调色板类名）；正常态焦点边框由 INPUT_FOCUS 提供
    const stateClass = isDangerous ? 'border-[var(--error)] focus:border-[var(--error)]' : 'border-[var(--border)]'
    return (
        <div className="space-y-1">
            <label htmlFor={inputId} className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                {label}
                {tip && <InfoTip text={tip} id={tipId}/>}
            </label>
            <div className="relative">
                <input
                    id={inputId}
                    type="number"
                    step={decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : 1}
                    min={min}
                    max={max}
                    disabled={disabled}
                    aria-describedby={tip ? tipId : undefined}
                    className={`w-full bg-[var(--surface-muted)] border rounded px-3 py-1.5 text-xs outline-none ${unit ? 'pr-8' : ''} ${INPUT_FOCUS} ${stateClass}`}
                    value={value}
                    onChange={(e) => {
                        const parsed = decimals > 0 ? parseFloat(e.target.value) : parseInt(e.target.value)
                        onChange(parsed)
                    }}
                    // data-name 须全局唯一：用基元层命名，避免与既有站点撞名
                    data-name="settings-primitives-number-field-input"
                />
                {unit && (
                    // 单位后缀承载信息（5 秒 ≠ 5 次），按 globals.css 的 --text-muted 用途契约用 secondary
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--text-secondary)] pointer-events-none">{unit}</span>
                )}
            </div>
            {isDangerous && <p className="text-[10px] text-[var(--error)]">值无效，已还原为 {fallback}</p>}
        </div>
    )
}
