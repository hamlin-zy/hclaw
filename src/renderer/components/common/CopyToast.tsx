import {memo} from 'react'
import {AnimatePresence, motion} from 'framer-motion'

/** 顶部居中的"已复制"轻提示（MessageList 选中自动复制 / 侧栏复制会话 ID 共用） */
const CopyToast = memo(function CopyToast({visible}: { visible: boolean }) {
    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    initial={{opacity: 0, y: -20}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -20}}
                    transition={{duration: 0.2, ease: 'easeOut'}}
                    className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated text-sm text-[var(--text-primary)]"
                    role="status"
                    aria-live="polite"
                >
                    <span className="text-[var(--brand-primary)] mr-1.5">✔</span>
                    已复制
                </motion.div>
            )}
        </AnimatePresence>
    )
})

export default CopyToast
