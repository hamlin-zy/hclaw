/**
 * ToolCallHeader — 工具调用头部组件
 *
 * 展示状态指示器、工具名称、进度、摘要、状态标签和展开按钮
 * 支持 compact（精简）和 normal（详细）两种模式
 */

import type {ToolCall} from '@shared/types'
import ToolCountdown from './ToolCountdown'

interface ToolCallHeaderProps {
    toolCall: ToolCall
    expanded: boolean
    onToggleExpanded: () => void
    onOpenViewer: () => void
    /** 跳转到对应子会话（子 Agent 已完成且有 taskId 时由父组件传入；不传则隐藏按钮） */
    onJumpToSession?: () => void

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

    // 倒计时（超时剩余时间）
    timeoutMs?: number
    startedAt?: number

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
    onJumpToSession,
    cfg,
    isRunning,
    hasProgress,
    progressPercent,
    effectiveStatus,
    effectiveProgress,
    effectiveAgentProgress,
    effectiveEta,
    timeoutMs,
    startedAt,
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

    // ── 查看按钮（子 Agent 工具，完成态且有输出时显示） ──
    // 运行中隐藏查看按钮（执行过程在子会话中实时展示，直接通过「跳转」按钮进入）
    const viewBtn = isSubAgent && !isRunning && hasOutput ? (
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
            {onJumpToSession && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onJumpToSession()
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium hover:bg-[var(--surface-muted)] border border-[var(--border)]"
                    style={{color: 'var(--brand-primary)'}}
                    title="跳转到子会话"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    跳转
                </button>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${cfg.color} ${cfg.bg}`}>
                {cfg.label}
            </span>
        </>
    )

    // ── 工具名称区域（根据类型显示不同内容） ──
    const toolDisplayName = toolCall.name === 'agent' && agentDisplayName ? (
        <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1 min-w-0">
            <span className="text-[var(--text-muted)] shrink-0">Agent</span>
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
        <span className="font-mono font-semibold text-[var(--text-primary)]">Agent</span>
    ) : toolCall.name === 'skill' && skillDisplayName ? (
        <span className="font-semibold text-[var(--brand-primary)] flex items-center gap-1">
            <span className="text-[var(--brand-primary)]/60 font-normal">🛠️ Skill</span>
            <span>{skillDisplayName}</span>
        </span>
    ) : toolCall.name === 'skill' ? (
        <span className="font-mono font-semibold text-[var(--brand-primary)]">🛠️ Skill</span>
    ) : mcpDisplayName ? (
        /* MCP 工具：显示可读的服务名_工具名（如 m_GitHub_navigate_page） */
        <span className="font-semibold text-[var(--text-primary)] font-mono text-xs">
            {(() => {
                const parts = mcpDisplayName.split('_')
                return parts.map((part, i) => {
                    // 前缀（m_ 或 mp_）用品牌色，服务名用品牌色+下划线，工具名用主色
                    if (i === 0) {
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

    const countdownBadge = isRunning ? <ToolCountdown timeoutMs={timeoutMs} startedAt={startedAt}/> : null

    // ── Compact 模式 ──
    // 注意：viewBtn 不在此处单独渲染 —— metaSection 内已包含 viewBtn，避免重复显示
    if (isCompact) {
        return (
            <div className="w-full flex items-center gap-2 px-3 py-2 text-left">
                {statusIndicator}
                {toolDisplayName}
                {countdownBadge}
                {progressBar}
                {progressText}
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
            {countdownBadge}
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
