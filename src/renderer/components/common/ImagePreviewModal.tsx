/**
 * 图片预览弹窗组件
 * 支持：放大、缩小、拖动、旋转、鼠标滚轮缩放
 */

import {memo, useEffect, useCallback, useState, useRef} from 'react'
import {createPortal} from 'react-dom'

interface ContextMenuState {
    visible: boolean
    x: number
    y: number
}

interface ImagePreviewModalProps {
    src: string
    alt: string
    onClose: () => void
}

// 状态接口
interface Transform {
    scale: number
    translateX: number
    translateY: number
    rotation: number
}

const ImagePreviewModal = memo(function ImagePreviewModal({src, alt, onClose}: ImagePreviewModalProps) {
    const [transform, setTransform] = useState<Transform>({
        scale: 1,
        translateX: 0,
        translateY: 0,
        rotation: 0,
    })
    
    const containerRef = useRef<HTMLDivElement>(null)
    const isDragging = useRef(false)
    const lastPos = useRef({x: 0, y: 0})
    const [contextMenu, setContextMenu] = useState<ContextMenuState>({visible: false, x: 0, y: 0})
    const [copied, setCopied] = useState(false)
    
    // 重置到初始状态
    const resetTransform = useCallback(() => {
        setTransform({scale: 1, translateX: 0, translateY: 0, rotation: 0})
    }, [])
    
    // 缩放（以中心为基准）
    const zoom = useCallback((delta: number) => {
        setTransform(prev => {
            const newScale = Math.min(Math.max(prev.scale + delta, 0.1), 10)
            return {...prev, scale: newScale}
        })
    }, [])
    
    // 旋转
    const rotate = useCallback((degrees: number) => {
        setTransform(prev => ({...prev, rotation: prev.rotation + degrees}))
    }, [])

    // 关闭右键菜单（需要在 keyboard useEffect 之前定义）
    const closeContextMenu = useCallback(() => {
        setContextMenu(prev => ({...prev, visible: false}))
    }, [])

    // 键盘事件
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'Escape':
                    if (contextMenu.visible) {
                        closeContextMenu()
                    } else {
                        onClose()
                    }
                    break
                case '+':
                case '=':
                    e.preventDefault()
                    zoom(0.25)
                    break
                case '-':
                    e.preventDefault()
                    zoom(-0.25)
                    break
                case 'r':
                case 'R':
                    rotate(e.key === 'r' ? 90 : -90)
                    break
                case '0':
                    resetTransform()
                    break
                case 'ArrowLeft':
                    setTransform(prev => ({...prev, translateX: prev.translateX + 50}))
                    break
                case 'ArrowRight':
                    setTransform(prev => ({...prev, translateX: prev.translateX - 50}))
                    break
                case 'ArrowUp':
                    setTransform(prev => ({...prev, translateY: prev.translateY + 50}))
                    break
                case 'ArrowDown':
                    setTransform(prev => ({...prev, translateY: prev.translateY - 50}))
                    break
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose, zoom, rotate, resetTransform, contextMenu.visible, closeContextMenu])
    
    // 鼠标滚轮缩放
    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault()
            const delta = e.deltaY > 0 ? -0.15 : 0.15
            zoom(delta)
        }
        
        container.addEventListener('wheel', handleWheel, {passive: false})
        return () => container.removeEventListener('wheel', handleWheel)
    }, [zoom])
    
    // 鼠标拖拽
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (transform.scale > 1) {
            isDragging.current = true
            lastPos.current = {x: e.clientX, y: e.clientY}
            e.preventDefault()
        }
    }, [transform.scale])
    
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (isDragging.current) {
            const dx = e.clientX - lastPos.current.x
            const dy = e.clientY - lastPos.current.y
            lastPos.current = {x: e.clientX, y: e.clientY}
            setTransform(prev => ({
                ...prev,
                translateX: prev.translateX + dx,
                translateY: prev.translateY + dy,
            }))
        }
    }, [])
    
    const handleMouseUp = useCallback(() => {
        isDragging.current = false
    }, [])
    
    // 双击重置
    const handleDoubleClick = useCallback(() => {
        resetTransform()
    }, [resetTransform])
    
    // 点击背景关闭（仅当没有拖拽时）
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose()
        }
    }, [onClose])

    // 右键菜单
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        setContextMenu({visible: true, x: e.clientX, y: e.clientY})
    }, [])

    // 复制图片到剪贴板（通过 Electron 主进程写入真正的图片）
    const copyImageToClipboard = useCallback(async () => {
        closeContextMenu()
        try {
            const response = await fetch(src)
            const blob = await response.blob()
            const arrayBuffer = await blob.arrayBuffer()
            const buffer = Array.from(new Uint8Array(arrayBuffer))
            const result = await window.electronAPI?.clipboardWriteImage({buffer})
            if (result?.success) {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
            } else {
                // 回退：复制图片 URL
                await navigator.clipboard.writeText(src)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
            }
        } catch {
            // 回退：复制图片 URL
            try {
                await navigator.clipboard.writeText(src)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
            } catch {
                // 完全失败，静默忽略
            }
        }
    }, [src, closeContextMenu])
    
    // 禁止背景滚动
    useEffect(() => {
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = ''
        }
    }, [])

    const transformStyle = {
        position: 'absolute' as const,
        left: '50%',
        top: '50%',
        transform: `translate(-50%, -50%) translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
        transition: isDragging.current ? 'none' : 'transform 0.15s ease-out',
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 backdrop-blur-sm"
            onClick={(e) => { handleBackdropClick(e); closeContextMenu() }}
            onContextMenu={handleContextMenu}
        >
            {/* 顶部工具栏 */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm z-10">
                <button
                    onClick={() => zoom(-0.25)}
                    className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors active:scale-95"
                    title="缩小 (-)"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                    </svg>
                </button>
                <span className="text-white/80 text-sm w-16 text-center font-mono">{Math.round(transform.scale * 100)}%</span>
                <button
                    onClick={() => zoom(0.25)}
                    className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors active:scale-95"
                    title="放大 (+)"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                </button>
                <div className="w-px h-6 bg-white/20 mx-1" />
                <button
                    onClick={() => rotate(-90)}
                    className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors active:scale-95"
                    title="逆时针旋转 (R)"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                </button>
                <button
                    onClick={() => rotate(90)}
                    className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors active:scale-95"
                    title="顺时针旋转 (r)"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" transform="scale(-1, 1) translate(-24, 0)" />
                    </svg>
                </button>
                <div className="w-px h-6 bg-white/20 mx-1" />
                <button
                    onClick={resetTransform}
                    className="px-3 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-sm transition-colors active:scale-95 font-medium"
                    title="重置 (0)"
                >
                    重置
                </button>
            </div>

            {/* 关闭按钮 */}
            <button
                onClick={onClose}
                className="absolute top-4 right-4 w-12 h-12 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-white text-3xl font-light transition-colors z-10 active:scale-95"
                title="关闭 (ESC)"
            >
                ×
            </button>

            {/* 图片容器 - 使用 absolute 定位让图片居中 */}
            <div
                ref={containerRef}
                className="absolute inset-0 flex items-center justify-center"
                style={{cursor: transform.scale > 1 ? (isDragging.current ? 'grabbing' : 'grab') : 'default'}}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onDoubleClick={handleDoubleClick}
            >
                <img
                    src={src}
                    alt={alt}
                    className="max-w-[95vw] max-h-[90vh] object-contain select-none rounded-lg"
                    style={transformStyle}
                    draggable={false}
                />
            </div>

            {/* 底部提示 */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-5 py-2 rounded-full bg-black/50 text-white/60 text-xs">
                <span>滚轮：缩放</span>
                <span className="text-white/30">|</span>
                <span>拖拽：移动</span>
                <span className="text-white/30">|</span>
                <span>双击：重置</span>
                <span className="text-white/30">|</span>
                <span>{alt}</span>
            </div>
            
            {/* 缩放指示器 - 右下角 */}
            {transform.scale !== 1 && (
                <div className="absolute bottom-4 right-4 px-3 py-1 rounded-full bg-black/50 text-white/80 text-xs font-mono">
                    {Math.round(transform.scale * 100)}%
                </div>
            )}

            {/* 右键菜单 */}
            {contextMenu.visible && (
                <>
                    {/* 透明遮罩用于关闭菜单 */}
                    <div className="fixed inset-0 z-[10000]" onClick={closeContextMenu} />
                    <div
                        className="fixed z-[10001] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl py-1 min-w-[160px] overflow-hidden"
                        style={{left: contextMenu.x, top: contextMenu.y}}
                    >
                        <button
                            onClick={copyImageToClipboard}
                            className="w-full px-4 py-2.5 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--brand-primary)]/10 flex items-center gap-2.5 transition-colors"
                        >
                            <svg className="w-4 h-4 text-[var(--brand-primary)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                            </svg>
                            复制到剪贴板
                        </button>
                        <button
                            onClick={() => { navigator.clipboard.writeText(src); closeContextMenu(); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                            className="w-full px-4 py-2.5 text-sm text-left text-[var(--text-muted)] hover:bg-[var(--surface-muted)] flex items-center gap-2.5 transition-colors"
                        >
                            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                            </svg>
                            复制图片地址
                        </button>
                    </div>
                </>
            )}

            {/* 复制成功提示 */}
            {copied && (
                <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10002] px-6 py-3 rounded-xl bg-black/80 text-white text-sm font-medium backdrop-blur-sm animate-[fadeIn_0.15s_ease-out]">
                    ✓ 已复制到剪贴板
                </div>
            )}
        </div>,
        document.body
    )
})

export default ImagePreviewModal