import {useCallback, useEffect, useState} from 'react'
import MarkdownRenderer from '../message-list/MarkdownRenderer'

interface SystemPromptResult {
    success: boolean
    systemPrompt?: string
    error?: string
}

export default function SystemPromptDialog() {
    const [data, setData] = useState<SystemPromptResult | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // 加载数据
    const loadData = useCallback(async () => {
        setIsLoading(true)
        setError(null)
        try {
            const result = await window.electronAPI?.systemPromptBuild?.()
            setData(result as SystemPromptResult)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        loadData()
    }, [loadData])

    // 复制到剪贴板
    const handleCopy = useCallback(() => {
        if (data?.systemPrompt) {
            navigator.clipboard.writeText(data.systemPrompt)
        }
    }, [data])

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-40">
                <div className="animate-spin w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full" />
                <span className="ml-3 text-sm text-[var(--text-muted)]">构建中...</span>
            </div>
        )
    }

    if (error) {
        return (
            <div className="p-4">
                <div className="p-4 bg-[var(--error-muted)] rounded-lg border border-[var(--error)]/20">
                    <h4 className="text-sm font-medium text-[var(--error)] mb-2">构建失败</h4>
                    <pre className="text-xs text-[var(--error)] whitespace-pre-wrap break-all">{error}</pre>
                </div>
            </div>
        )
    }

    if (!data?.success) {
        return (
            <div className="p-4">
                <div className="p-4 bg-[var(--warning-muted)] rounded-lg border border-[var(--warning)]/20">
                    <h4 className="text-sm font-medium text-[var(--warning)] mb-2">构建失败</h4>
                    <pre className="text-xs text-[var(--warning)] whitespace-pre-wrap break-all">
                        {data?.error || '未知错误'}
                    </pre>
                </div>
            </div>
        )
    }

    return (
        <div className="h-full flex flex-col">
            {/* 工具栏 */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] shrink-0">
                <span className="text-xs text-[var(--text-muted)]">
                    共 {data.systemPrompt?.length || 0} 字符
                </span>
                <button
                    onClick={handleCopy}
                    className="px-3 py-1 text-xs text-[var(--brand-primary)] hover:bg-[var(--brand-muted)] rounded transition-colors"
                >
                    复制
                </button>
            </div>

            {/* 内容区 */}
            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                <MarkdownRenderer isUser={false} theme="dark">
                    {data.systemPrompt || ''}
                </MarkdownRenderer>
            </div>
        </div>
    )
}
