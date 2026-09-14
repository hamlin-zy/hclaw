import {memo, useState} from 'react'
import {useAgentStore} from '../stores/agentStore'
import {WarningIcon} from './icons'

interface TurnLimitNoticeProps {
    conversationId: string
}

/**
 * 轮数上限截断提示条（done reason=max_turns_reached）。
 * 读取 convAgentStates[conversationId].turnLimitNotice，挂在 InputArea 上方（与 LoopWarningBanner 同级）。
 * - 点击条体展开明细
 * - "关闭"清除该会话的提示条
 *
 * ★ 与 LoopWarningBanner 的关键区别：本提示在运行「结束后」才产生，必须留存于界面，
 *   仅在「下一 run 开始」（startAgent）或用户点「关闭」时清除，绝不在 done 收尾路径清除。
 */
const TurnLimitNotice = memo(function TurnLimitNotice({conversationId}: TurnLimitNoticeProps) {
    const notice = useAgentStore(s => s.convAgentStates[conversationId]?.turnLimitNotice)
    const clear = useAgentStore(s => s.clearTurnLimitNotice)
    const [expanded, setExpanded] = useState(false)

    if (!notice) return null

    return (
        <div
            data-name="turn-limit-notice"
            className="mx-[20px] mb-1 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm cursor-pointer"
            onClick={() => setExpanded(e => !e)}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 min-w-0">
                    <WarningIcon className="w-3.5 h-3.5 shrink-0"/>
                    <span className="truncate">已达本轮上限，任务可能未完成</span>
                </span>
                <span className="flex gap-2 shrink-0">
                    <button
                        className="text-xs underline opacity-70 hover:opacity-100"
                        onClick={e => {e.stopPropagation(); clear(conversationId)}}
                     data-name="turn-limit-notice-close-button">关闭</button>
                </span>
            </div>
            {expanded && (
                <div className="mt-2 space-y-1 text-xs opacity-80">
                    <div>
                        本次运行达到 {notice.maxTurns ?? '?'} 轮上限（实际 {notice.turns ?? '?'} 轮）被截断，
                        任务未完成。可继续发送消息让 Agent 接着做。
                    </div>
                </div>
            )}
        </div>
    )
})

export default TurnLimitNotice
