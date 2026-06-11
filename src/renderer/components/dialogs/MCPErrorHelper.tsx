import {useCallback, useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import type {MCPServer} from '@shared/types'
import {useConversationStore} from '../../stores/conversationStore'
import {useAgentStore} from '../../stores/agentStore'

// ─── 类型 ───────────────────────────────

type McpAction = 'enable' | 'reconnect' | 'test'

interface ErrorState {
    isOpen: boolean
    server: MCPServer | null
    errorMessage: string
    action: McpAction | null
}

const ACTION_LABELS: Record<McpAction, string> = {
    enable: '启用',
    reconnect: '重新连接',
    test: '测试连接',
}

// ─── Hook ────────────────────────────────

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
        action: McpAction
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

        // 2. 构建 MCP 配置 JSON（纯配置字段，不含 runtime 状态）
        const configObj: Record<string, unknown> = {
            name: server.name,
            transport: server.transport,
        }
        if (server.command) configObj.command = server.command
        if (server.args && server.args.length > 0) configObj.args = server.args
        if (server.env && Object.keys(server.env).length > 0) configObj.env = server.env
        if (server.url) configObj.url = server.url
        if (server.headers && Object.keys(server.headers).length > 0) configObj.headers = server.headers
        if (server.cwd) configObj.cwd = server.cwd
        if (server.timeout) configObj.timeout = server.timeout
        if (server.autoApprove && server.autoApprove.length > 0) configObj.autoApprove = server.autoApprove
        if (server.denyList && server.denyList.length > 0) configObj.denyList = server.denyList
        if (server.userDescription) configObj.userDescription = server.userDescription

        const configJson = JSON.stringify(configObj, null, 2)

        // 3. 组织消息文本
        const actionLabel = ACTION_LABELS[action || 'enable']
        const msg = `MCP连接失败了，帮我检查一下：\n\n\`\`\`json\n${configJson}\n\`\`\`\n\n操作: ${actionLabel}\n报错信息：${errorMessage}`

        try {
            // 4-7. 创建会话 → 跳转 → 添加消息 → 启动 Agent
            const convId = await useConversationStore.getState().createConversation()
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
                        >
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
                                    「{state.server.name}」{ACTION_LABELS[state.action || 'enable']}时出错
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-elevated)] flex justify-end gap-3">
                                <button
                                    onClick={close}
                                    className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={handleHelp}
                                    className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/80 text-white transition-colors"
                                >
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
