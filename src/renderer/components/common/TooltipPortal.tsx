import {useEffect, useLayoutEffect, useRef, useState} from 'react'
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

/**
 * 触发 tooltip 的元素选择器（单一真源，mouseover/mouseout 共用）。
 * data-tooltip-active 是接管标记：mouseover 进入时原生 title 会被移除，
 * 元素失配 [title] 后后续的 mouseover/mouseout 将无法命中（closest 返回
 * null → 走进 !el 分支 → 100ms 后 tooltip 被隐藏，表现为"悬停闪现一下"），
 * 因此接管时必须打上标记保证选择器持续命中。
 */
const TOOLTIP_SELECTOR = '[title], [data-tooltip], [data-tooltip-active]'

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
    whiteSpace: 'pre-line',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: 2147483647,
    transition: 'opacity 0.15s ease-out',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

type TooltipPlacement = 'above' | 'below' | 'right'

type TooltipState = {text: string; x: number; y: number; placement: TooltipPlacement; minX: number} | null

/** tooltip 自身高度估算（11px 字体 + 8px 垂直 padding + 2px 边框 ≈ 21px），
 *  用于空间检测：下方剩余空间不足时翻转到元素上方 */
const TOOLTIP_HEIGHT_ESTIMATE = 30

export default function TooltipPortal() {
    const [tooltip, setTooltip] = useState<TooltipState>(null)
    const hideTimer = useRef<number | null>(null)
    const tipRef = useRef<HTMLDivElement | null>(null)
    // 左缘钳制：居中放置时 tooltip 半宽可能越过触发元素左缘（会话列表
    // 靠窗口左侧时会溢出窗口）。渲染后测量实际宽度，若越界则改为与触发元素
    // 左缘对齐（取消 X 方向位移）。useLayoutEffect 在绘制前同步修正，无闪烁。
    const [clamped, setClamped] = useState(false)

    useLayoutEffect(() => {
        const el = tipRef.current
        if (!tooltip || !el || tooltip.placement === 'right') {
            setClamped(false)
            return
        }
        setClamped(tooltip.x - el.offsetWidth / 2 < tooltip.minX)
    }, [tooltip])

    useEffect(() => {
        const handleMouseOver = (e: MouseEvent) => {
            const el = (e.target as HTMLElement).closest<HTMLElement>(TOOLTIP_SELECTOR)
            if (!el) {
                // 延迟隐藏，防止移动到子元素时闪烁。
                // 必须先清除旧的 hideTimer：快速移动时鼠标连续扫过多个无 title
                // 元素会产生多个 mouseover，直接覆盖引用会让先前 timer 泄漏，
                // 在进入元素显示 tooltip 后仍到期 setTooltip(null) ——
                // 表现为"从右侧快速进入时 tooltip 闪现即消失"的竞态根因。
                if (hideTimer.current) clearTimeout(hideTimer.current)
                hideTimer.current = window.setTimeout(() => setTooltip(null), 100)
                return
            }

            // mouseenter 语义：鼠标在元素内部（含子元素）移动时也会触发 mouseover，
            // 若 relatedTarget 仍在 el 内则视为内部移动——不重置/不重新触发，
            // 避免 tooltip 在子元素边界处反复显隐（"闪一下消失"的根因）
            const related = e.relatedTarget as HTMLElement | null
            if (related && el.contains(related)) return

            // 替换原生 title，避免两者同时显示。
            // 注意：title 已被本组件移除时（getAttribute 为 null）不能覆盖
            // dataset.titleOriginal，否则残留值会被覆盖成 "null"
            if (el.getAttribute('title')) {
                el.dataset.titleOriginal = el.getAttribute('title')!
                el.removeAttribute('title')
                // 接管标记：title 移除后 closest 依赖它继续命中该元素
                el.dataset.tooltipActive = '1'
            }

            const text = el.dataset.tooltip || el.dataset.titleOriginal
            if (!text) {
                // 命中选择器但无文本（如重渲染后残留 data-tooltip-active 标记的元素）：
                // 不能提前 return——否则旧 tooltip 既不排隐藏 timer 也不清除，永久滞留。
                // 与 !el 分支同语义：清除旧 timer 后延迟隐藏。
                if (hideTimer.current) clearTimeout(hideTimer.current)
                hideTimer.current = window.setTimeout(() => setTooltip(null), 100)
                // 残留标记清理：标记存在但 titleOriginal 已丢失 → 恢复不了 title，
                // 只删标记让该元素退出选择器命中范围
                if (el.dataset.tooltipActive && !el.dataset.titleOriginal) {
                    delete el.dataset.tooltipActive
                }
                return
            }

            clearTimeout(hideTimer.current!)
            hideTimer.current = null

            const rect = el.getBoundingClientRect()
            // 放置方向：data-tooltip-placement="right" 显式指定（折叠侧边栏图标：
            // 窄条居中锚定会让长文本向左溢出窗口左缘，右侧锚定单行向右延伸最稳妥）；
            // 否则空间检测——默认显示在元素下方，下方剩余空间不足时（footer /
            // 窗口底部附近）翻转到元素上方，避免 tooltip 超出视口底边不可见。
            const spaceBelow = window.innerHeight - rect.bottom
            let placement: TooltipPlacement = 'above'
            if (el.dataset.tooltipPlacement === 'right') {
                placement = 'right'
            } else {
                placement = spaceBelow < TOOLTIP_HEIGHT_ESTIMATE + 12 ? 'above' : 'below'
            }
            const x = placement === 'right'
                ? rect.right + 8
                : rect.left + rect.width / 2
            const y = placement === 'right'
                ? rect.top + rect.height / 2
                : placement === 'above'
                    ? rect.top - 6
                    : rect.bottom + 6
            setTooltip({text, x, y, placement, minX: rect.left})
        }

        const handleMouseOut = (e: MouseEvent) => {
            const el = (e.target as HTMLElement).closest<HTMLElement>(TOOLTIP_SELECTOR)
            if (!el) return

            // mouseleave 语义：鼠标移到元素内部子元素（relatedTarget 仍在 el 内）
            // 不算离开——不隐藏 tooltip，也不恢复 title，保证 hover 期间持续显示
            const related = e.relatedTarget as HTMLElement | null
            if (related && el.contains(related)) return

            clearTimeout(hideTimer.current!)
            hideTimer.current = null
            setTooltip(null)

            if (el.dataset.titleOriginal) {
                el.setAttribute('title', el.dataset.titleOriginal)
                delete el.dataset.titleOriginal
                delete el.dataset.tooltipActive
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
            ref={tipRef}
            className="tooltip-portal"
            style={{
                ...TOOLTIP_STYLE,
                opacity: tooltip ? 1 : 0,
                top: tooltip?.y ?? -9999,
                // 钳制时：左缘与触发元素对齐，取消 X 位移（Y 位移保留）
                left: clamped && tooltip ? tooltip.minX : (tooltip?.x ?? -9999),
                transform: clamped && tooltip
                    ? (tooltip.placement === 'above' ? 'translateY(-100%)' : 'none')
                    : (tooltip?.placement === 'right'
                        ? 'translateY(-50%)'
                        : tooltip?.placement === 'above'
                            ? 'translate(-50%, -100%)'
                            : 'translateX(-50%)'),
            }}
        >
            {tooltip?.text ?? ''}
        </div>,
        document.body,
    )
}
