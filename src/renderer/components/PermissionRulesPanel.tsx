import {useEffect, useState} from 'react'
import {useAgentStore} from '../stores/agentStore'
import {useResetTimeout} from '../hooks/useResetTimeout'
import {INPUT_FOCUS} from '../lib/inputFocus'

export default function PermissionRulesPanel() {
    const {permissionRules, fetchPermissionRules, removePermissionRule, addPermissionRule} = useAgentStore()
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [editingRule, setEditingRule] = useState<{ tool: string; action: string } | null>(null)
    const [editTool, setEditTool] = useState('')
    const [isEditing, setIsEditing] = useState(false)
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    // 「刷新中」复位定时器（重置式：仅最后一次生效，卸载自动清理）
    const scheduleRefreshReset = useResetTimeout()

    useEffect(() => {
        cleanAndFetch()
    }, [])

    const cleanAndFetch = async () => {
        setIsRefreshing(true)
        try {
            await window.electronAPI?.agentCleanPermissionRules?.()
            await fetchPermissionRules()
        } finally {
            scheduleRefreshReset(() => setIsRefreshing(false), 500)
        }
    }

    const handleRefresh = async () => {
        await cleanAndFetch()
    }

    const handleEditClick = (rule: { tool: string; action: string }) => {
        setEditingRule(rule)
        setEditTool(rule.tool)
        setIsEditing(false) // 默认只读浏览模式
    }

    const handleSave = async () => {
        if (!editingRule) return
        const trimmed = editTool.trim()
        if (!trimmed) return

        try {
            if (trimmed !== editingRule.tool) {
                await removePermissionRule(editingRule.tool)
            }
            await addPermissionRule({tool: trimmed, action: editingRule.action})
            setIsEditing(false) // 保存后回到浏览模式
        } catch {
            // 静默处理
        }
    }

    const handleDelete = async () => {
        if (!editingRule) return
        if (!confirmingDelete) {
            setConfirmingDelete(true)
            return
        }
        try {
            await removePermissionRule(editingRule.tool)
            setEditingRule(null)
            setEditTool('')
            setIsEditing(false)
            setConfirmingDelete(false)
        } catch {
            // 静默处理
        }
    }

    const handleCancel = () => {
        if (confirmingDelete) {
            setConfirmingDelete(false)
            return
        }
        if (isEditing) {
            // 编辑模式 → 还原并退回浏览模式
            setEditTool(editingRule?.tool ?? '')
            setIsEditing(false)
        } else {
            // 浏览模式 → 关闭弹窗
            setEditingRule(null)
            setEditTool('')
        }
    }

    // 规则去重 + 排序
    const sortedRules = Array.from(new Map(permissionRules.map(r => [r.tool, r])).values())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

    return (
        <div className="relative flex flex-col h-full min-h-0 overflow-y-auto">
            <div
                className="permission-rules-card flex-1 min-h-0 flex flex-col"
            >
                {/* Header */}
                <div className="px-3 py-2.5 border-b border-[var(--border-muted)] flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                        <span className="text-xs font-medium text-[var(--text-secondary)]">权限规则</span>
                        <span className="text-[10px] text-[var(--text-secondary)] ml-1">({sortedRules.length})</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] disabled:opacity-50 transition-all"
                            aria-label="刷新规则"
                            title="刷新规则列表"
                         data-name="permission-rules-panel-button">
                            <svg
                                className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                            >
                                <path
                                    d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.2"/>
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {sortedRules.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-40 text-center opacity-40">
                            <svg className="w-8 h-8 text-[var(--text-muted)] mb-2" viewBox="0 0 24 24"
                                 fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            </svg>
                            <p className="text-xs text-[var(--text-secondary)]">暂无自动放行规则</p>
                        </div>
                    ) : (
                        sortedRules.map((rule, i) => (
                            <div
                                key={rule.tool}
                                onClick={() => handleEditClick(rule)}
                                className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-sm group cursor-pointer hover:border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] hover:shadow-sm transition-all"
                             data-name="permission-rules-panel-div">
                                <div className="flex items-center gap-1.5">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0"/>
                                    <span
                                        className="text-xs font-mono font-medium text-[var(--text-primary)] truncate min-w-0 flex-1"
                                        title={rule.tool}
                                    >{rule.tool}</span>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            removePermissionRule(rule.tool)
                                        }}
                                        className="text-[var(--error)] opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] rounded shrink-0"
                                        title="删除规则"
                                     data-name={`permission-rules-panel-rule-delete-${i}`}>
                                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none"
                                             stroke="currentColor" strokeWidth="2">
                                            <path
                                                d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                                        </svg>
                                    </button>
                                    <span
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] font-medium shrink-0">
                                        始终允许
                                    </span>
                                </div>
                                {rule.pattern && (
                                    <div className="mt-1.5 pl-3">
                                        <span
                                            className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-muted)] text-[var(--text-secondary)] font-mono truncate max-w-full block">
                                            {rule.pattern}
                                        </span>
                                    </div>
                                )}
                            </div>
                        ))
                    )}

                    <div className="pt-4 border-t border-[var(--border-muted)]">
                        <div className="p-3 rounded-lg bg-[color-mix(in_srgb,var(--brand-primary)_5%,transparent)] border border-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]">
                            <p className="text-[11px] text-[var(--text-brand)] font-medium mb-1">提示</p>
                            <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                                点击规则可编辑匹配模式。删除规则后，再次调用该工具将需要手动确认。
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* 编辑弹窗 */}
            {editingRule && (
                <div
                    className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-black/40 backdrop-blur-sm"
                    onClick={handleCancel}
                 data-name="permission-rules-panel-edit-overlay">
                    <div
                        className="bg-[var(--surface)] rounded-xl shadow-elevated border border-[var(--border)] w-[420px] overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                     data-name="permission-rules-panel-edit-panel">
                        {/* 弹窗 Header */}
                        <div className="px-5 py-4 border-b border-[var(--border-muted)] bg-[var(--surface-elevated)]">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] flex items-center justify-center shrink-0">
                                    <svg className="w-4 h-4 [color:var(--brand-primary)]" viewBox="0 0 24 24"
                                         fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                                    </svg>
                                </div>
                                <h3 className="text-sm font-semibold text-[var(--text-primary)]">编辑权限规则</h3>
                            </div>
                        </div>

                        {/* 弹窗 Body */}
                        <div className="p-5 space-y-4">
                            {isEditing ? (
                                // ── 编辑模式 ──
                                <div>
                                    <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
                                        匹配模式
                                    </label>
                                    <input
                                        type="text"
                                        value={editTool}
                                        onChange={(e) => setEditTool(e.target.value)}
                                        className={`w-full px-3 py-2 text-xs font-mono bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                                        placeholder="例如: bash:git*"
                                        autoFocus
                                        spellCheck={false}
                                    data-name="permission-rules-panel-input"/>
                                    <p className="mt-1.5 text-[10px] text-[var(--text-secondary)] leading-relaxed">
                                        支持 <code className="text-[var(--text-brand)]">*</code> 通配符，如
                                        <code className="text-[var(--text-brand)]"> bash:git*</code> 匹配所有以 git 开头的 bash 命令
                                    </p>
                                </div>
                            ) : (
                                // ── 浏览模式 ──
                                <div className="p-3 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
                                    <div className="flex items-center gap-1.5 mb-2">
                                        <span className="text-[10px] text-[var(--text-secondary)] font-medium uppercase tracking-wider">匹配模式</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-mono font-medium text-[var(--text-primary)] break-all">{editingRule?.tool}</span>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] font-medium shrink-0">始终允许</span>
                                    </div>
                                </div>
                            )}

                            <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] p-3">
                                <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0"/>
                                <span className="text-xs text-[var(--text-secondary)]">
                                    动作: <span className="text-[var(--success)] font-medium">始终允许</span>
                                </span>
                            </div>
                        </div>

                        {/* 弹窗 Footer */}
                        <div className="px-5 py-3 border-t border-[var(--border-muted)] bg-[var(--surface-elevated)] flex items-center justify-between">
                            {confirmingDelete ? (
                                // ── 删除确认 ──
                                <div className="flex items-center justify-between w-full">
                                    <div className="flex items-center gap-2 text-xs text-[var(--error)]">
                                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none"
                                             stroke="currentColor" strokeWidth="2">
                                            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                        </svg>
                                        <span>确定要删除此规则吗？</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => setConfirmingDelete(false)}
                                            className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                                                bg-[var(--surface-muted)] text-[var(--text-secondary)]
                                                hover:bg-[var(--surface-hover)] border border-[var(--border)]"
                                         data-name="permission-rules-panel-cancel-delete-button">
                                            取消
                                        </button>
                                        <button
                                            onClick={handleDelete}
                                            className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                                                bg-[var(--error)] text-white hover:bg-[color-mix(in_srgb,var(--error)_85%,black)]"
                                         data-name="permission-rules-panel-confirm-delete-button">
                                            确认删除
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <button
                                        onClick={handleDelete}
                                        className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                                            text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] border border-[var(--border)] hover:border-[color-mix(in_srgb,var(--error)_30%,transparent)]"
                                     data-name="permission-rules-panel-delete-button">
                                        删除规则
                                    </button>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={handleCancel}
                                            className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                                                bg-[var(--surface-muted)] text-[var(--text-secondary)]
                                                hover:bg-[var(--surface-hover)] border border-[var(--border)]"
                                         data-name="permission-rules-panel-cancel-edit-button">
                                            {isEditing ? '取消' : '关闭'}
                                        </button>
                                        {isEditing ? (
                                            <button
                                                onClick={handleSave}
                                                disabled={!editTool.trim()}
                                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                                                    bg-[var(--brand-primary)] text-white
                                                    hover:bg-[color-mix(in_srgb,var(--brand-primary)_85%,black)] disabled:opacity-40 disabled:cursor-not-allowed"
                                             data-name="permission-rules-panel-save-edit-button">
                                                保存
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => setIsEditing(true)}
                                                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all
                                                    bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--text-brand)]
                                                    hover:bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] border border-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]"
                                             data-name="permission-rules-panel-edit-button">
                                                编辑
                                            </button>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
