import {AnimatePresence, motion} from 'framer-motion'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

interface MenuDialogProps {
  isOpen: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  maxWidth?: number
  minWidth?: number
  origin?: { x: number; y: number } | null
  dialogKey?: string
  initialHeight?: number
}

const DEFAULT_MIN_WIDTH = 420
const MIN_HEIGHT = 240
const MAX_WIDTH_RATIO = 0.9

type ResizeEdge = 'right' | 'bottom' | 'left' | 'top'

/** 可拖拽悬浮 Modal — 内部业务 Dialog 通过 flex-1 铺满，跟随大小变化 */
export default function MenuDialog({isOpen, title, onClose, children, maxWidth = 580, minWidth = DEFAULT_MIN_WIDTH, origin, dialogKey, initialHeight}: MenuDialogProps) {
    const [width, setWidth] = useState(maxWidth)
    const [height, setHeight] = useState(() => initialHeight ?? Math.floor(window.innerHeight * 0.85))
    const [position, setPosition] = useState({x: 0, y: 0})
    const cardRef = useRef<HTMLDivElement>(null)
    const dragRef = useRef({isDragging: false, startX: 0, startY: 0, posX: 0, posY: 0})

    // 打开时居中
    useEffect(() => {
        if (isOpen) {
            const initH = initialHeight ?? Math.floor(window.innerHeight * 0.85)
            setWidth(maxWidth)
            setHeight(initH)
            setPosition({
                x: Math.floor((window.innerWidth - maxWidth) / 2),
                y: Math.max(0, Math.floor((window.innerHeight - initH) / 2)),
            })
        }
    }, [isOpen, maxWidth])

    // ESC 关闭
    useEffect(() => {
        if (!isOpen) return
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [isOpen, onClose])

    // ─── 拖拽移动 ───────────────────────────────────────────

    const handleDragStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        dragRef.current = {
            isDragging: true,
            startX: e.clientX,
            startY: e.clientY,
            posX: position.x,
            posY: position.y,
        }
        document.addEventListener('mousemove', handleDragMove)
        document.addEventListener('mouseup', handleDragEnd)
        document.body.style.userSelect = 'none'
    }, [position]) // eslint-disable-line react-hooks/exhaustive-deps

    const handleDragMove = useCallback((e: MouseEvent) => {
        if (!dragRef.current.isDragging) return
        const dx = e.clientX - dragRef.current.startX
        const dy = e.clientY - dragRef.current.startY
        setPosition({
            x: dragRef.current.posX + dx,
            y: dragRef.current.posY + dy,
        })
    }, [])

    const handleDragEnd = useCallback(() => {
        dragRef.current.isDragging = false
        document.removeEventListener('mousemove', handleDragMove)
        document.removeEventListener('mouseup', handleDragEnd)
        document.body.style.userSelect = ''
    }, [handleDragMove])

    // ─── 四边调整大小 ───────────────────────────────────────

    const CURSOR_MAP: Record<ResizeEdge, string> = {
        right: 'ew-resize',
        bottom: 'ns-resize',
        left: 'ew-resize',
        top: 'ns-resize',
    }

    const handleResizeStart = useCallback((edge: ResizeEdge, e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const startX = e.clientX
        const startY = e.clientY
        const startW = cardRef.current?.offsetWidth ?? width
        const startH = cardRef.current?.offsetHeight ?? height
        const startPosX = position.x
        const startPosY = position.y
        const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
        const maxH = Math.floor(window.innerHeight * 0.85)

        document.body.style.userSelect = 'none'
        document.body.style.cursor = CURSOR_MAP[edge]

        const onMouseMove = (e: MouseEvent) => {
            const deltaX = e.clientX - startX
            const deltaY = e.clientY - startY

            let newW = startW
            let newH = startH
            let newX = startPosX
            let newY = startPosY

            if (edge === 'right') {
                newW = Math.max(minWidth, Math.min(maxW, startW + deltaX))
            } else if (edge === 'left') {
                newW = Math.max(minWidth, Math.min(maxW, startW - deltaX))
                newX = startPosX + (startW - newW) // 保持右边不动
            }

            if (edge === 'bottom') {
                newH = Math.max(MIN_HEIGHT, Math.min(maxH, startH + deltaY))
            } else if (edge === 'top') {
                newH = Math.max(MIN_HEIGHT, Math.min(maxH, startH - deltaY))
                newY = startPosY + (startH - newH) // 保持下边不动
            }

            setWidth(newW)
            setHeight(newH)
            setPosition({x: newX, y: newY})
        }

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove)
            document.removeEventListener('mouseup', onMouseUp)
            document.body.style.userSelect = ''
            document.body.style.cursor = 'default'
        }

        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
    }, [width, height, position])

    // ─── 右下角同时调整宽高 ─────────────────────────────────

    const handleCornerResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const startX = e.clientX
        const startY = e.clientY
        const startW = cardRef.current?.offsetWidth ?? width
        const startH = cardRef.current?.offsetHeight ?? height
        const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
        const maxH = Math.floor(window.innerHeight * 0.85)

        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'se-resize'

        const onMouseMove = (e: MouseEvent) => {
            const deltaX = e.clientX - startX
            const deltaY = e.clientY - startY
            setWidth(Math.max(minWidth, Math.min(maxW, startW + deltaX)))
            setHeight(Math.max(MIN_HEIGHT, Math.min(maxH, startH + deltaY)))
        }

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove)
            document.removeEventListener('mouseup', onMouseUp)
            document.body.style.userSelect = ''
            document.body.style.cursor = 'default'
        }

        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
    }, [width, height])

    // ─── 展开动画的原点 ────────────────────────────────────

    const originStyle = useMemo(() => {
        if (!origin || typeof window === 'undefined') {
            return {transformOrigin: 'center center'} as const
        }
        return {transformOrigin: `${origin.x - position.x}px ${origin.y - position.y}px`} as const
    }, [origin, position])

    const animTransition = useMemo(() => ({
        type: 'tween' as const,
        duration: 0.7,
        ease: [0.16, 1, 0.3, 1],
    }), [])

    const exitTransition = useMemo(() => ({
        type: 'tween' as const,
        duration: 0.4,
        ease: [0.4, 0, 1, 1],
    }), [])

    const modalKey = dialogKey || 'menu-dialog'
    const cardStyle = useMemo(() => ({
        left: position.x,
        top: position.y,
        width,
        height,
        ...originStyle,
    }), [position, width, height, originStyle])

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* 背景遮罩 */}
                    <motion.div
                        key="backdrop"
                        initial={{opacity: 0}}
                        animate={{opacity: 1, transition: {duration: 0.4, ease: 'easeOut'}}}
                        exit={{opacity: 0, transition: {duration: 0.3, ease: 'easeIn', delay: 0.05}}}
                        className="fixed inset-0 bg-black/20 z-[var(--z-modal-backdrop)]"
                        onClick={onClose}
                    />

                    {/* Modal 卡片 — fixed 定位 + 明确宽高，子元素 h-full 可解析到确定值 */}
                    <motion.div
                        key={`modal-${modalKey}`}
                        ref={cardRef}
                        className="fixed z-[var(--z-modal)] bg-[var(--surface)] rounded-xl shadow-elevated border border-[var(--border)] flex flex-col overflow-hidden"
                        style={cardStyle as any}
                        initial={{scale: 0, opacity: 0}}
                        animate={{scale: 1, opacity: 1, transition: animTransition} as any}
                        exit={{scale: 0, opacity: 0, transition: exitTransition} as any}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* 四边 resize 把手（不可见热区） */}
                        <div className="absolute inset-y-0 left-0 w-1 z-20 cursor-ew-resize" onMouseDown={(e) => handleResizeStart('left', e)} />
                        <div className="absolute inset-y-0 right-0 w-1 z-20 cursor-ew-resize" onMouseDown={(e) => handleResizeStart('right', e)} />
                        <div className="absolute inset-x-0 top-0 h-1 z-20 cursor-ns-resize" onMouseDown={(e) => handleResizeStart('top', e)} />
                        <div className="absolute inset-x-0 bottom-0 h-1 z-20 cursor-ns-resize" onMouseDown={(e) => handleResizeStart('bottom', e)} />

                        {/* 标题栏 — 拖拽把手 */}
                        <div
                            className="h-12 px-4 flex items-center justify-between border-b border-[var(--border)] shrink-0 cursor-grab active:cursor-grabbing select-none"
                            onMouseDown={handleDragStart}
                        >
                            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
                            <button
                                onClick={onClose}
                                className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                aria-label="关闭对话框"
                            >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                    <path d="M18 6L6 18M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>

                        {/* 内容 — flex-1 占满标题栏外的全部剩余空间，不自带滚动条 */}
                        <div className="flex-1 min-h-0 overflow-hidden">
                            {children}
                        </div>

                        {/* 右下角拖拽调整大小把手 */}
                        <div
                            className="absolute bottom-0 right-0 w-4 h-4 z-30 cursor-se-resize"
                            onMouseDown={handleCornerResizeStart}
                            title="拖拽调整大小"
                        >
                            <div className="absolute bottom-0.5 right-0.5 w-2.5 h-2.5 rounded-sm opacity-20 hover:opacity-50 transition-opacity"
                                style={{
                                    background: 'linear-gradient(135deg, transparent 50%, var(--text-muted) 50%)',
                                }}
                            />
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    )
}
