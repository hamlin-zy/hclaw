import React from 'react'

/** 是否 macOS：用于将修饰键显示为 Mac 惯例符号（Ctrl→⌘、Alt→⌥） */
const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

/** 将修饰键名转换为平台惯例显示名（Linux/Windows 保持 Ctrl/Alt 不变） */
function displayKey(key: string): string {
    if (!isMac) return key
    if (key === 'Ctrl') return '⌘'
    if (key === 'Alt') return '⌥'
    return key
}

/** 单键样式 */
export function Kbd({children}: { children: React.ReactNode }) {
    const display = typeof children === 'string' ? displayKey(children) : children
    return (
        <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 text-[11px] font-mono font-semibold
                        bg-[var(--surface-overlay)] text-[var(--text-secondary)]
                        border border-[var(--border-emphasis)] rounded-md
                        shadow-[0_1px_1px_rgba(0,0,0,0.08)]
                        min-w-[22px] h-[18px] leading-none
                        select-none">
            {display}
        </kbd>
    )
}

/** 组合键：Ctrl + Shift + X
 *
 * keys 支持嵌套数组，内层数组的元素之间不渲染 "+" 分隔符。
 * 例：['Alt', ['↑', '↓']] → Alt + ↑ ↓
 *     ['Ctrl', 'Shift', 'B'] → Ctrl + Shift + B
 * */
export function KbdCombo({keys}: { keys: (string | string[])[] }) {
    const renderItem = (item: string | string[], index: number, showSep: boolean) => {
        if (Array.isArray(item)) {
            return (
                <React.Fragment key={`g-${index}`}>
                    {showSep && <span className="text-[10px] text-[var(--text-muted)] mx-0.5">+</span>}
                    {item.map(k => <Kbd key={k}>{k}</Kbd>)}
                </React.Fragment>
            )
        }
        return (
            <React.Fragment key={item}>
                {showSep && <span className="text-[10px] text-[var(--text-muted)] mx-0.5">+</span>}
                <Kbd>{item}</Kbd>
            </React.Fragment>
        )
    }

    return (
        <div className="flex items-center gap-0.5">
            {keys.map((key, i) => renderItem(key, i, i > 0))}
        </div>
    )
}
