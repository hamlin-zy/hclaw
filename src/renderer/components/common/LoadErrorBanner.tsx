import {useState} from 'react'

interface LoadErrorItem {
    name: string
    error: string
}

interface Props {
    errors: LoadErrorItem[]
    title: string
    tip: string
}

/**
 * 加载错误警告横幅
 *
 * 在 Agent / Skill 管理对话框的顶部显示解析失败的错误列表，
 * 用户可手动关闭，下次同步/刷新时自动重置。
 */
export default function LoadErrorBanner({errors, title, tip}: Props) {
    const [dismissed, setDismissed] = useState(false)

    if (errors.length === 0 || dismissed) return null

    return (
        <div className="mx-4 mt-2 px-3 py-2 text-xs rounded-md bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20">
            <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 font-medium">
                    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <span>{title}</span>
                </div>
                <button
                    onClick={() => setDismissed(true)}
                    className="p-0.5 rounded hover:bg-[var(--warning)]/20 transition-colors"
                    title="关闭"
                >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div className="space-y-1">
                {errors.map((err, i) => (
                    <div key={i} className="pl-5 text-[var(--text-muted)]">
                        <span className="font-medium text-[var(--text-primary)]">{err.name}</span>
                        : {err.error}
                    </div>
                ))}
            </div>
            <p className="mt-1 pl-5 text-[var(--text-muted)]">{tip}</p>
        </div>
    )
}
