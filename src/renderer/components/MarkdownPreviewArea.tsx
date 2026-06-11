import {type ReactNode, useRef} from 'react'
import {AnimatePresence, motion} from 'framer-motion'

interface MarkdownPreviewAreaProps {
    isVisible: boolean
    content: ReactNode
    maxHeight: number | null
    onResizeStart: (e: React.MouseEvent) => void
}

/**
 * Markdown 实时预览区域 — 在输入框上方显示预览内容，支持拖拽调整高度
 */
export default function MarkdownPreviewArea({isVisible, content, maxHeight, onResizeStart}: MarkdownPreviewAreaProps) {
    const containerRef = useRef<HTMLDivElement>(null)

    return (
        <AnimatePresence mode="wait">
            {isVisible && (
                <motion.div
                    ref={containerRef}
                    initial={{opacity: 0, y: 10, scale: 0.98}}
                    animate={{opacity: 1, y: 0, scale: 1}}
                    exit={{opacity: 0, y: 5, scale: 0.98}}
                    transition={{duration: 0.15, ease: 'easeOut'}}
                    className="bg-[var(--surface-muted)]/50 border-b border-[var(--border-muted)] overflow-y-auto p-3 origin-bottom relative"
                    style={{maxHeight: maxHeight ? `${maxHeight}px` : '12rem'}}
                    data-preview-area
                >
                    {/* 预览区域顶部拖拽条 */}
                    <div
                        onMouseDown={onResizeStart}
                        className="absolute top-0 left-0 right-0 h-1.5 z-10 cursor-row-resize hover:bg-[var(--brand-muted)]/50 transition-colors -mt-1.5"
                        title="拖拽调整预览区域高度"
                    >
                        <div className="w-8 h-0.5 mx-auto bg-[var(--border)] rounded-full mt-0.5"/>
                    </div>
                    <div className="text-[10px] font-bold text-[var(--brand-primary)] uppercase tracking-wider mb-2 flex items-center gap-1">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                            <polyline points="10 9 9 9 8 9"/>
                        </svg>
                        Markdown 预览
                    </div>
                    <div className="prose prose-sm max-w-none text-[var(--text-primary)] leading-relaxed markdown-preview">
                        {content}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
