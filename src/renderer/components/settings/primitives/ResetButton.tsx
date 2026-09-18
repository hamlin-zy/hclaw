import {useEffect, useRef, useState} from 'react'
import {useSettingsStore, type FieldPath} from '../../../stores/settingsStore'

/** 页面级「恢复本页默认」行：页首右对齐布局（各 Tab 页首统一形态，spec §5.1） */
export function PageResetRow({paths}: {paths: readonly FieldPath[]}) {
    return (
        <div className="flex justify-end">
            <ResetButton paths={paths}/>
        </div>
    )
}

/** 页面级「恢复本页默认」（spec §5.1）：仅写入 pending，不落盘；1.5s 文案反馈 */
export default function ResetButton({paths, idleText = '恢复本页默认', doneText = '已恢复默认'}: {
    paths: readonly FieldPath[]
    idleText?: string
    doneText?: string
}) {
    const [done, setDone] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
    const handleClick = () => {
        useSettingsStore.getState().resetFieldsToDefault([...paths])
        setDone(true)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setDone(false), 1500)
    }
    return (
        <button
            type="button"
            onClick={handleClick}
            className="text-xs px-2 py-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_40%,transparent)] transition-colors"
            // data-name 须全局唯一：用基元层命名，避免与既有站点撞名
            data-name="settings-primitives-reset-button"
        >
            <span aria-live="polite">{done ? doneText : idleText}</span>
        </button>
    )
}
