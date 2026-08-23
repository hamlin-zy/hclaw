import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'

/**
 * TooltipPortal — 全局 title tooltip 兜底组件
 *
 * 背景：各平台默认的原生 title tooltip（尤其 Windows Chromium 的白条黑字）
 * 不符合应用设计语言；macOS hiddenInset 模式下标题栏区域亦不生效，
 * 且 CSS ::after 伪元素会被 overflow: hidden 祖先容器裁剪。
 *
 * 方案：全局监听 mouseover/mouseout，在 document.body 上通过 Portal 渲染
 * 主题化 tooltip，突破所有 overflow 容器限制，并覆盖原生 tooltip。
 */

/** 触发 tooltip 的元素选择器（单一真源，mouseover/mouseout 共用） */
const TOOLTIP_SELECTOR = '[title], [data-tooltip]'

const TOOLTIP_STYLE: React.CSSProperties = {
    position: 'fixed',
    padding: '4px 8px',
    // 主题化浮层样式，与 CacheRateTooltip 等自定义 tooltip 保持同一设计语言：
    // surface-elevated 底 + border 描边 + overlay 阴影，4 套主题自动适配
    background: 'var(--surface-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-overlay)',
    fontSize: '11px',
    fontWeight: 400,
    whiteSpace: 'nowrap',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: 2147483647,
    transition: 'opacity 0.15s ease-out',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

type TooltipState = {text: string; x: number; y: number} | null

export default function TooltipPortal() {
    const [tooltip, setTooltip] = useState<TooltipState>(null)
    const hideTimer = useRef<number | null>(null)

    useEffect(() => {
        const handleMouseOver = (e: MouseEvent) => {
            const el = (e.target as HTMLElement).closest<HTMLElement>(TOOLTIP_SELECTOR)
            if (!el) {
                // 延迟隐藏，防止移动到子元素时闪烁
                hideTimer.current = window.setTimeout(() => setTooltip(null), 100)
                return
            }

            // 替换原生 title，避免两者同时显示
            if (el.getAttribute('title')) {
                el.dataset.titleOriginal = el.getAttribute('title')!
                el.removeAttribute('title')
            }

            const text = el.dataset.tooltip || el.dataset.titleOriginal
            if (!text) return

            clearTimeout(hideTimer.current!)
            hideTimer.current = null

            const rect = el.getBoundingClientRect()
            setTooltip({text, x: rect.left + rect.width / 2, y: rect.bottom + 6})
        }

        const handleMouseOut = (e: MouseEvent) => {
            const el = (e.target as HTMLElement).closest<HTMLElement>(TOOLTIP_SELECTOR)
            if (!el) return

            clearTimeout(hideTimer.current!)
            hideTimer.current = null
            setTooltip(null)

            if (el.dataset.titleOriginal) {
                el.setAttribute('title', el.dataset.titleOriginal)
                delete el.dataset.titleOriginal
            }
        }

        document.addEventListener('mouseover', handleMouseOver)
        document.addEventListener('mouseout', handleMouseOut)

        return () => {
            document.removeEventListener('mouseover', handleMouseOver)
            document.removeEventListener('mouseout', handleMouseOut)
            if (hideTimer.current) clearTimeout(hideTimer.current)
        }
    }, [])

    return createPortal(
        <div
            className="tooltip-portal"
            style={{
                ...TOOLTIP_STYLE,
                opacity: tooltip ? 1 : 0,
                top: tooltip?.y ?? -9999,
                left: tooltip?.x ?? -9999,
                transform: 'translateX(-50%)',
            }}
        >
            {tooltip?.text ?? ''}
        </div>,
        document.body,
    )
}
