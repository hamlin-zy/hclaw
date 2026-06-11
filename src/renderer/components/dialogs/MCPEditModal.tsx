import { useEffect } from 'react'
import type { MCPServer } from '@shared/types'
import MCPEditCard from './MCPEditCard'

interface MCPEditModalProps {
    server?: MCPServer | null  // null/undefined = 添加模式
    onSave: (data: Partial<MCPServer>) => void | Promise<void>
    onCancel: () => void
    onTestError?: (server: MCPServer, errorMessage: string) => void
}

export default function MCPEditModal({ server, onSave, onCancel, onTestError }: MCPEditModalProps) {
    const title = !server ? '添加 MCP 服务' : '编辑 MCP 服务'

    // 按 Esc 关闭
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel()
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [onCancel])

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
             onClick={onCancel}>
            <div className="absolute inset-0 bg-black/50"/>
            <div onClick={e => e.stopPropagation()}
                 className="relative w-[580px] max-h-[85vh] bg-[var(--surface)] rounded-xl shadow-elevated border border-[var(--border)] flex flex-col overflow-hidden">
                {/* 标题栏 */}
                <div className="shrink-0 bg-[var(--surface-elevated)] px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
                    <button onClick={onCancel}
                            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded transition-colors">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                {/* 表单区 */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                    <MCPEditCard
                        server={server ?? undefined}
                        onSave={onSave}
                        onCancel={onCancel}
                        onTestError={onTestError}
                    />
                </div>
            </div>
        </div>
    )
}
