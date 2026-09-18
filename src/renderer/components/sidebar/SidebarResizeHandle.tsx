import {useCallback, useEffect, useRef} from 'react'
import {SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH} from '../../stores/sidebarStore'

/**
 * 左侧边栏拖拽调宽手柄。
 *
 * 拖拽协议照搬 project-manager/ui/SplitPane.tsx：mousedown 时同步注册 document 上的
 * mousemove/mouseup；拖动期**直改 DOM style、不走 React state**（避免逐帧重渲染 +
 * framer-motion 宽度动画/卡片 transition-all 抖动），mouseup 一次性提交 clamp 后的 px。
 * 卸载兜底成对摘除监听器，防孤儿监听泄漏。
 */
export function SidebarResizeHandle({onResizeEnd}: {onResizeEnd: (width: number) => void}) {
    const activeDragCleanupRef = useRef<(() => void) | null>(null)

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        // 只认左键（SplitPane 同口径）：右/中键不参与拖拽，也不吞掉右键菜单
        if (e.button !== 0) return
        e.preventDefault()
        const card = e.currentTarget.closest<HTMLElement>('[data-name="left-sidebar-card"]')
        if (!card) return
        // 内层 motion.div（ConversationSidebar 主体）：与外层卡片同步直改，否则
        // framer-motion 每次动画帧会以外层为准重设——双写保证拖动期两侧宽度一致
        const inner = card.querySelector<HTMLElement>('[data-name="conversation-sidebar-inner"]')

        const startX = e.clientX
        const startWidth = card.getBoundingClientRect().width
        const clamp = (px: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px))
        let current = startWidth

        // 拖动期临时禁用过渡（inline style 覆盖 transition-all 类），mouseup 恢复
        card.style.transition = 'none'
        if (inner) inner.style.transition = 'none'

        const onMove = (ev: MouseEvent) => {
            current = clamp(startWidth + (ev.clientX - startX))
            card.style.width = `${current}px`
            if (inner) inner.style.width = `${current}px`
        }
        const onUp = () => {
            cleanup()
            card.style.transition = ''
            if (inner) inner.style.transition = ''
            onResizeEnd(current)
            // 派发 resize：App.tsx 既有 onResize 监听会重算 positionDrawer，
            // 组抽屉打开时拖宽后定位不错位（零 plumbing 复用既有关节）
            window.dispatchEvent(new Event('resize'))
        }
        const cleanup = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
        }

        // 上一次拖拽未正常收尾时先摘旧监听（SplitPane 同口径，防孤儿监听器）
        activeDragCleanupRef.current?.()
        // 同步注册：同一事件循环内随后派发的 mousemove/mouseup 都能被处理
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
        activeDragCleanupRef.current = cleanup
    }, [onResizeEnd])

    // 卸载兜底：拖拽中途手柄被卸载（如折叠）时摘除 document 监听
    useEffect(() => () => {
        activeDragCleanupRef.current?.()
        activeDragCleanupRef.current = null
    }, [])

    return (
        <div
            data-name="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            onMouseDown={handleMouseDown}
            className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] transition-colors"
        />
    )
}
