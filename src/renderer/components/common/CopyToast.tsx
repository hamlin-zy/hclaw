import {memo} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'

/**
 * 全局顶部居中轻提示（portal 到 body，避免被祖先 backdrop-filter 的包含块困住）
 *
 * 用途：
 * - MessageList 选中自动复制 / 消息操作复制按钮 → 默认文案"已复制"
 * - 侧栏复制会话 ID → 默认文案"已复制"
 * - 模型方案切换 → 传入自定义 message
 *
 * 注意：bg-enabled 下 .app-surface-card 带 backdrop-filter，会成为后代 position:fixed
 * 元素的包含块；若把提示渲染在组件子树内，fixed top-4 left-1/2 会相对卡片定位而非视口。
 *
 * 实现细节：AnimatePresence 必须放在 createPortal 内部——framer-motion 12 的
 * AnimatePresence 会丢弃 portal 类型的子节点，放在外层将导致内容完全不渲染；
 * 放在 portal 内既保证挂到 body，又能让 exit 动画正常播放。
 */
const CopyToast = memo(function CopyToast({visible, message = '已复制'}: { visible: boolean; message?: string }) {
    return createPortal(
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
                    {message}
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    )
})

export default CopyToast
