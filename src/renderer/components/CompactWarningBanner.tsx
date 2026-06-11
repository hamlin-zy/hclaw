import {useEffect, useState} from 'react'
import {motion, AnimatePresence} from 'framer-motion'

interface CompactWarningBannerProps {
    /** 压缩前 token 数 */
    beforeTokens: number
    /** 压缩后 token 数 */
    afterTokens: number
    /** 节省的 token 数 */
    savedTokens: number
    /** 压缩的消息数 */
    compactedMessages: number
    /** 自动隐藏时间（毫秒），默认 5000 */
    autoHideDuration?: number
    /** 隐藏回调 */
    onHide?: () => void
}

/**
 * 压缩结果横幅
 * 在压缩完成后显示短暂的通知
 */
export default function CompactWarningBanner({
    beforeTokens,
    afterTokens,
    savedTokens,
    compactedMessages,
    autoHideDuration = 5000,
    onHide,
}: CompactWarningBannerProps) {
    const [visible, setVisible] = useState(true)

    useEffect(() => {
        const timer = setTimeout(() => {
            setVisible(false)
            onHide?.()
        }, autoHideDuration)
        return () => clearTimeout(timer)
    }, [autoHideDuration, onHide])

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    initial={{opacity: 0, y: -20}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -20}}
                    className="mx-4 my-2 px-4 py-2 bg-[var(--brand-muted)] border border-[var(--brand-primary)] rounded-lg"
                >
                    <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                            <span className="text-[var(--brand-primary)]">✓</span>
                            <span className="text-[var(--text-secondary)]">
                                已压缩 {compactedMessages} 条消息
                            </span>
                        </div>
                        <div className="flex items-center gap-3 text-[var(--text-muted)]">
                            <span>{beforeTokens.toLocaleString()} → {afterTokens.toLocaleString()} tokens</span>
                            <span className="text-[var(--brand-primary)]">-{savedTokens.toLocaleString()}</span>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
