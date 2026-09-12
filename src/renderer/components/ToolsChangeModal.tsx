import {useCallback, useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {fade, scaleFade} from '../lib/motionPresets'
import {useAgentStore} from '../stores/agentStore'

/**
 * ToolsChangeModal — 工具集变动确认弹窗
 *
 * 本轮将注入 LLM 的 tools 列表与上一轮不同（如切换 Agent 模式新增/移除工具）时显示。
 * tools 数组位于编码请求中 messages 之前，中途变化会使整个前缀失配，
 * 已积累的 prompt 缓存全部作废，本轮将重新计费全部输入 token。
 *
 * 特性：
 * - 弹窗强制用户选择「继续 / 取消」
 * - 复选框「今天不再提示」：勾选后今日内不再拦截（decision = snooze_today）
 * - 键盘快捷键（Enter 继续，Esc 取消）
 */
export default function ToolsChangeModal() {
    const pending = useAgentStore((s) => s.pendingToolsChangeConfirm)
    const respondToolsChange = useAgentStore((s) => s.respondToolsChange)

    const shouldShow = !!pending?.requestId
    const added = pending?.added ?? []
    const removed = pending?.removed ?? []

    const [snoozeToday, setSnoozeToday] = useState(false)
    const continueButtonRef = useRef<HTMLButtonElement>(null)

    // 每次弹窗新开时重置复选框
    useEffect(() => {
        if (shouldShow) {
            setSnoozeToday(false)
            continueButtonRef.current?.focus()
        }
    }, [shouldShow, pending?.requestId])

    const handleContinue = useCallback(() => {
        void respondToolsChange(snoozeToday ? 'snooze_today' : 'continue')
    }, [respondToolsChange, snoozeToday])

    const handleCancel = useCallback(() => {
        void respondToolsChange('cancel')
    }, [respondToolsChange])

    useEffect(() => {
        if (!shouldShow) return
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                handleContinue()
            } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancel()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [shouldShow, handleContinue, handleCancel])

    if (!shouldShow) return null

    return (
        <AnimatePresence>
            <motion.div
                {...fade}
                className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[var(--z-overlay)] flex items-center justify-center p-4"
                onClick={(e) => e.stopPropagation()}
            >
                <motion.div
                    {...scaleFade}
                    transition={{duration: 0.15, ease: 'easeOut'}}
                    className="bg-[var(--surface)] rounded-xl shadow-elevated overflow-hidden flex flex-col"
                    style={{width: 520, maxHeight: '80vh'}}
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="tools-change-title"
                >
                    <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)]">
                        <div className="flex items-center gap-3">
                            <div
                                className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                                <svg className="w-5 h-5 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="2">
                                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 id="tools-change-title"
                                    className="text-sm font-semibold text-[var(--text-primary)]">
                                    工具集变动 — 缓存将重建
                                </h2>
                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                    与本轮之前发送给模型的工具集不同
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-5 space-y-4 overflow-y-auto flex-1">
                        <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                            本轮将注入 LLM 的 tools 列表与上一轮不同。由于 tools 数组位于请求编码中
                            messages 之前，前缀将从 tools 段失配，<span
                            className="font-medium">已积累的 prompt 缓存将全部作废</span>，
                            本轮需要重新计费全部输入 token（约等于上下文总长度）。
                        </p>

                        {added.length > 0 && (
                            <div className="bg-[var(--surface-muted)] rounded-lg p-3 space-y-1.5">
                                <div className="text-xs font-medium text-[var(--text-muted)]">新增工具</div>
                                {added.map((name) => (
                                    <div key={name} className="flex items-center gap-2 text-sm">
                                        <span className="text-green-500 font-mono">+</span>
                                        <code className="text-[var(--text-primary)] font-mono text-xs break-all">{name}</code>
                                    </div>
                                ))}
                            </div>
                        )}

                        {removed.length > 0 && (
                            <div className="bg-[var(--surface-muted)] rounded-lg p-3 space-y-1.5">
                                <div className="text-xs font-medium text-[var(--text-muted)]">移除工具</div>
                                {removed.map((name) => (
                                    <div key={name} className="flex items-center gap-2 text-sm">
                                        <span className="text-red-500 font-mono">-</span>
                                        <code className="text-[var(--text-primary)] font-mono text-xs break-all">{name}</code>
                                    </div>
                                ))}
                            </div>
                        )}

                        <label className="flex items-center gap-2 text-sm text-[var(--text-muted)] cursor-pointer select-none">
                            <input
                                type="checkbox"
                                className="w-3.5 h-3.5 rounded accent-[var(--brand-primary)]"
                                checked={snoozeToday}
                                onChange={(e) => setSnoozeToday(e.target.checked)}
                            />
                            今天不再提示
                        </label>
                    </div>

                    <div className="px-5 py-3 border-t border-[var(--border)] bg-[var(--surface-elevated)] shrink-0">
                        <div className="flex items-center justify-center gap-2">
                            <button
                                onClick={handleCancel}
                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  bg-[var(--surface-muted)] text-[var(--text-muted)]
                  hover:bg-[var(--surface-hover)] border border-[var(--border)]"
                                data-name="tools-change-modal-cancel-button">
                                取消
                            </button>
                            <button
                                ref={continueButtonRef}
                                onClick={handleContinue}
                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  bg-[var(--brand-primary)] text-white
                  hover:bg-[var(--brand-primary)]/80"
                                data-name="tools-change-modal-continue-button">
                                继续
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}
