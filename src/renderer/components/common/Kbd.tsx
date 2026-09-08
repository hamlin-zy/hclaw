import React from 'react'

/** 是否 macOS：用于将修饰键显示为 Mac 惯例符号（Ctrl→⌘、Alt→⌥） */
const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

/** 平台无关存储名 → 本平台按键名：CommandOrControl 按系统解析为 ⌘(mac) / Ctrl(其他)；方向键显示为箭头符号 */
const PLATFORM_KEY: Record<string, string> = {
    CommandOrControl: isMac ? '⌘' : 'Ctrl',
    Up: '↑', Down: '↓', Left: '←', Right: '→',
}

/** 将修饰键名转换为平台惯例显示名（Linux/Windows 保持 Ctrl/Alt 不变） */
function displayKey(key: string): string {
    if (PLATFORM_KEY[key]) return PLATFORM_KEY[key]
    if (!isMac) return key
    if (key === 'Ctrl') return '⌘'
    if (key === 'Alt') return '⌥'
    return key
}

/** 修饰键翻译表：[显示符号, 无障碍朗读名]，未列出的键原样返回 */
const MAC_MODIFIER: Record<string, [string, string]> = {
    Ctrl: ['⌘', 'Command'],
    Shift: ['⇧', 'Shift'],
    Alt: ['⌥', 'Option'],
}

const mapShortcut = (shortcut: string, translate: (key: string) => string): string =>
    shortcut
        .split('+')
        .map(part => translate(part.trim()))
        .join('+')

/** 将 "Ctrl+Shift+B" 这类快捷键字符串按平台转换为显示文本（mac 上为 ⌘⇧B 风格，CommandOrControl 按系统解析） */
export function formatShortcut(shortcut: string): string {
    return mapShortcut(shortcut, key => PLATFORM_KEY[key] ?? (isMac ? MAC_MODIFIER[key]?.[0] ?? key : key))
}

/**
 * 将快捷键转换为无障碍朗读文本（aria-label 用）：mac 上修饰键用全称拼写
 * （Ctrl→Command、Alt→Option），其他平台保持原样（Ctrl/Alt 本身即全称）。
 * 视觉 tooltip 用 formatShortcut（符号风格），朗读文本用本函数。
 */
/** 无障碍朗读名表（常量）：CommandOrControl 按系统解析，其余走 MAC_MODIFIER */
const SPOKEN_KEY: Record<string, string> = {
    CommandOrControl: isMac ? 'Command' : 'Ctrl',
}

export function formatShortcutSpoken(shortcut: string): string {
    return mapShortcut(shortcut, key => SPOKEN_KEY[key] ?? (isMac ? MAC_MODIFIER[key]?.[1] ?? key : key))
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
