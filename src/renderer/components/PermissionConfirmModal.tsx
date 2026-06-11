import {useCallback, useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'

/**
 * PermissionConfirmModal — 权限确认弹窗
 *
 * 当 Agent 需要用户确认 plannedCommands 时显示此弹窗。
 * 采用模态对话框方式，强制用户必须做出选择/输入后才能继续。
 *
 * 特性：
 * - 始终显示在屏幕中央，100% 可见
 * - 不依赖 agentState.status，独立管理显示状态
 * - 键盘快捷键支持（Enter 允许，Esc 拒绝）
 * - 禁止通过点击背景或按 Esc 关闭（强制确认）
 * - 支持拖拽改变弹窗大小
 */
// 预编译正则表达式，避免每次渲染重复编译
const COMMAND_PATTERN = /需要确认以下命令：\n\n([\s\S]*?)\n\n/

// 从 localStorage 读取保存的弹窗尺寸
function getSavedDialogSize(): { width: number; height: number } | null {
    try {
        const saved = localStorage.getItem('permission-confirm-modal-size')
        return saved ? JSON.parse(saved) : null
    } catch {
        return null
    }
}

// 保存弹窗尺寸到 localStorage
function saveDialogSize(width: number, height: number) {
    try {
        localStorage.setItem('permission-confirm-modal-size', JSON.stringify({width, height}))
    } catch {
        // ignore
    }
}

export default function PermissionConfirmModal() {
    const pendingPermissionConfirm = useAgentStore((s) => s.pendingPermissionConfirm)
    const respondQuestion = useAgentStore((s) => s.respondQuestion)
    const abortAgent = useAgentStore((s) => s.abortAgent)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)

    const question = pendingPermissionConfirm?.question || ''
    const shouldShow = !!pendingPermissionConfirm?.requestId

    const allowButtonRef = useRef<HTMLButtonElement>(null)

    // 拖拽状态
    const dialogRef = useRef<HTMLDivElement>(null)
    const [isDragging, setIsDragging] = useState(false)
    const [dragStart, setDragStart] = useState({x: 0, y: 0})
    const [size, setSize] = useState<{ width: number; height: number }>(() => {
        const saved = getSavedDialogSize()
        return saved || {width: 480, height: 400}
    })

    useEffect(() => {
        if (shouldShow && allowButtonRef.current) {
            // 移除不必要的延迟，立即聚焦
            allowButtonRef.current?.focus()
        }
    }, [shouldShow])

    // 拖拽开始
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(true)
        setDragStart({x: e.clientX, y: e.clientY})
    }, [])

    // 拖拽中
    useEffect(() => {
        if (!isDragging) return

        const handleMouseMove = (e: MouseEvent) => {
            const deltaX = e.clientX - dragStart.x
            const deltaY = e.clientY - dragStart.y
            setSize(prev => {
                const newWidth = Math.max(320, prev.width + deltaX)
                const newHeight = Math.max(200, prev.height + deltaY)
                return {width: newWidth, height: newHeight}
            })
            setDragStart({x: e.clientX, y: e.clientY})
        }

        const handleMouseUp = () => {
            setIsDragging(false)
            // 保存尺寸
            saveDialogSize(size.width, size.height)
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', handleMouseUp)
        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', handleMouseUp)
        }
    }, [isDragging, dragStart, size])

    // 使用 useCallback 稳定函数引用，避免事件监听器频繁重注册
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            respondQuestion('allow')
        }
    }, [respondQuestion])

    // 终止 Agent 执行
    const handleAbort = useCallback(async () => {
        if (activeConversationId) {
            await abortAgent(activeConversationId)
        }
    }, [abortAgent, activeConversationId])

    useEffect(() => {
        if (!shouldShow) return
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [shouldShow, handleKeyDown])

    if (!shouldShow) return null

    // 使用预编译的正则表达式解析命令
    const commandMatch = question.match(COMMAND_PATTERN)
    // 移除冗余的类型标注，TypeScript 可自动推断
    const commands = commandMatch
        ? commandMatch[1].split('\n').map(c => c.trim()).filter(c => c.startsWith('- ')).map(c => c.slice(2))
        : []

    return (
        <AnimatePresence>
            <motion.div
                initial={{opacity: 0}}
                animate={{opacity: 1}}
                exit={{opacity: 0}}
                className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[var(--z-overlay)] flex items-center justify-center p-4"
                onClick={(e) => e.stopPropagation()}
            >
                <motion.div
                    initial={{scale: 0.95, opacity: 0}}
                    animate={{scale: 1, opacity: 1}}
                    exit={{scale: 0.95, opacity: 0}}
                    transition={{duration: 0.15, ease: 'easeOut'}}
                    className="bg-[var(--surface)] rounded-xl shadow-elevated overflow-hidden flex flex-col"
                    style={{width: size.width, height: size.height}}
                    ref={dialogRef}
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="permission-confirm-title"
                >
                    {/* 拖拽改变大小的句柄 - 右下角 */}
                    <div
                        className="absolute bottom-1 right-1 w-4 h-4 cursor-se-resize flex items-center justify-center opacity-30 hover:opacity-60 transition-opacity"
                        style={{zIndex: 10}}
                        onMouseDown={handleResizeStart}
                        title="拖拽调整大小"
                    >
                        <svg className="w-3 h-3 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M22 22H20V20H22V22ZM22 18H20V16H22V18ZM18 22H16V20H18V22ZM22 14H20V12H22V14ZM18 18H16V16H18V18ZM14 22H12V20H14V22Z"/>
                        </svg>
                    </div>

                    <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)]">
                        <div className="flex items-center gap-3">
                            <div
                                className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                                <svg className="w-5 h-5 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="2">
                                    <path
                                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 id="permission-confirm-title"
                                    className="text-sm font-semibold text-[var(--text-primary)]">
                                    Agent 需要确认权限
                                </h2>
                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                    即将执行以下命令，请确认
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-5 space-y-4 overflow-y-auto flex-1">
                        {commands.length > 0 && (
                            <div className="bg-[var(--surface-muted)] rounded-lg p-3 space-y-1.5">
                                {commands.map((cmd: string, index: number) => (
                                    <div key={index} className="flex items-start gap-2 text-sm">
                                        <svg className="w-3.5 h-3.5 text-[var(--brand-primary)] shrink-0 mt-0.5"
                                             viewBox="0 0 24 24"
                                             fill="none" stroke="currentColor" strokeWidth="2">
                                            <polyline points="9 18 15 12 9 6"/>
                                        </svg>
                                        <code className="text-[var(--text-primary)] font-mono text-xs break-all whitespace-pre-wrap leading-relaxed">{cmd}</code>
                                    </div>
                                ))}
                            </div>
                        )}

                        {commands.length === 0 && (
                            <div className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words">
                                {question}
                            </div>
                        )}

                        <p className="text-xs text-[var(--text-muted)] text-center">
                            按 <kbd
                            className="px-1.5 py-0.5 bg-[var(--surface-muted)] rounded border border-[var(--border)] font-mono text-[10px]">Enter</kbd> 允许执行，
                            或点击下方按钮选择
                        </p>
                    </div>

                    <div className="px-5 py-3 border-t border-[var(--border)] bg-[var(--surface-elevated)] shrink-0">
                        <div className="flex items-center justify-center gap-2">
                            <button
                                onClick={handleAbort}
                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  bg-red-500 text-white
                  hover:bg-red-600"
                                title="终止任务"
                            >
                                终止
                            </button>
                            <button
                                ref={allowButtonRef}
                                onClick={() => respondQuestion('deny')}
                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  bg-[var(--surface-muted)] text-[var(--text-muted)]
                  hover:bg-[var(--surface-hover)] border border-[var(--border)]"
                            >
                                拒绝
                            </button>
                            <button
                                onClick={() => respondQuestion('always')}
                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]
                  hover:bg-[var(--brand-primary)]/20 border border-[var(--brand-primary)]/20"
                            >
                                始终允许
                            </button>
                            <button
                                onClick={() => respondQuestion('allow')}
                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  bg-[var(--brand-primary)] text-white
                  hover:bg-[var(--brand-primary)]/80"
                            >
                                允许
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}
