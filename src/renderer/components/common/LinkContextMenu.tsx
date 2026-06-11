import React, {useEffect, useRef} from 'react'

interface LinkContextMenuProps {
    visible: boolean
    x: number
    y: number
    url: string
    onClose: () => void
}

export default function LinkContextMenu({visible, x, y, url, onClose}: LinkContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null)

    // 点击外部或 Escape 关闭
    useEffect(() => {
        if (!visible) return

        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose()
            }
        }

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }

        // 延迟添加，避免触发创建时的点击事件
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside)
            document.addEventListener('keydown', handleEscape)
        }, 0)

        return () => {
            clearTimeout(timer)
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [visible, onClose])

    if (!visible) return null

    // 菜单显示在点击位置右侧偏移 10px
    const posX = x + 10
    const posY = y
    console.log('[LinkContextMenu]', {x, y, posX, posY})

    const handleOpen = (mode: 'builtin' | 'system') => {
        (mode === 'builtin' ? window.electronAPI?.openBuiltin : window.electronAPI?.openSystem)?.(url)
        onClose()
    }

    return (
        <div
            ref={menuRef}
            className="fixed z-[9999] min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] shadow-2xl overflow-hidden animate-context-menu-enter"
            style={{
                left: posX,
                top: posY,
            }}
        >
            <div
                className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)] cursor-pointer transition-colors"
                onClick={() => handleOpen('builtin')}
            >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                    <line x1="1" y1="6.5" x2="15" y2="6.5" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
                <span>内置浏览器打开</span>
            </div>
            <div
                className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-muted)] cursor-pointer transition-colors border-t border-[var(--border-muted)]"
                onClick={() => handleOpen('system')}
            >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M4 14L12 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <path d="M8 8L8 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <path d="M3 11L13 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                <span>系统浏览器打开</span>
            </div>
        </div>
    )
}
