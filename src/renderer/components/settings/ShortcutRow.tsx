import React, {useEffect, useRef, useState} from 'react'
import {
    SHORTCUT_DEFS,
    eventToAccelerator, findConflicts, mergeOverrides,
    type ShortcutAction, type ShortcutDef,
} from '../../../shared/shortcuts'
import {shortcutManager} from '../../services/shortcutManager'
import {Kbd, formatShortcutSpoken} from '../common/Kbd'

interface Props {
    def: ShortcutDef
    current: string                                   // 当前生效 accelerator（已 normalize）
    overrides: Record<string, string>
    onChange: (id: ShortcutAction, acc: string | null) => void   // null = 恢复默认
    globalFailure?: string                            // 主进程注册失败原因
}

// 模块级单例：同一时刻仅允许一行处于录制态
let activeStop: (() => void) | null = null

/** 默认绑定表（常量，无需每次渲染重建） */
const DEFAULTS = mergeOverrides(undefined)

export function ShortcutRow({def, current, overrides, onChange, globalFailure}: Props) {
    const [recording, setRecording] = useState(false)
    const rowRef = useRef<HTMLDivElement>(null)

    const conflicts = findConflicts(mergeOverrides(overrides))
    const conflictWith = conflicts[current]?.filter(id => id !== def.id) ?? []
    const conflictLabels = conflictWith.length
        ? conflictWith.map(id => SHORTCUT_LABELS[id as ShortcutAction] ?? id).join('、') : null
    const isCustom = current !== DEFAULTS[def.id]

    // 录制：keydown 捕获 + Esc 取消 + Backspace 恢复默认 + 失焦取消
    useEffect(() => {
        if (!recording) return
        activeStop?.() // 互斥：若已有其他行在录制，先令其退出
        let stopped = false
        const stop = () => {
            if (stopped) return
            stopped = true
            if (activeStop === stop) activeStop = null
            shortcutManager.setRecording(false)
            setRecording(false)
            window.removeEventListener('keydown', onKey, true)
            window.removeEventListener('blur', onBlur)
        }
        activeStop = stop
        shortcutManager.setRecording(true)
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault()
            e.stopImmediatePropagation()
            if (e.key === 'Escape') { stop(); return }
            if (e.key === 'Backspace') { stop(); onChange(def.id, null); return }
            const acc = eventToAccelerator(e, IS_MAC)
            if (!acc) return // 纯修饰键/非法：忽略，继续录制
            stop()
            onChange(def.id, acc)
        }
        const onBlur = () => stop()
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('blur', onBlur)
        return stop
    }, [recording])

    return (
        <div
            ref={rowRef}
            className="flex flex-wrap items-center justify-between gap-y-1 px-4 py-2.5
                       hover:bg-[var(--surface-muted)]/40 transition-colors"
        >
            <span className="text-sm text-[var(--text-primary)]">{def.label}</span>
            <div className="flex items-center gap-2 shrink-0 ml-4">
                <button
                    aria-label={`${def.label} 快捷键：${formatShortcutSpoken(current)}`}
                    onClick={() => setRecording(true)}
                    className={`inline-flex items-center justify-center gap-1 px-1 py-0.5 text-[11px]
                                min-h-[24px] leading-none select-none rounded-md outline-none
                                transition-all duration-150 cursor-pointer
                                ${recording
                                    ? 'ring-2 ring-[var(--brand-primary)] bg-[var(--brand-muted)] px-2 shadow-[0_0_10px_-2px_var(--brand-primary)] scale-[1.02]'
                                    : 'bg-transparent border border-transparent hover:bg-[var(--surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]'}`}
                >
                    {recording && (
                        <span aria-hidden="true"
                              className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] animate-pulse shrink-0"/>
                    )}
                    {recording
                        ? '按下组合键…'
                        : current.split('+').map((key, i) => (
                            <React.Fragment key={`${key}-${i}`}>
                                {i > 0 && <span aria-hidden="true" className="text-[10px] text-[var(--text-muted)]">+</span>}
                                <Kbd>{key}</Kbd>
                            </React.Fragment>
                        ))}
                </button>
                {isCustom && (
                    <button
                        onClick={() => onChange(def.id, null)}
                        aria-label={`重置 ${def.label} 为默认快捷键`}
                        title={`重置 ${def.label} 为默认快捷键`}
                        className="inline-flex items-center text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]
                                   border border-[var(--border-muted)] rounded px-1.5 h-[24px] leading-none
                                   hover:border-[var(--brand-primary)] transition-colors cursor-pointer"
                    >
                        重置
                    </button>
                )}
            </div>
            {conflictLabels && (
                <p className="w-full flex items-center gap-1 text-[10px] text-[var(--warning)]">
                    <span aria-hidden="true" className="w-1 h-1 rounded-full bg-[var(--warning)] shrink-0"/>
                    与「{conflictLabels}」冲突，仅第一个生效
                </p>
            )}
            {globalFailure && (
                <p className="w-full flex items-center gap-1 text-[10px] text-[var(--error)]">
                    <span aria-hidden="true" className="w-1 h-1 rounded-full bg-[var(--error)] shrink-0"/>
                    {globalFailure}
                </p>
            )}
        </div>
    )
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
const SHORTCUT_LABELS: Record<string, string> =
    Object.fromEntries(SHORTCUT_DEFS.map(d => [d.id, d.label]))
