import {memo, useEffect, useRef, useState} from 'react'
import {useAgentStore} from '../stores/agentStore'

interface LoopWarningBannerProps {
    conversationId: string
}

/**
 * LLM 循环检测警告条（notify 档）。
 * 读取 convAgentStates[conversationId].loopWarning，挂在 InputArea 上方。
 * - 点击条体展开明细（各轮工具调用 + 设置引导文案）
 * - "关闭"仅本条隐藏（升级轮次会重新显示）
 * - "这是误判"经 IPC 静默该指纹并清除警告条
 */
const LoopWarningBanner = memo(function LoopWarningBanner({conversationId}: LoopWarningBannerProps) {
    const warning = useAgentStore(s => s.convAgentStates[conversationId]?.loopWarning)
    const clear = useAgentStore(s => s.clearLoopWarning)
    const [expanded, setExpanded] = useState(false)
    const [dismissedFp, setDismissedFp] = useState<string | null>(null)
    // 每个指纹最多重新显示一次：controller 对同一模式只升级一次，升级事件到达时
    // 解除该指纹的关闭屏蔽并记录已重显，之后再次"关闭"即保持隐藏。
    const reShownRef = useRef<Set<string>>(new Set())

    // 升级轮与原警告指纹相同：用户已关闭过本指纹时，升级事件须重新显示一次（仅此一次）。
    // 用函数式更新读取最新 dismissedFp，deps 不含 dismissedFp，避免每次关闭都空跑本 effect。
    useEffect(() => {
        const fp = warning?.fingerprint
        if (warning?.escalated && fp && !reShownRef.current.has(fp)) {
            reShownRef.current.add(fp)
            setDismissedFp(prev => (prev === fp ? null : prev))
        }
    }, [warning?.escalated, warning?.fingerprint])

    if (!warning || dismissedFp === warning.fingerprint) return null

    const silence = () => {
        void window.electronAPI?.agentLoopSilence?.(conversationId, warning.fingerprint)
            .then(r => {
                if (!r?.success) console.warn(`[LoopWarningBanner] loop silence failed for ${conversationId} fp=${warning.fingerprint}`, r)
            })
            .catch(err => {
                console.warn(`[LoopWarningBanner] loop silence IPC error for ${conversationId} fp=${warning.fingerprint}`, err)
            })
        clear(conversationId)
    }

    return (
        <div
            data-name="loop-warning-banner"
            className="mx-[20px] mb-1 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm cursor-pointer"
            onClick={() => setExpanded(e => !e)}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                    ⚠ {warning.escalated
                        ? `循环已持续 ${warning.repeatCount} 轮`
                        : `疑似循环：${warning.detail[0]?.toolName ?? ''} 等相同调用 × ${warning.repeatCount}`}
                </span>
                <span className="flex gap-2 shrink-0">
                    <button
                        className="text-xs underline opacity-70 hover:opacity-100"
                        onClick={e => {e.stopPropagation(); setDismissedFp(warning.fingerprint)}}
                    >关闭</button>
                    <button
                        className="text-xs underline opacity-70 hover:opacity-100"
                        onClick={e => {e.stopPropagation(); silence()}}
                    >这是误判</button>
                </span>
            </div>
            {expanded && (
                <div className="mt-2 space-y-1 text-xs opacity-80">
                    {warning.detail.map((d, i) => (
                        <div key={i}>第 {d.turnNo} 轮 · {d.toolName} · {d.argsPreview}</div>
                    ))}
                    <div className="mt-1">
                        检测到 Agent 可能陷入重复循环。为避免打扰，任务已继续。如果这是误判，抱歉打扰了您——您可以在 系统设置 → LLM循环检测 中调整档位或关闭此功能。
                    </div>
                </div>
            )}
        </div>
    )
})

export default LoopWarningBanner
