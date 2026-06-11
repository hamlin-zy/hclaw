import {AnimatePresence, motion} from 'framer-motion'

interface ModelAlertDialogProps {
    open: boolean
    onClose: () => void
    onConfigure: () => void
}

/**
 * 未配置模型时的警告弹窗
 */
export default function ModelAlertDialog({open, onClose, onConfigure}: ModelAlertDialogProps) {
    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{opacity: 0}}
                    animate={{opacity: 1}}
                    exit={{opacity: 0}}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{scale: 0.95, opacity: 0}}
                        animate={{scale: 1, opacity: 1}}
                        exit={{scale: 0.95, opacity: 0}}
                        className="bg-[var(--surface)] rounded-lg shadow-elevated p-5 max-w-sm mx-4 border border-[var(--border)]"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                                <svg className="w-5 h-5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-[var(--text-primary)]">请先选择模型</h3>
                                <p className="text-sm text-[var(--text-secondary)]">需要配置 LLM 服务商才能开始对话</p>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 mt-4">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] rounded-lg transition-colors border border-transparent hover:border-[var(--border)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={onConfigure}
                                className="px-4 py-2 text-sm text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-hover)] rounded-lg transition-colors shadow-sm"
                            >
                                去配置
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
