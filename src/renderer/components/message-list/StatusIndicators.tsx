/**
 * 状态指示器组件
 * 包含思考中和流式暂停指示器
 */

import {memo, useCallback, useEffect, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import {useAgentStore} from '../../stores/agentStore'

// ── 常量 ────────────────────────────────────────────────────────────────────
const PHASE_LABELS: Record<string, string> = {
    starting: '启动中...',
    streaming: '思考中',
    executing_tools: '执行工具中',
    responding: '响应中...',
    waiting_for_response: '等待响应中...',
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────
function getPhaseLabel(phase: string | undefined): string {
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
    const convData = useAgentStore((s) => conversationId ? s.convAgentStates[conversationId] : undefined)
    return {
        agentState: conversationId ? convData?.agentState : useAgentStore((s) => s.agentState),
        isThinkingAfterTools: conversationId ? (convData?.isThinkingAfterTools ?? false) : useAgentStore((s) => s.isThinkingAfterTools),
        runningToolCount: conversationId ? (convData?.runningToolCount ?? 0) : useAgentStore((s) => s.runningToolCount),
        streamingMessageId: conversationId ? (convData?.streamingMessageId ?? null) : useAgentStore((s) => s.streamingMessageId),
        errorMessage: conversationId ? (convData?.errorMessage ?? null) : useAgentStore((s) => s.errorMessage),
        executingToolsMessage: conversationId ? (convData as any)?.executingToolsMessage : useAgentStore((s) => (s as any).executingToolsMessage),
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
 * 带倒计时的错误提示组件（模块级定义，避免每次渲染重建）
 */
const ErrorIndicator = memo(function ErrorIndicator({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    const AUTO_DISMISS_SECONDS = 15
    const [remaining, setRemaining] = useState(AUTO_DISMISS_SECONDS)
    const onDismissRef = useRef(onDismiss)
    onDismissRef.current = onDismiss

    useEffect(() => {
        const timer = setInterval(() => {
            setRemaining(prev => {
                if (prev <= 1) {
                    clearInterval(timer)
                    onDismissRef.current()
                    return 0
                }
                return prev - 1
            })
        }, 1000)
        return () => clearInterval(timer)
    }, [])

    return (
        <motion.div
            initial={{opacity: 0, y: 10}}
            animate={{opacity: 1, y: 0}}
            className="flex items-start gap-2 text-sm text-[var(--error)] max-w-full pointer-events-auto"
            role="alert"
        >
            <svg className="w-4 h-4 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="13"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span className="whitespace-pre-wrap break-words flex-1 min-w-0">{message}</span>
            <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{remaining}s</span>
                <button
                    onClick={onDismiss}
                    className="p-0.5 rounded hover:bg-[var(--error)]/20 transition-colors"
                    aria-label="关闭错误提示"
                >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        </motion.div>
    )
})

/**
 * 思考中指示器
 */
export const ThinkingIndicator = memo(function ThinkingIndicator({conversationId}: { conversationId?: string } = {}) {
    const { agentState, isThinkingAfterTools, runningToolCount, streamingMessageId, errorMessage, executingToolsMessage } = useAgentData(conversationId)
    const status = agentState?.status ?? 'idle'
    const phase = agentState?.phase ?? 'idle'
    const setErrorMsg = useCallback(() => useAgentStore.setState({errorMessage: null}), [])

    // 优先级：工具执行提示 > 错误 > thinking 指示器 > 流式暂停
    if (executingToolsMessage) {
        return <StatusLine>{executingToolsMessage}</StatusLine>
    }

    if (errorMessage) {
        return <ErrorIndicator message={errorMessage} onDismiss={setErrorMsg}/>
    }

    if (shouldShowIndicator(phase, status, isThinkingAfterTools, runningToolCount)) {
        // isThinkingAfterTools 时优先按 phase 显示（responding → "响应中...", waiting_for_response → "等待响应中..."）
        const label = getPhaseLabel(phase) || (isThinkingAfterTools ? '等待响应中...' : '')
        return <StatusLine>{label}</StatusLine>
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
