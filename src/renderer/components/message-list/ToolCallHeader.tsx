/**
 * ToolCallHeader — 工具调用头部组件
 *
 * 展示状态指示器、工具名称、进度、摘要、状态标签和展开按钮
 * 支持 compact（精简）和 normal（详细）两种模式
 */

import type {ToolCall} from '@shared/types'

interface ToolCallHeaderProps {
    toolCall: ToolCall
    expanded: boolean
    onToggleExpanded: () => void
    onOpenViewer: () => void

    // 状态配置
    cfg: {
        color: string
        bg: string
        icon: string
        label: string
    }

    // 运行时派生状态
    isRunning: boolean
    hasProgress: boolean
    progressPercent: number
    effectiveStatus: string
    effectiveProgress?: string
    effectiveAgentProgress?: string
    effectiveEta?: number

    // 显示信息
    agentDisplayName: string | null
    agentTypeLabel: string | null
    skillDisplayName: string | null
    mcpDisplayName: string | null
    summary: string | null
    terminalDisplay: string | null

    // 子 Agent 控制
    isSubAgent: boolean
    hasOutput: boolean

    // 模式
    isCompact: boolean
}

/**
 * 工具调用头部
 */
export default function ToolCallHeader({
    toolCall,
    expanded,
    onToggleExpanded,
    onOpenViewer,
    cfg,
    isRunning,
    hasProgress,
    progressPercent,
    effectiveStatus,
    effectiveProgress,
    effectiveAgentProgress,
    effectiveEta,
    agentDisplayName,
    agentTypeLabel,
    skillDisplayName,
    mcpDisplayName,
    summary,
    terminalDisplay,
    isSubAgent,
    hasOutput,
    isCompact,
}: ToolCallHeaderProps) {
    // ── 状态指示器（圆点/图标） ──
    const statusIndicator = (
        <span
            className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${
                isRunning
                    ? 'bg-[var(--info)]/15 animate-pulse ring-2 ring-[var(--info)]/30'
                    : ''
            }`}>
            {isRunning ? (
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--info)]"/>
            ) : (
                <span className={`text-sm ${cfg.color}`}>{cfg.icon}</span>
            )}
        </span>
    )

    // ── 查看按钮（子 Agent 工具且有输出时显示） ──
    const viewBtn = isSubAgent && hasOutput ? (
        <button
            onClick={(e) => {
                e.stopPropagation();
                onOpenViewer()
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium hover:bg-[var(--surface-muted)] border border-[var(--border)]"
            style={{color: 'var(--text-secondary)'}}
            title="查看子 Agent 详细输出"
        >
            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
            查看
        </button>
    ) : null

    // ── 元信息段（摘要 / 终端名 / 查看按钮 / 状态标签） ──
    const metaSection = (
        <>
            {summary && (
                <span
                    className={`text-[var(--text-muted)] truncate flex-1 font-mono opacity-80 ${isCompact ? '' : 'border-l border-[var(--border-muted)]'} pl-2 ml-1`}>
                    {summary}
                </span>
            )}
            {terminalDisplay && !summary && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--surface-muted)] text-[var(--text-muted)]">
                    {terminalDisplay}
                </span>
            )}
            {viewBtn}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${cfg.color} ${cfg.bg}`}>
                {cfg.label}
            </span>
        </>
    )

    // ── 工具名称区域（根据类型显示不同内容） ──
    const toolDisplayName = toolCall.name === 'agent' && agentDisplayName ? (
        <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1 min-w-0">
            <span className="text-[var(--text-muted)] shrink-0">agent</span>
            {agentTypeLabel && (
                <span
                    className="text-[10px] font-medium text-[var(--brand-primary)] bg-[var(--brand-muted)]/30 px-1.5 py-0.5 rounded shrink-0">
                    {agentTypeLabel}
                </span>
            )}
            <span className="truncate">
                {agentDisplayName.length > 40
                    ? agentDisplayName.slice(0, 40) + '...'
                    : agentDisplayName}
            </span>
        </span>
    ) : toolCall.name === 'agent' ? (
        <span className="font-mono font-semibold text-[var(--text-primary)]">agent</span>
    ) : toolCall.name === 'skill' && skillDisplayName ? (
        <span className="font-semibold text-[var(--brand-primary)] flex items-center gap-1">
            <span className="text-[var(--brand-primary)]/60 font-normal">skill 加载</span>
            <span>{skillDisplayName}</span>
        </span>
    ) : toolCall.name === 'skill' ? (
        <span className="font-mono font-semibold text-[var(--brand-primary)]">skill</span>
    ) : mcpDisplayName ? (
        /* MCP 工具：显示可读的服务名_工具名（如 m_GitHub_navigate_page） */
        <span className="font-semibold text-[var(--text-primary)] font-mono text-xs">
            {(() => {
                const parts = mcpDisplayName.split('_')
                return parts.map((part, i) => {
                    // 前缀（m_ 或 mp_）用品牌色，服务名用品牌色+下划线，工具名用主色
                    if (i === 0) {
                        const isPlugin = part.endsWith('p')
                        return (
                            <span key={i} className="text-[var(--brand-primary)]/70">
                                {part}
                                {i < parts.length - 1 ? '_' : ''}
                            </span>
                        )
                    } else if (i === 1) {
                        return (
                            <span key={i} className="text-[var(--brand-primary)]">
                                {part}
                                {'_'}
                            </span>
                        )
                    } else {
                        return (
                            <span key={i} className="text-[var(--text-primary)]">
                                {part}
                                {i < parts.length - 1 ? '_' : ''}
                            </span>
                        )
                    }
                })
            })()}
        </span>
    ) : (
        <span className="font-mono font-semibold text-[var(--text-primary)]">{toolCall.name}</span>
    )

    // ── 进度条（有百分比时显示） ──
    const progressBar = hasProgress ? (
        <div className="flex-1 mx-3 flex items-center gap-2">
            <div className="w-full rounded-full h-1.5 bg-[rgba(255,255,255,0.05)] overflow-hidden">
                <div
                    className="h-1.5 rounded-full transition-all duration-300"
                    style={{
                        width: `${progressPercent}%`,
                        background: 'linear-gradient(90deg, rgba(91,141,217,0.8), rgba(91,141,217,0.95))',
                        boxShadow: '0 0 8px rgba(91,141,217,0.4)'
                    }}
                />
            </div>
            <span className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                {progressPercent}%
                {effectiveEta !== undefined && ` (${Math.ceil(effectiveEta)}s)`}
            </span>
        </div>
    ) : null

    // ── 进度文本（无百分比时显示） ──
    const progressText = !hasProgress && effectiveProgress && effectiveStatus !== 'cancelled' ? (
        <span className="flex-1 text-[11px] text-[var(--info)] truncate mx-2 animate-pulse">
            {effectiveAgentProgress}
        </span>
    ) : null

    // ── Compact 模式 ──
    if (isCompact) {
        return (
            <div className="w-full flex items-center gap-2 px-3 py-2 text-left">
                {statusIndicator}
                {toolDisplayName}
                {progressBar}
                {progressText}
                {viewBtn}
                {metaSection}
            </div>
        )
    }

    // ── Normal 模式 ──
    return (
        <button
            onClick={onToggleExpanded}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] transition-colors text-left"
        >
            {statusIndicator}
            {toolDisplayName}
            {progressBar}
            {progressText}
            {metaSection}
            {/* Expand arrow */}
            <span className="text-[var(--text-muted)] text-[10px]" aria-hidden="true">
                {expanded ? '▾' : '▸'}
            </span>
        </button>
    )
}
