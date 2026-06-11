import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'

interface PendingQuestion {
    question: string
    options?: string[]
    requestId?: string
}

interface PendingQuestionCardProps {
    isPaused: boolean
    pendingQuestion: PendingQuestion | null
    onSelectOption: (option: string) => void
}

/**
 * Agent ask_user 提问卡片 — 当 Agent 需要用户输入时显示
 */
export default function PendingQuestionCard({isPaused, pendingQuestion, onSelectOption}: PendingQuestionCardProps) {
    const addMessage = useConversationStore((s) => s.addMessage)

    if (!pendingQuestion || pendingQuestion.requestId) return null

    const handleOptionClick = (option: string) => {
        // 清除待确认状态（按会话清除）
        const convId = useConversationStore.getState().activeConversationId
        if (convId) {
            useAgentStore.getState().updateConvData(convId, {
                pendingQuestion: null,
                agentState: {status: 'idle', mode: 'auto', phase: 'idle'}
            })
        }
        // 添加用户消息
        addMessage({role: 'user', content: option})
        // 重新启动 Agent
        onSelectOption(option)
    }

    return (
        <AnimatePresence>
            {isPaused && (
                <motion.div
                    initial={{opacity: 0, y: -10}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -10}}
                    className="bg-[var(--info)]/5 border border-[var(--info)]/20 rounded-lg p-3 mb-2"
                >
                    <div className="flex items-center gap-2 mb-2 text-[var(--info)]">
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2.5">
                            <path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span className="text-xs font-bold uppercase tracking-wider">Agent 需要您的输入</span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] text-center mb-3 max-w-[90%] mx-auto whitespace-pre-wrap">
                        {pendingQuestion.question}
                    </p>
                    {pendingQuestion.options && pendingQuestion.options.length > 0 ? (
                        <div className="flex flex-col gap-1.5 max-w-[90%] w-full max-h-32 overflow-y-auto mx-auto">
                            {pendingQuestion.options.map((option, index) => (
                                <button
                                    key={index}
                                    onClick={() => handleOptionClick(option)}
                                    className="px-3 py-1.5 text-xs text-left bg-[var(--surface-muted)] hover:bg-[var(--brand-muted)] border border-[var(--border)] rounded-md transition-colors"
                                >
                                    {option}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className="text-xs text-[var(--text-muted)] text-center">请在下方输入框输入回答后发送</p>
                    )}
                </motion.div>
            )}
        </AnimatePresence>
    )
}
