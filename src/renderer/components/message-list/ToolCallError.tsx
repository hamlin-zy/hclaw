/**
 * ToolCallError — 工具调用错误显示组件
 *
 * 展示工具执行过程中的错误信息
 */

interface ToolCallErrorProps {
    /** 错误信息文本 */
    error: string
}

/**
 * 错误状态显示
 */
export default function ToolCallError({error}: ToolCallErrorProps) {
    if (!error) return null

    return (
        <div>
            <span className="text-[10px] text-[var(--error)] uppercase tracking-wide">错误</span>
            <pre
                className="text-[11px] text-[var(--error)] whitespace-pre-wrap font-mono leading-relaxed p-2 mt-1 bg-[var(--error-muted)]/20 border border-[rgba(196,92,92,0.12)] rounded-md">
                {error}
            </pre>
        </div>
    )
}
