import InfoTip from './InfoTip'

/** 左标签（+InfoTip+可选说明）右控件的表单行（spec §4.1） */
export default function FormRow({label, tip, description, children}: {
    label: string
    tip?: string
    description?: string
    children: React.ReactNode
}) {
    return (
        <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
                <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                    {label}
                    {tip && <InfoTip text={tip}/>}
                </label>
                {description && <span className="text-[10px] text-[var(--text-secondary)]">{description}</span>}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    )
}
