import {useEffect, useRef, useState} from 'react'

interface PanelResizerProps {
    onDrag: (clientY: number) => void
    onDragEnd?: () => void
    className?: string
}

/**
 * 面板分隔条 - 水平拖动分隔条
 *
 * 放在两个垂直排列的面板之间，允许用户拖动调整高度比例。
 */
export default function PanelResizer({onDrag, onDragEnd, className = ''}: PanelResizerProps) {
    const resizerRef = useRef<HTMLDivElement>(null)
    const onDragRef = useRef<(clientY: number) => void>(onDrag)
    const onDragEndRef = useRef<(() => void) | undefined>(onDragEnd)
    const [isDragging, setIsDragging] = useState(false)
    const [isHovering, setIsHovering] = useState(false)

    // 始终保持 ref 指向最新的回调函数
    useEffect(() => {
        onDragRef.current = onDrag
        onDragEndRef.current = onDragEnd
    }, [onDrag, onDragEnd])

    useEffect(() => {
        const resizer = resizerRef.current
        if (!resizer) return

        const handleMouseDown = (e: MouseEvent) => {
            e.preventDefault()
            setIsDragging(true)

            // 添加全局事件监听
            document.addEventListener('mousemove', handleMouseMove)
            document.addEventListener('mouseup', handleMouseUp)
            document.body.style.cursor = 'row-resize'
            document.body.style.userSelect = 'none'
        }

        const handleMouseMove = (e: MouseEvent) => {
            // 通过 ref 调用最新的回调
            onDragRef.current(e.clientY)
        }

        const handleMouseUp = () => {
            setIsDragging(false)
            // 通过 ref 调用最新的回调
            onDragEndRef.current?.()

            // 移除全局事件监听
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
        }

        resizer.addEventListener('mousedown', handleMouseDown)

        return () => {
            resizer.removeEventListener('mousedown', handleMouseDown)
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }
    }, []) // 空依赖数组，只在挂载时运行一次

    return (
        <div
            ref={resizerRef}
            className={`
                flex shrink-0 items-center justify-center
                transition-colors duration-150
                ${isDragging ? 'bg-[var(--brand-primary)]/10' : 'hover:bg-[var(--surface-muted)]'}
                ${isHovering ? 'cursor-row-resize' : 'cursor-default'}
                ${className}
            `}
            style={{height: '4px', minHeight: '4px'}}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
        >
            {/* 拖动手柄指示器 */}
            <div
                className={`
                    flex items-center gap-0.5 transition-opacity duration-150
                    ${isDragging || isHovering ? 'opacity-100' : 'opacity-0'}
                `}
            >
                <div className="w-8 h-0.5 rounded-full bg-[var(--text-muted)]"/>
                <div className="w-8 h-0.5 rounded-full bg-[var(--text-muted)]"/>
                <div className="w-8 h-0.5 rounded-full bg-[var(--text-muted)]"/>
            </div>
        </div>
    )
}
