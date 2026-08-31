import {useCallback, useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useConversationStore} from '../../stores/conversationStore'
import {useAgentStore} from '../../stores/agentStore'
import {MCP_ACTION_LABELS, buildMcpDiagMessage, type McpDiagAction} from '../../utils/mcpErrorPrompt'
import type {MCPServer} from '@shared/types'

// ─── useMcpErrorDialog ───────────────────
// ACTION_LABELS / 消息构建逻辑见 utils/mcpErrorPrompt.ts

interface ErrorState {
    isOpen: boolean
    server: MCPServer | null
    errorMessage: string
    action: McpDiagAction | null
}

export function useMcpErrorDialog(opts?: {
    onNavigateHome?: () => void
}) {
    const onNavigateHome = opts?.onNavigateHome
    const [state, setState] = useState<ErrorState>({
        isOpen: false,
        server: null,
        errorMessage: '',
        action: null,
    })

    const showError = useCallback((params: {
        server: MCPServer
        errorMessage: string
        action: McpDiagAction
    }) => {
        setState({
            isOpen: true,
            server: params.server,
            errorMessage: params.errorMessage,
            action: params.action,
        })
    }, [])

    const close = useCallback(() => {
        setState(prev => ({...prev, isOpen: false}))
    }, [])

    const handleHelp = useCallback(async () => {
        const {server, errorMessage, action} = state
        if (!server) return

        // 1. 关闭弹框
        close()

        // 2. 组织消息文本（标准 mcpServers JSON 格式，见 utils/mcpErrorPrompt.ts）
        const msg = buildMcpDiagMessage(server, action || 'enable', errorMessage)

        try {
            // 3-6. 创建会话（指定诊断标题）→ 跳转 → 添加消息 → 启动 Agent
            const convId = await useConversationStore.getState().createConversation(`MCP 检查 - ${server.name}`)
            useConversationStore.getState().setActiveConversation(convId)
            useConversationStore.getState().addMessage({role: 'user', content: msg})
            await useAgentStore.getState().startAgent({conversationId: convId, message: msg})
            // 关闭所有 MCP 弹窗，回到主页面
            onNavigateHome?.()
        } catch (err) {
            console.error('[MCPErrorHelper] 帮我检查失败:', err)
        }
    }, [state, close, onNavigateHome])
    // 按 ESC 关闭
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && state.isOpen) close()
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [state.isOpen, close])

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') close()
    }, [close])

    // ─── 弹框组件 ──────────────────────

    const McpErrorOverlay = useCallback(() => (
        <AnimatePresence>
            {state.isOpen && state.server && (
                <>
                    {/* 遮罩 */}
                    <motion.div
                        initial={{opacity: 0}}
                        animate={{opacity: 1}}
                        exit={{opacity: 0}}
                        transition={{duration: 0.15}}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
                        onClick={close}
                    />

                    {/* 弹框 */}
                    <motion.div
                        initial={{scale: 0.95, opacity: 0}}
                        animate={{scale: 1, opacity: 1}}
                        exit={{scale: 0.95, opacity: 0}}
                        transition={{duration: 0.15, ease: 'easeOut'}}
                        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-[99999]"
                        onKeyDown={handleKeyDown}
                    >
                        <div
                            className="w-full max-w-sm bg-[var(--surface)] rounded-xl shadow-elevated overflow-hidden pointer-events-auto"
                            role="alertdialog"
                            aria-modal="true"
                            onClick={e => e.stopPropagation()}
                         data-name="mcperror-helper-div">
                            {/* Header */}
                            <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)]">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
                                        <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <circle cx="12" cy="12" r="10"/>
                                            <line x1="12" y1="8" x2="12" y2="12"/>
                                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                                        </svg>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                                            MCP 连接失败
                                        </h2>
                                    </div>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="px-5 py-4">
                                <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                                    「{state.server.name}」{MCP_ACTION_LABELS[state.action || 'enable']}时出错
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-elevated)] flex justify-end gap-3">
                                <button
                                    onClick={close}
                                    className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                 data-name="mcperror-helper-button">
                                    取消
                                </button>
                                <button
                                    onClick={handleHelp}
                                    className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/80 text-white transition-colors"
                                 data-name="mcperror-helper-help-button">
                                    帮我检查
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    ), [state, close, handleHelp, handleKeyDown])

    return {McpErrorOverlay, showError}
}
