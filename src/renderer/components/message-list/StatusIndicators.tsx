/**
 * 状态指示器组件
 * 包含思考中和流式暂停指示器
 */

import {memo, useEffect, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import {useAgentStore} from '../../stores/agentStore'

// ── 常量 ────────────────────────────────────────────────────────────────────
/** 阶段文案（导出供 MessageList 气泡内 statusNote 复用） */
export const PHASE_LABELS: Record<string, string> = {
    starting: '启动中...',
    streaming: '思考中',
    executing_tools: '执行工具中',
    responding: '响应中...',
    waiting_for_response: '等待响应中...',
}

/** 阶段 → 文案（导出供气泡 statusNote 复用） */
export function getPhaseLabel(phase: string | undefined): string {
    if (!phase || phase === 'idle') return ''
    return PHASE_LABELS[phase] ?? '思考中'
}

function shouldShowIndicator(phase: string | undefined, status: string, isThinkingAfterTools: boolean, runningToolCount: number): boolean {
    if (status === 'idle' || status === 'paused' || status === 'error') return false
    if (runningToolCount > 0) return false
    if (isThinkingAfterTools) return true
    return !!phase && phase !== 'idle'
}

/** 从 store（全局或 per-conversation）提取数据 */
function useAgentData(conversationId?: string) {
    const agentState = useAgentStore((s) =>
        conversationId ? s.convAgentStates[conversationId]?.agentState : s.agentState)
    const isThinkingAfterTools = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.isThinkingAfterTools ?? false) : s.isThinkingAfterTools)
    const runningToolCount = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.runningToolCount ?? 0) : s.runningToolCount)
    const streamingMessageId = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.streamingMessageId ?? null) : s.streamingMessageId)
    const executingToolsMessage = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.executingToolsMessage ?? null) : (s as any).executingToolsMessage)
    return {
        agentState,
        isThinkingAfterTools,
        runningToolCount,
        streamingMessageId,
        executingToolsMessage,
    }
}

// ── 复用 UI 组件 ────────────────────────────────────────────────────────────
const Spinner = () => (
    <svg className="w-4 h-4 animate-spin text-[var(--brand-primary)] flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
    </svg>
)

/** 带 spinner 的状态行 */
const StatusLine = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
    <motion.div
        initial={{opacity: 0, y: 10}}
        animate={{opacity: 1, y: 0}}
        className={`flex items-center gap-2 ml-5 text-sm text-[var(--text-secondary)] ${className}`}
        role="status"
        aria-live="polite"
    >
        <Spinner />
        <span className="animate-pulse">{children}</span>
    </motion.div>
)

/**
 * 思考中指示器
 */
export const ThinkingIndicator = memo(function ThinkingIndicator({conversationId}: { conversationId?: string } = {}) {
    const { agentState, isThinkingAfterTools, runningToolCount, streamingMessageId, executingToolsMessage } = useAgentData(conversationId)
    const status = agentState?.status ?? 'idle'
    const phase = agentState?.phase ?? 'idle'

    // 优先级：工具执行提示 > 流式暂停兜底
    // 重试 / 错误 / 阶段文案（思考中/响应中等）已搬入"最后一条助手消息气泡底部"
    // （statusNote），左下角不再展示，仅保留工具执行状态与流式暂停兜底
    if (executingToolsMessage) {
        if (typeof executingToolsMessage === 'string') {
            // 遗留字符串分支：重试相关已由气泡承载，仅工具执行状态留此展示
            if (executingToolsMessage.startsWith('重试')) return null
            return <StatusLine>{executingToolsMessage}</StatusLine>
        }
        // 对象分支均为重试相关（retry warning / 倒计时 / 已取消）→ 已由气泡承载
        return null
    }

    // 阶段文案已搬入气泡 statusNote；此判断保留仅为防止 phase 有值时
    // 误触发下方流式暂停指示器（如思考中不应显示"响应中..."）
    if (shouldShowIndicator(phase, status, isThinkingAfterTools, runningToolCount)) {
        return null
    }

    if (status === 'running' && streamingMessageId) {
        return <StreamingPauseIndicator/>
    }

    return null
})

/**
 * 流式响应暂停指示器
 * 当 LLM 流式输出中间卡住时显示，避免用户体验断裂
 */
const StreamingPauseIndicator = memo(function StreamingPauseIndicator() {
    const [elapsed, setElapsed] = useState(0)
    const startRef = useRef(Date.now())

    useEffect(() => {
        startRef.current = Date.now()
        const timer = setInterval(() => setElapsed(Date.now() - startRef.current), 500)
        return () => clearInterval(timer)
    }, [])

    if (elapsed < 2000) return null

    return (
        <motion.div
            initial={{opacity: 0, y: 10}}
            animate={{opacity: 1, y: 0}}
            className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
            role="status"
            aria-live="polite"
        >
            <svg className="w-4 h-4 text-[var(--info)] flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none"/>
                <text x="12" y="16" textAnchor="middle" fontSize="8" fill="currentColor">...</text>
            </svg>
            <span className="animate-pulse">响应中...</span>
        </motion.div>
    )
})
