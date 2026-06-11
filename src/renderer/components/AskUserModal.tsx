import {useCallback, useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useThemeStore} from '../stores/themeStore'
import {MarkdownRenderer} from './message-list'

/**
 * AskUserModal — ask_user 工具的交互式弹窗
 *
 * 当 Agent 调用 ask_user 工具时显示此弹窗（例如询问用户偏好、选择选项等）。
 * 始终显示输入框和选项（如果有），支持单选/多选模式。
 *
 * 特性：
 * - 无幕布、可拖拽，不阻塞主内容区交互（pointer-events 穿透策略）
 * - 强制用户必须做出选择/输入后才能继续，不允许关闭
 * - 选项和输入框互斥：选了选项清空输入，输入内容清空选项
 * - 单选项再次点击取消选中
 *
 * 注意：权限确认使用 PermissionConfirmModal 组件，不使用此组件
 */

export default function AskUserModal() {
    const pendingQuestion = useAgentStore((s) => s.pendingQuestion)
    const agentStatus = useAgentStore((s) => s.agentState.status)
    const answerQuestion = useAgentStore((s) => s.answerQuestion)
    const theme = useThemeStore((s) => s.theme)

    const [inputValue, setInputValue] = useState('')
    const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set())
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [position, setPosition] = useState({x: 0, y: 0})
    const [isDragging, setIsDragging] = useState(false)

    // 拖拽状态
    const dragRef = useRef({startX: 0, startY: 0, startPosX: 0, startPosY: 0})
    const isTouchDragRef = useRef(false) // 标记触摸拖拽，拦截后续合成的 mousedown
    const dialogRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)

    const hasOptions = pendingQuestion?.options && pendingQuestion.options.length > 0
    const multiSelect = pendingQuestion?.multiSelect ?? false

    // ── 弹窗显示时聚焦输入框 ──────────────────────────────────
    useEffect(() => {
        if (pendingQuestion && inputRef.current) inputRef.current.focus()
    }, [pendingQuestion])

    // ── 弹窗显示时重置交互状态 ────────────────────────────────
    useEffect(() => {
        if (pendingQuestion) {
            setInputValue('')
            setSelectedOptions(new Set())
            setIsSubmitting(false)
        }
    }, [pendingQuestion])

    // ── 弹窗显示时居中定位 ────────────────────────────────────
    useEffect(() => {
        if (pendingQuestion && dialogRef.current) {
            requestAnimationFrame(() => {
                if (!dialogRef.current) return
                const {offsetWidth: w, offsetHeight: h} = dialogRef.current
                setPosition({
                    x: Math.max((window.innerWidth - w) / 2, 8),
                    y: Math.max((window.innerHeight - h) / 2, 80),
                })
            })
        }
    }, [pendingQuestion])

    // ── 提交 ────────────────────────────────────────────────────
    const handleSubmit = useCallback(async () => {
        const answer = selectedOptions.size > 0
            ? multiSelect
                ? [...selectedOptions].join('、')
                : [...selectedOptions][0]
            : inputValue.trim()
        if (!answer || isSubmitting) return

        setIsSubmitting(true)
        try {
            await answerQuestion(answer)
        } catch {
            setIsSubmitting(false)
        }
    }, [isSubmitting, selectedOptions, inputValue, multiSelect, answerQuestion])

    // ── 键盘提交 ────────────────────────────────────────────────
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
        }
    }, [handleSubmit])

    // ── 拖拽：开始 ────────────────────────────────────────────
    const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        // 触摸拖拽结束后浏览器会合成 mousedown，此处拦截之
        if (isTouchDragRef.current) {
            isTouchDragRef.current = false;
            return
        }
        if ('touches' in e) isTouchDragRef.current = true

        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
        dragRef.current = {startX: clientX, startY: clientY, startPosX: position.x, startPosY: position.y}
        setIsDragging(true)
    }, [position])

    // ── 拖拽：移动 + 结束（挂载在 document 上） ────────────────
    useEffect(() => {
        if (!isDragging) return

        const handleMove = (e: MouseEvent | TouchEvent) => {
            const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
            const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
            setPosition({
                x: dragRef.current.startPosX + (clientX - dragRef.current.startX),
                y: Math.max(dragRef.current.startPosY + (clientY - dragRef.current.startY), 0),
            })
        }

        const handleEnd = () => {
            if (isTouchDragRef.current) setTimeout(() => {
                isTouchDragRef.current = false
            }, 0)
            setIsDragging(false)
        }

        document.addEventListener('mousemove', handleMove)
        document.addEventListener('mouseup', handleEnd)
        document.addEventListener('touchmove', handleMove, {passive: true})
        document.addEventListener('touchend', handleEnd)

        return () => {
            document.removeEventListener('mousemove', handleMove)
            document.removeEventListener('mouseup', handleEnd)
            document.removeEventListener('touchmove', handleMove)
            document.removeEventListener('touchend', handleEnd)
        }
    }, [isDragging])

    // ── 切换选项 ──────────────────────────────────────────────
    const toggleOption = useCallback((option: string) => {
        setSelectedOptions(prev => {
            if (multiSelect) {
                const next = new Set(prev)
                next.has(option) ? next.delete(option) : next.add(option)
                return next
            }
            return prev.has(option) ? new Set() : new Set([option])
        })
        setInputValue('')
    }, [multiSelect])

    // ── 输入框变化 ────────────────────────────────────────────
    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInputValue(e.target.value)
        if (e.target.value.trim()) setSelectedOptions(new Set())
    }, [])

    // ── 空状态 ──────────────────────────────────────────────────
    if (!pendingQuestion || agentStatus === 'idle') return null

    const answer = selectedOptions.size > 0 ? [...selectedOptions][0] : inputValue.trim()
    const canSubmit = answer.length > 0

    return (
        <AnimatePresence>
            {/* 容器：全屏透明，事件穿透，不遮幕布 */}
            <motion.div
                initial={{opacity: 0}}
                animate={{opacity: 1}}
                exit={{opacity: 0}}
                className="fixed z-[var(--z-overlay)] pointer-events-none"
                style={{left: 0, top: 0, width: '100vw', height: '100vh'}}
            >
                <motion.div
                    ref={dialogRef}
                    initial={{scale: 0.95, opacity: 0}}
                    animate={{scale: 1, opacity: 1}}
                    exit={{scale: 0.95, opacity: 0}}
                    transition={{duration: 0.15, ease: 'easeOut'}}
                    className={`absolute pointer-events-auto w-[calc(100vw-2rem)] max-w-md bg-[var(--surface)] rounded-xl overflow-hidden transition-shadow duration-100 ${
                        isDragging ? 'shadow-overlay scale-[1.02]' : 'shadow-elevated'
                    }`}
                    style={{left: position.x, top: position.y}}
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="ask-user-title"
                >
                    {/* Header — 拖拽手柄 */}
                    <div
                        onMouseDown={handleDragStart}
                        onTouchStart={handleDragStart}
                        className={`px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)] select-none ${
                            isDragging ? 'cursor-grabbing' : 'cursor-grab'
                        }`}
                    >
                        <div className="flex items-center gap-3">
                            <div
                                className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                                <svg className="w-5 h-5 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="2">
                                    <path
                                        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 id="ask-user-title" className="text-sm font-semibold text-[var(--text-primary)]">
                                    Agent 需要您的输入
                                </h2>
                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                    {hasOptions ? (multiSelect ? '可多选' : '单选') : '请输入您的回答'}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Content — 可滚动区域 */}
                    <div className="p-5 space-y-4 max-h-[50vh] overflow-y-auto">
                        <div className="text-sm text-[var(--text-primary)] leading-relaxed">
                            <MarkdownRenderer isUser={false} theme={theme}>
                                {pendingQuestion.question}
                            </MarkdownRenderer>
                        </div>

                        {hasOptions && (
                            <div className="space-y-2">
                                {pendingQuestion.options!.map((option, index) => {
                                    const isSelected = selectedOptions.has(option)
                                    return (
                                        <button
                                            key={index}
                                            onClick={() => !isSubmitting && toggleOption(option)}
                                            disabled={isSubmitting}
                                            className={`w-full text-left px-4 py-3 rounded-lg border transition-all text-sm ${
                                                isSelected
                                                    ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                                                    : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-primary)] hover:border-[var(--brand-primary)]/50 disabled:cursor-not-allowed'
                                            }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div
                                                    className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                                                        isSelected
                                                            ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]'
                                                            : 'border-[var(--border-muted)]'
                                                    }`}
                                                >
                                                    {isSelected && (
                                                        multiSelect ? (
                                                            <svg className="w-3 h-3 text-white" viewBox="0 0 24 24"
                                                                 fill="none"
                                                                 stroke="currentColor" strokeWidth="3">
                                                                <polyline points="20 6 9 17 4 12"/>
                                                            </svg>
                                                        ) : (
                                                            <div className="w-2 h-2 rounded-full bg-white"/>
                                                        )
                                                    )}
                                                </div>
                                                <span>{option}</span>
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    {/* Input + Actions */}
                    <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-elevated)] space-y-3">
                        <div>
                            <textarea
                                ref={inputRef}
                                value={inputValue}
                                onChange={handleInputChange}
                                onKeyDown={handleKeyDown}
                                placeholder="或者输入您的回答...（按 Enter 发送，Shift+Enter 换行）"
                                rows={2}
                                disabled={isSubmitting}
                                className="w-full px-3 py-2 bg-[var(--surface-muted)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] rounded-lg border border-[var(--border)] focus:border-[var(--brand-primary)] focus:outline-none resize-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                        </div>

                        <div className="flex justify-end">
                            <button
                                onClick={handleSubmit}
                                disabled={!canSubmit || isSubmitting}
                                className={`px-6 py-2 text-sm font-medium rounded-lg transition-all ${
                                    canSubmit && !isSubmitting
                                        ? 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary)]/80'
                                        : 'bg-[var(--surface-muted)] text-[var(--text-muted)] cursor-not-allowed'
                                }`}
                            >
                                {isSubmitting ? (
                                    <span className="flex items-center gap-2">
                                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor"
                                                    strokeWidth="4"/>
                                            <path className="opacity-75" fill="currentColor"
                                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                                        </svg>
                                        提交中...
                                    </span>
                                ) : '确认发送'}
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}
