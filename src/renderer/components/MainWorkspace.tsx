import {useEffect, useMemo} from 'react'
import {useConversationStore} from '../stores/conversationStore'
import ConversationPage from './ConversationPage'

/** 空状态图标：使用应用 Logo */
function EmptyChatIcon() {
    return (
        <img
            src="./icon.png"
            alt="HClaw"
            className="w-14 h-14 mx-auto mb-3 opacity-40 select-none"
            draggable={false}
        />
    )
}

/** 空状态卡片 */
function EmptyStateCard({message}: { message: string }) {
    return (
        <div
            className="absolute inset-0 bg-[var(--surface)] rounded-xl shadow-sm border border-[var(--border)] overflow-hidden flex items-center justify-center">
            <div className="text-center text-[var(--text-muted)]">
                <EmptyChatIcon/>
                <p className="text-sm">{message}</p>
            </div>
        </div>
    )
}

// ── 主组件 ─────────────────────────────────────────────────

export default function MainWorkspace() {
    const activeConversationId = useConversationStore((s) => s.activeConversationId)

    // ★ 每 60 秒清理超过 10 分钟不活跃的已渲染会话，释放内存
    useEffect(() => {
        const interval = setInterval(() => {
            useConversationStore.getState().cleanupInactiveConversations()
        }, 60_000)
        return () => clearInterval(interval)
    }, [])

    // ★ 稳定化 conversationIds：仅在 ID 集合变化时重渲染
    const conversationIds = useConversationStore(
        (s) => {
            const ws = s.currentWorkspacePath ? s.workspaces[s.currentWorkspacePath] : undefined
            return ws?.conversations.map(c => c.id) ?? []
        },
        (a, b) => a.length === b.length && a.every((id, i) => id === b[i])
    )

    // ★ 只挂载已渲染过的会话（LRU 控制），避免为全部会话创建组件实例和 Zustand 订阅
    const renderedConversationIds = useConversationStore((s) => s.renderedConversationIds)
    const renderableIds = useMemo(() => {
        const set = new Set(renderedConversationIds)
        if (activeConversationId) set.add(activeConversationId)
        return Array.from(set)
    }, [renderedConversationIds, activeConversationId])

    return (
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">
            {/* 会话页面 / 空状态 */}
            <div className="flex-1 relative min-h-0">
                {!activeConversationId ? (
                    <EmptyStateCard message="请在左侧选择一个工作目录和会话"/>
                ) : renderableIds.length === 0 ? (
                    <EmptyStateCard message="暂无会话，请在左侧创建一个新会话"/>
                ) : (
                    renderableIds.map(id => (
                        <div
                            key={id}
                            className="absolute inset-0 flex flex-col gap-1.5 overflow-hidden rounded-xl"
                            style={{display: id === activeConversationId ? 'flex' : 'none'}}
                        >
                            <ConversationPage conversationId={id}/>
                        </div>
                    ))
                )}
            </div>

            {/* 无活跃会话时显示禁用的输入区域 */}
            {!activeConversationId && (
                <div
                    className="shrink-0 bg-[var(--surface)] rounded-xl shadow-sm border border-[var(--border)] overflow-hidden">
                    <div className="h-28 flex items-center justify-center">
                        <div className="text-[var(--text-muted)] text-sm">选择一个会话后开始对话</div>
                    </div>
                </div>
            )}
        </div>
    )
}
