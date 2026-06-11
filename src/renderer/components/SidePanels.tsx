import {useCallback, useEffect, useRef, useState} from 'react'
import PermissionRulesPanel from './PermissionRulesPanel'
import TodoPanel from './TodoPanel'
import PanelResizer from './PanelResizer'
import {useSidebarStore} from '../stores/sidebarStore'

/**
 * 侧边面板容器 - 包含权限规则面板和待办列表面板
 *
 * 支持拖动分隔条来调整两个面板的高度比例。
 */
export default function SidePanels() {
    const {rightCollapsed, setRightCollapsed} = useSidebarStore()
    const [topPanelHeight, setTopPanelHeight] = useState(70) // 权限规则 70%，待办列表 30%
    const containerRef = useRef<HTMLDivElement>(null)
    const isInitializedRef = useRef(false)

    // 从 localStorage 恢复上次的面板比例
    useEffect(() => {
        if (!isInitializedRef.current) {
            const saved = localStorage.getItem('side-panels-ratio')
            if (saved !== null) {
                setTopPanelHeight(parseFloat(saved))
            }
            isInitializedRef.current = true
        }
    }, [])

    // 保存面板比例到 localStorage
    useEffect(() => {
        if (isInitializedRef.current) {
            localStorage.setItem('side-panels-ratio', topPanelHeight.toString())
        }
    }, [topPanelHeight])

    const handleResizerDrag = useCallback((clientY: number) => {
        if (!containerRef.current) return

        const containerRect = containerRef.current.getBoundingClientRect()
        const containerTop = containerRect.top
        const containerHeight = containerRect.height
        const resizerHeight = 4 // 分隔条高度

        // 计算鼠标相对于容器顶部的位置（减去分隔条高度的一半，使鼠标居中于分隔条）
        const mouseRelativeY = clientY - containerTop - (resizerHeight / 2)

        const minHeight = 100 // 每个面板最小高度 100px
        const maxTopHeight = containerHeight - resizerHeight - minHeight

        // 限制范围：最小100px，最大不超过容器85%
        let clampedHeight = mouseRelativeY
        const maxPercentage = 85 // 最大占比85%

        if (clampedHeight < minHeight) {
            clampedHeight = minHeight
        } else if (clampedHeight > maxTopHeight) {
            clampedHeight = maxTopHeight
        }

        // 转换为百分比
        let newPercentage = (clampedHeight / containerHeight) * 100

        // 限制最大占比不超过85%
        if (newPercentage > maxPercentage) {
            newPercentage = maxPercentage
            clampedHeight = (maxPercentage / 100) * containerHeight
        } else if (newPercentage < (100 - maxPercentage)) {
            newPercentage = 100 - maxPercentage
            clampedHeight = (newPercentage / 100) * containerHeight
        }

        setTopPanelHeight(newPercentage)
    }, [])

    return (
        <div
            ref={containerRef}
            className="relative flex flex-col overflow-hidden h-full"
        >
            {/* 权限规则面板 */}
            <div style={{height: `${topPanelHeight}%`}}>
                <PermissionRulesPanel height="100%"/>
            </div>

            {/* 分隔条 */}
            <div className="h-1 flex items-center justify-center">
                <PanelResizer onDrag={handleResizerDrag}/>
            </div>

            {/* 待办列表面板 */}
            <div style={{height: `${100 - topPanelHeight}%`}}>
                <TodoPanel height="100%"/>
            </div>

            {/* 左侧边缘折叠按钮 */}
            <button
                onClick={() => setRightCollapsed(true)}
                aria-label="折叠右侧面板"
                className="absolute top-0 h-full flex items-center z-50"
                style={{left: '-24px'}}
            >
                <div
                    className="w-6 h-20 rounded-l flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--surface-muted)] transition-colors">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </div>
            </button>
        </div>
    )
}
