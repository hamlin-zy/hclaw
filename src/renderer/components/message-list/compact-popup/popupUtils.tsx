import {memo, useCallback, useState} from 'react'

/**
 * 渲染 diff 文本（语法着色行）
 */
export function renderDiff(diffText: string): React.ReactNode {
    const lines = diffText.split('\n')
    return lines.map((line, i) => {
        if (line.startsWith('@@')) {
            return <div key={i} className="text-[var(--info)] bg-[rgba(74,158,255,0.06)] px-2 py-0.5 -mx-2">{line}</div>
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            return <div key={i} className="text-[var(--success)] bg-[rgba(34,197,94,0.08)] px-2 py-0.5 -mx-2">+{line.slice(1)}</div>
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            return <div key={i} className="text-[var(--error)] bg-[rgba(239,68,68,0.08)] px-2 py-0.5 -mx-2">-{line.slice(1)}</div>
        }
        return <div key={i} className="px-2 py-0.5 -mx-2">{line}</div>
    })
}

/**
 * 复制按钮（与 MarkdownRenderer 中一致）
 */
export const CopyButton = memo(function CopyButton({code, label}: { code: string; label?: string }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // 复制失败，静默处理
        }
    }, [code])

    return (
        <button
            onClick={handleCopy}
            className="absolute top-2 right-2 px-2 py-1 text-[10px] rounded transition-colors
                bg-[var(--surface-muted)] hover:bg-[var(--surface-elevated)]
                text-[var(--text-muted)] hover:text-[var(--text-primary)]
                border border-[var(--border)] opacity-0 group-hover:opacity-100"
            title={label || '复制'}
        >
            {copied ? '已复制' : '复制'}
        </button>
    )
})
