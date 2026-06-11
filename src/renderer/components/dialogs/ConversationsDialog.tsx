import {useCallback, useEffect, useMemo, useState} from 'react'
import type {ConversationWithStats} from '@shared/types'
import {useConversationStore} from '../../stores/conversationStore'
import {confirm} from '../ConfirmDialog'

/** 工具栏按钮样式常量 */
const BTN_BORDERED = "px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"
const BTN_GHOST = "px-2 py-1.5 text-xs rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"

/**
 * 会话管理对话框
 * 展示所有会话的统计信息（消息数、block 数），支持批量删除
 */
export default function ConversationsDialog() {
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const deleteConversations = useConversationStore((s) => s.deleteConversations)

    const [conversations, setConversations] = useState<ConversationWithStats[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [deleting, setDeleting] = useState(false)

    // ── 加载数据 ────────────────────────────────────────────
    const loadData = useCallback(async () => {
        if (!currentWorkspacePath) {
            setConversations([])
            setLoading(false)
            return
        }
        setLoading(true)
        setError(null)
        try {
            const data = await window.electronAPI?.conversationListWithStats?.(currentWorkspacePath)
            if (data) {
                setConversations(data)
            } else {
                setConversations([])
            }
        } catch (err) {
            console.error('[ConversationsDialog] loadData failed:', err)
            setError('加载会话列表失败')
        } finally {
            setLoading(false)
        }
    }, [currentWorkspacePath])

    useEffect(() => {
        loadData()
    }, [loadData])

    // ── 选择控制 ────────────────────────────────────────────
    const toggleSelect = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
    }, [])

    // ── 按时间快捷选择 ─────────────────────────────────────
    const selectByTime = useCallback((days: number) => {
        const cutoff = Date.now() - days * 86400000
        setSelectedIds(new Set(
            conversations
                .filter((c) => c.updatedAt < cutoff)
                .map((c) => c.id)
        ))
    }, [conversations])

    const TIME_PRESETS = [
        {days: 1, label: '1天前'},
        {days: 3, label: '3天前'},
        {days: 7, label: '7天前'},
        {days: 14, label: '14天前'},
        {days: 30, label: '30天前'},
    ] as const

    // ── 删除操作 ────────────────────────────────────────────
    const selectedCount = selectedIds.size

    const handleDeleteSelected = useCallback(async () => {
        if (selectedCount === 0) return

        const confirmed = await confirm({
            title: '删除会话',
            message: `确定要删除选中的 ${selectedCount} 个会话吗？\n此操作不可撤销，关联的消息和记录将一并删除。`,
            confirmText: '删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                setDeleting(true)
                try {
                    const ids = Array.from(selectedIds)
                    await deleteConversations(ids)
                    // 刷新列表
                    await loadData()
                    setSelectedIds(new Set())
                } catch (err) {
                    console.error('[ConversationsDialog] delete failed:', err)
                } finally {
                    setDeleting(false)
                }
            },
        })
    }, [selectedCount, selectedIds, deleteConversations, loadData])

    // ── 格式化时间 ──────────────────────────────────────────
    const formatTime = useCallback((ts: number) => {
        const now = Date.now()
        const diff = now - ts
        if (diff < 60000) return '刚刚'
        if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
        if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`
        return new Date(ts).toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        })
    }, [])

    // ── 总计信息 ────────────────────────────────────────────
    const totals = useMemo(() => {
        let messages = 0
        let blocks = 0
        for (const c of conversations) {
            messages += c.messageCount
            blocks += c.blockCount
        }
        return {conversations: conversations.length, messages, blocks}
    }, [conversations])

    // ── 渲染：加载状态 ──────────────────────────────────────
    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <div
                        className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    <span className="text-sm text-[var(--text-muted)]">加载中...</span>
                </div>
            </div>
        )
    }

    // ── 渲染：错误状态 ──────────────────────────────────────
    if (error) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <svg className="w-10 h-10 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span className="text-sm text-red-400">{error}</span>
                    <button
                        onClick={loadData}
                        className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                    >
                        重试
                    </button>
                </div>
            </div>
        )
    }

    // ── 渲染：空状态 ────────────────────────────────────────
    if (conversations.length === 0) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                    <svg className="w-10 h-10 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span className="text-sm text-[var(--text-muted)]">暂无会话</span>
                </div>
            </div>
        )
    }

    // ── 渲染：正常列表 ──────────────────────────────────────
    return (
        <div className="flex flex-col h-full min-h-0">
            {/* 工具栏 */}
            <div className="flex items-center gap-3 gap-y-2 px-5 py-3 border-b border-[var(--border)] flex-wrap">
                {/* 全选 / 反选 */}
                <button
                    onClick={() => setSelectedIds(new Set(conversations.map((c) => c.id)))}
                    className={BTN_BORDERED}
                >
                    全选
                </button>
                <button
                    onClick={() => {
                        setSelectedIds((prev) => {
                            const currentIds = new Set(conversations.map((c) => c.id))
                            const inverted = new Set(
                                [...currentIds].filter((id) => !prev.has(id))
                            )
                            return inverted
                        })
                    }}
                    className={BTN_BORDERED}
                >
                    反选
                </button>

                {/* 分隔线 */}
                <div className="w-px h-4 bg-[var(--border-muted)] shrink-0" aria-hidden="true"/>

                {/* 按时间快捷选择 */}
                {TIME_PRESETS.map(({days, label}) => (
                    <button
                        key={days}
                        onClick={() => selectByTime(days)}
                        className={BTN_GHOST}
                    >
                        {label}
                    </button>
                ))}

                {/* 取消选中 */}
                <button
                    onClick={() => setSelectedIds(new Set())}
                    className={BTN_GHOST}
                >
                    取消选中
                </button>

                {/* ml-auto 替换 flex-1，换行时不占满整行 */}
                <div className="ml-auto flex items-center gap-3 shrink-0">
                    {selectedCount > 0 && (
                        <span className="text-xs text-[var(--text-muted)]">
                            已选 {selectedCount} 项
                        </span>
                    )}

                    <button
                        onClick={handleDeleteSelected}
                        disabled={selectedCount === 0 || deleting}
                        className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0 ${
                            selectedCount === 0
                                ? 'bg-[var(--surface-muted)] text-[var(--text-muted)] opacity-60 cursor-not-allowed'
                                : deleting
                                    ? 'bg-red-500/20 text-red-400 cursor-not-allowed'
                                    : 'bg-red-500/12 text-red-400 hover:bg-red-500/20'
                        }`}
                    >
                        {deleting ? (
                            <>
                                <div
                                    className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin"/>
                                删除中...
                            </>
                        ) : (
                            <>
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <path
                                        d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                </svg>
                                删除选中{selectedCount > 0 ? ` (${selectedCount})` : ''}
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* 表格头部 */}
            <div
                className="grid grid-cols-[32px_1fr_80px_80px_140px] gap-2 px-5 py-2 text-xs text-[var(--text-muted)] border-b border-[var(--border-muted)] bg-[var(--surface-muted)]">
                <div/>
                <div>标题</div>
                <div className="text-right">消息数</div>
                <div className="text-right">Block 数</div>
                <div className="text-right">最后更新</div>
            </div>

            {/* 表格行 */}
            <div className="flex-1 overflow-y-auto min-h-0">
                {conversations.map((conv) => (
                    <label
                        key={conv.id}
                        className={`grid grid-cols-[32px_1fr_80px_80px_140px] gap-2 px-5 py-2.5 text-sm border-b border-[var(--border-muted)] cursor-pointer transition-colors hover:bg-[var(--surface-muted)] ${
                            deleting ? 'pointer-events-none opacity-50' : ''
                        }`}
                    >
                        <div className="flex items-center">
                            <input
                                type="checkbox"
                                checked={selectedIds.has(conv.id)}
                                onChange={() => toggleSelect(conv.id)}
                                disabled={deleting}
                                className="w-3.5 h-3.5 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)] accent-[var(--brand-primary)]"
                            />
                        </div>
                        <div className="flex items-center truncate text-[var(--text-primary)]">
                            {conv.title || '(无标题)'}
                        </div>
                        <div className="flex items-center justify-end text-[var(--text-secondary)] tabular-nums">
                            {conv.messageCount}
                        </div>
                        <div className="flex items-center justify-end text-[var(--text-secondary)] tabular-nums">
                            {conv.blockCount}
                        </div>
                        <div className="flex items-center justify-end text-[var(--text-muted)] text-xs tabular-nums">
                            {formatTime(conv.updatedAt)}
                        </div>
                    </label>
                ))}
            </div>

            {/* 底部统计 */}
            <div className="px-5 py-2.5 border-t border-[var(--border)] text-xs text-[var(--text-muted)]">
                共 {totals.conversations} 个会话，{totals.messages} 条消息，{totals.blocks} 个记录块
            </div>
        </div>
    )
}
