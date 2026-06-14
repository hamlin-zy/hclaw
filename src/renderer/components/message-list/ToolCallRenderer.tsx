/**
 * 工具调用渲染器组件
 * 展示各种工具（bash、file_read、MCP工具等）的执行状态和结果
 *
 * 性能优化：
 * - 运行时状态（progress、status）从独立的 toolCallsStore 读取，
 *   避免每次更新都触发整个消息列表重渲染
 * - 静态状态（arguments、result）从 message.toolCalls 读取
 *
 * 架构说明：
 * 本文件作为组合器（orchestrator），负责：
 * 1. 派生所有运行时的有效状态
 * 2. 根据模式决定渲染策略
 * 3. 将渲染委托给子组件（ToolCallHeader、ToolCallBody 等）
 */

import {memo, useMemo, useState} from 'react'
import type {ToolCall, ThinkBlock as ThinkBlockType} from '@shared/types'
import {getToolSummary} from './utils/messageUtils'
import {getFullStatusConfig} from './config/toolStatusConfig'
import {useToolCallsStore} from '../../stores/toolCallsStore'
import {useModelSchemeStore} from '../../stores/modelSchemeStore'
import {useLLMStore} from '../../stores/llmStore'
import {useAgentStore} from '../../stores/agentStore'
import {useMcpStore} from '../../stores/mcpStore'
import {resolveMcpDisplayName, extractMcpToolName, isMcpToolName} from '@shared/utils/mcpShortId'
import SubAgentViewer from './SubAgentViewer'
import ToolCallHeader from './ToolCallHeader'
import ToolCallBody from './ToolCallBody'

interface ToolCallRendererProps {
    toolCall: ToolCall
}

/**
 * 工具调用渲染器
 */
const ToolCallRendererBase = function ToolCallRendererBase({toolCall}: ToolCallRendererProps) {
    const [expanded, setExpanded] = useState(false)
    const [viewerOpen, setViewerOpen] = useState(false)

    // 从独立的 toolCallsStore 获取运行时状态（避免全局重渲染）
    // 注意：selector 只依赖 toolCall.id，避免因 toolCall 其他字段变化而重渲染
    const runtimeState = useToolCallsStore((s) => s.states[toolCall.id])
    
    // 合并静态状态和运行时状态，运行时状态优先
    const effectiveStatus = runtimeState?.status ?? toolCall.status
    const effectiveProgress = runtimeState?.progress ?? toolCall.progress
    const effectiveProgressPercent = runtimeState?.progressPercent ?? toolCall.progressPercent
    const effectiveEta = runtimeState?.eta ?? toolCall.eta
    const effectiveDetailStatus = runtimeState?.detailStatus ?? toolCall.detailStatus
    const effectiveResult = runtimeState?.result ?? toolCall.result
    const effectiveTokenUsage = runtimeState?.tokenUsage ?? toolCall.tokenUsage
    const effectiveProgressLog = runtimeState?.progressLog
    const effectiveSubAgentStream = runtimeState?.subAgentStream

    // Agent 工具显示名：优先 taskDescription，其次 arguments.task
    const agentDisplayName = toolCall.name === 'agent'
        ? (toolCall.taskDescription ||
           (typeof (toolCall.arguments as any)?.task === 'string' ? (toolCall.arguments as any).task : null))
        : null

    // Agent 类型标签（如 Plan / Explore / General），来自 arguments.agentType
    const rawAgentType = toolCall.name === 'agent' ? (toolCall.arguments as any)?.agentType : null
    const agentTypeLabel = typeof rawAgentType === 'string' && rawAgentType
        ? rawAgentType.charAt(0).toUpperCase() + rawAgentType.slice(1)
        : null

    // Skill 工具显示名：优先 skillName，其次 arguments.name / arguments.skill
    const skillDisplayName = toolCall.name === 'skill'
        ? (toolCall.skillName ||
           (typeof (toolCall.arguments as any)?.name === 'string' ? (toolCall.arguments as any).name : null) ||
           (typeof (toolCall.arguments as any)?.skill === 'string' ? (toolCall.arguments as any).skill : null))
        : null

    const cfg = getFullStatusConfig(effectiveStatus)
    const isRunning = effectiveStatus === 'running'

    // 新增：支持 progressPercent 和 eta
    const hasProgress = effectiveProgressPercent !== undefined
    const progressPercent = effectiveProgressPercent ?? 0

    // 安全获取 command，确保是字符串或 null
    const rawCommand = (toolCall.arguments as any).command
    const command =
        typeof rawCommand === 'string'
            ? rawCommand
            : rawCommand && typeof rawCommand === 'object'
                ? JSON.stringify(rawCommand)
                : null

    // 终端显示名称
    const terminalNames: Record<string, string> = {
        powershell: 'PowerShell',
        cmd: 'CMD',
        bash: 'Bash',
        sh: 'Shell'
    }
    const terminalDisplay = toolCall.terminal ? terminalNames[toolCall.terminal.name] || toolCall.terminal.name : null

    // 当前模型方案中 image_understanding 角色的模型名称（用于 analyze_image 卡片提前显示模型名称）
    // 注意：role.modelId 是 provider_models.id (UUID)，需解析为人类可读的 model_name
    const schemeVisionModelName = useModelSchemeStore(s => {
        if (toolCall.name !== 'analyze_image') return null
        const scheme = s.schemes.find(sc => sc.id === s.activeSchemeId)
        if (!scheme) return null
        const role = scheme.roles.find(r => r.role === 'image_understanding')
        if (!role?.enabled) return null
        // 用 role.modelId (UUID) 从 llmStore 解析出人类可读的模型名称
        const llmState = useLLMStore.getState()
        const provider = llmState.providers.find(p => p.id === role.endpointId)
        const model = provider?.models.find(m => m.id === role.modelId)
        return model?.name || role.modelId
    })

    // MCP 工具显示名（注册名即显示名：m_/mp_<serverName>_<toolName>）
    const mcpServers = useMcpStore(s => s.mcpServers)
    const mcpDisplayName = useMemo(() => {
        if (!isMcpToolName(toolCall.name)) return null

        // 优先用 resolveMcpDisplayName 精确匹配（支持新旧两种格式）
        const resolved = resolveMcpDisplayName(toolCall.name, mcpServers)
        if (resolved) return resolved

        // 兜底：至少去掉 hash 部分，显示 m_..._<工具名>
        const toolOnly = extractMcpToolName(toolCall.name)
        if (toolOnly) return `m_..._${toolOnly}`

        return null
    }, [toolCall.name, mcpServers])

    // 获取工具摘要（FilePath 或 Command）
    const summary = useMemo(() => {
        if (toolCall.name === 'analyze_image') {
            // 优先从结果中获取（最准确），其次从当前方案配置获取（执行中即可显示）
            const output = effectiveResult?.output ?? toolCall.result?.output
            if (output) {
                const modelMatch = output.match(/^\[视觉模型:\s*([^\]]+)\]/)
                if (modelMatch) return `视觉模型: ${modelMatch[1].trim()}`
            }
            if (schemeVisionModelName) return `视觉模型: ${schemeVisionModelName}`
            return null
        }
        return getToolSummary(toolCall)
    }, [toolCall, effectiveResult, schemeVisionModelName])

    // 精简模式下不展示详情展开
    const isCompact = useAgentStore((s) => s.messageDisplayMode) === 'compact'

    // ── 辅助：Agent 工具的进度文本前缀清理 ──────────────
    const effectiveAgentProgress = effectiveProgress && toolCall.name === 'agent'
        ? effectiveProgress.replace(/^子 Agent /, '')
        : effectiveProgress

    const isSubAgent = toolCall.name === 'agent' && !!toolCall.taskId
    const hasOutput = !!effectiveResult?.output || !!effectiveProgressLog?.length || !!effectiveSubAgentStream?.length

    return (
        <div
            className={`my-2 rounded-lg text-xs overflow-hidden transition-all duration-200 ${cfg.bg} ${
                isRunning ? cfg.glowClass : ''
            }`}
        >
            {/* ── Compact 模式：精简行 ── */}
            {isCompact ? (
                <ToolCallHeader
                    toolCall={toolCall}
                    expanded={false}
                    onToggleExpanded={() => {}}
                    onOpenViewer={() => setViewerOpen(true)}
                    cfg={cfg}
                    isRunning={isRunning}
                    hasProgress={false}
                    progressPercent={0}
                    effectiveStatus={effectiveStatus}
                    effectiveProgress={undefined}
                    effectiveAgentProgress={undefined}
                    effectiveEta={undefined}
                    agentDisplayName={null}
                    agentTypeLabel={null}
                    skillDisplayName={null}
                    mcpDisplayName={mcpDisplayName}
                    summary={summary}
                    terminalDisplay={terminalDisplay}
                    isSubAgent={isSubAgent}
                    hasOutput={hasOutput}
                    isCompact={true}
                />
            ) : (
                /* ── Normal 模式：展开式卡片 ── */
                <>
                    <ToolCallHeader
                        toolCall={toolCall}
                        expanded={expanded}
                        onToggleExpanded={() => setExpanded(!expanded)}
                        onOpenViewer={() => setViewerOpen(true)}
                        cfg={cfg}
                        isRunning={isRunning}
                        hasProgress={hasProgress}
                        progressPercent={progressPercent}
                        effectiveStatus={effectiveStatus}
                        effectiveProgress={effectiveProgress}
                        effectiveAgentProgress={effectiveAgentProgress}
                        effectiveEta={effectiveEta}
                        agentDisplayName={agentDisplayName}
                        agentTypeLabel={agentTypeLabel}
                        skillDisplayName={skillDisplayName}
                        mcpDisplayName={mcpDisplayName}
                        summary={summary}
                        terminalDisplay={terminalDisplay}
                        isSubAgent={isSubAgent}
                        hasOutput={hasOutput}
                        isCompact={false}
                    />

                    {/* Expanded details */}
                    {expanded && (
                        <ToolCallBody
                            toolCall={toolCall}
                            command={command}
                            effectiveResult={effectiveResult as any}
                            effectiveProgress={effectiveProgress}
                            effectiveAgentProgress={effectiveAgentProgress}
                            effectiveProgressLog={effectiveProgressLog}
                            effectiveSubAgentStream={effectiveSubAgentStream}
                            effectiveTokenUsage={effectiveTokenUsage}
                            effectiveStatus={effectiveStatus}
                            isRunning={isRunning}
                        />
                    )}
                </>
            )}

            {/* 子 Agent 输出查看弹窗（在两种模式下均可用） */}
            {viewerOpen && toolCall.name === 'agent' && (
                <SubAgentViewer
                    title={agentDisplayName || '子 Agent'}
                    agentType={agentTypeLabel}
                    progressLog={effectiveProgressLog}
                    subAgentStream={effectiveSubAgentStream}
                    result={effectiveResult as import('../../stores/toolCallsStore').ExtendedToolResult | null}
                    tokenUsage={effectiveTokenUsage ?? null}
                    onClose={() => setViewerOpen(false)}
                />
            )}
        </div>
    )
}

// ─────────────────────────────────────────────────────
// UltraCompact 紧凑模式：工具组行 + Popup 展开
// ─────────────────────────────────────────────────────

/**
 * 工具组行 — 紧凑模式的核心展示组件
 * 将连续的同条消息中的多个工具调用聚合成一行概要
 *
 * 格式示例：
 *   ● file_read 3/3 · bash 5/6   展开详情 >
 *   ● (有失败时红点) file_read 3/3 · bash 5/6   展开详情 >
 */
interface UltraCompactToolGroupProps {
    toolCalls: ToolCall[]
    /** 标题（默认 "工具调用详情"） */
    title?: string
    /** 是否作为 Agent 工具展示 */
    isAgent?: boolean
    /** Agent 显示名 */
    agentDisplayName?: string | null
    /** Agent 类型标签 */
    agentTypeLabel?: string | null
}

/**
 * 统计一组工具调用的状态
 */
function computeGroupStats(toolCalls: ToolCall[]) {
    let successCount = 0
    let errorCount = 0
    let runningCount = 0
    let pendingCount = 0

    for (const tc of toolCalls) {
        const state = useToolCallsStore.getState().states[tc.id]
        const status = state?.status ?? tc.status
        if (status === 'success') successCount++
        else if (status === 'error') errorCount++
        else if (status === 'running') runningCount++
        else pendingCount++
    }

    const total = toolCalls.length
    const hasError = errorCount > 0
    const isRunning = runningCount > 0

    return { successCount, errorCount, runningCount, pendingCount, total, hasError, isRunning }
}

/**
 * 按工具名称分组统计 (同一组内)
 */
function computeTypeCounts(toolCalls: ToolCall[]) {
    const map = new Map<string, { total: number; error: number }>()
    for (const tc of toolCalls) {
        const state = useToolCallsStore.getState().states[tc.id]
        const status = state?.status ?? tc.status
        if (!map.has(tc.name)) map.set(tc.name, { total: 0, error: 0 })
        const entry = map.get(tc.name)!
        entry.total++
        if (status === 'error') entry.error++
    }
    return map
}

const UltraCompactToolGroup = memo(function UltraCompactToolGroup({
    toolCalls,
    title,
    isAgent,
    agentDisplayName,
    agentTypeLabel,
}: UltraCompactToolGroupProps) {
    const openToolPopup = useAgentStore((s) => s.openToolPopup)

    const stats = computeGroupStats(toolCalls)
    const typeCounts = computeTypeCounts(toolCalls)

    // 圆点颜色
    const dotClass = stats.isRunning
        ? 'bg-[var(--info)] animate-pulse'
        : stats.hasError
            ? 'bg-[var(--error)]'
            : 'bg-[var(--success)]'

    // 生成工具芯片列表
    const chips: { name: string; total: number; error: number }[] = []
    typeCounts.forEach((v, k) => chips.push({ name: k, total: v.total, error: v.error }))

    const handleClick = () => {
        openToolPopup({
            toolCalls,
            title,
            isAgent,
            agentDisplayName,
            agentTypeLabel,
        })
    }

    return (
        <>
            {/* 概要行 */}
            <button
                onClick={handleClick}
                className="w-full flex items-center gap-2 px-3 py-1.5 my-1 rounded-lg text-left transition-colors
                    border border-[var(--border)] bg-[var(--surface-muted)]
                    hover:bg-[var(--surface-elevated)] hover:border-[var(--border-emphasis)]"
            >
                {/* Agent 特殊图标 */}
                {isAgent && (
                    <span className="text-[var(--brand-primary)] text-xs shrink-0">⚡</span>
                )}

                {/* 状态圆点 */}
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}/>

                {/* Agent 名称 + 描述 */}
                {isAgent ? (
                    <span className="flex items-center gap-1.5 text-[11px] min-w-0 flex-1">
                        <span className="font-semibold text-[var(--text-primary)]">
                            {agentTypeLabel || 'Agent'}
                        </span>
                        <span className="text-[var(--text-muted)] truncate">
                            {agentDisplayName || '子 Agent 任务'}
                        </span>
                    </span>
                ) : (
                    /* 工具芯片列表 */
                    <span className="flex items-center gap-1.5 text-[11px] min-w-0 flex-1 overflow-hidden">
                        {chips.map((chip) => (
                            <span key={chip.name}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded
                                    bg-[rgba(255,255,255,0.05)] text-[var(--text-secondary)] shrink-0"
                            >
                                <span className="font-mono font-semibold">{chip.name}</span>
                                <span className={chip.error > 0 ? 'text-[var(--error)]' : 'text-[var(--success)]'}>
                                    {chip.total - chip.error}/{chip.total}
                                </span>
                            </span>
                        ))}
                    </span>
                )}

                {/* 展开详情 */}
                <span className="text-[10px] text-[var(--text-muted)] shrink-0 flex items-center gap-0.5">
                    展开详情
                    <span className="text-[8px]" style={{color: 'var(--text-muted)'}}>›</span>
                </span>
            </button>
        </>
    )
})


/**
 * 使用 memo 包装组件，禁用子元素重渲染
 * 性能优化：只依赖 toolCall.id，当其他字段（result、progress）变化时，
 * 由 toolCallsStore 单独管理，不触发整个工具卡片重渲染
 */
// ──
// CombinedItem 类型（由 InterleavedContent 导出，此处重新定义以避免循环引用）
// ──

export interface CombinedItem {
    type: 'think' | 'tools'
    thinkBlock?: ThinkBlockType
    blockId?: string
    toolCalls?: ToolCall[]
}

interface UltraCompactCombinedGroupProps {
    items: CombinedItem[]
    thinkCount: number
    toolCalls: ToolCall[]
}

/**
 * 聚合卡片 — 将思考块 + 工具调用合并为一个聚合卡片
 *
 * 格式示例：
 *   ● 思考 2 · file_read 2/2 · web_fetch 1/1   展开详情 >
 *   ● (有失败时红点) 思考 0 · bash 3/4   展开详情 >
 */
const UltraCompactCombinedGroup = memo(function UltraCompactCombinedGroup({
    items,
    thinkCount,
    toolCalls,
}: UltraCompactCombinedGroupProps) {
    const openCombinedPopup = useAgentStore((s) => s.openCombinedPopup)

    const stats = computeGroupStats(toolCalls)
    const typeCounts = computeTypeCounts(toolCalls)

    // 圆点颜色（基于工具状态）
    const dotClass = stats.isRunning
        ? 'bg-[var(--info)] animate-pulse'
        : stats.hasError
            ? 'bg-[var(--error)]'
            : 'bg-[var(--success)]'

    // 生成工具芯片列表
    const chips: { name: string; total: number; error: number }[] = []
    typeCounts.forEach((v, k) => chips.push({ name: k, total: v.total, error: v.error }))

    const handleClick = () => {
        openCombinedPopup({ items: items as any[], thinkCount, toolCalls: toolCalls as any[] })
    }

    return (
        <button
            onClick={handleClick}
            className="w-full flex items-center gap-2 px-3 py-1.5 my-1 rounded-lg text-left transition-colors
                border border-[var(--border)] bg-[var(--surface-muted)]
                hover:bg-[var(--surface-elevated)] hover:border-[var(--border-emphasis)]"
        >
            {/* 状态圆点 */}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}/>

            {/* 芯片列表 */}
            <span className="flex items-center gap-1.5 text-[11px] min-w-0 flex-1 overflow-hidden">
                {/* 思考计数芯片 */}
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded
                    bg-[rgba(91,141,217,0.15)] text-[var(--brand-primary)] shrink-0 font-mono font-semibold">
                    思考 {thinkCount}
                </span>
                {/* 工具芯片 */}
                {chips.map((chip) => (
                    <span key={chip.name}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded
                            bg-[rgba(255,255,255,0.05)] text-[var(--text-secondary)] shrink-0"
                    >
                        <span className="font-mono font-semibold">{chip.name}</span>
                        <span className={chip.error > 0 ? 'text-[var(--error)]' : 'text-[var(--success)]'}>
                            {chip.total - chip.error}/{chip.total}
                        </span>
                    </span>
                ))}
            </span>

            {/* 展开详情 */}
            <span className="text-[10px] text-[var(--text-muted)] shrink-0 flex items-center gap-0.5">
                展开详情
                <span className="text-[8px]" style={{color: 'var(--text-muted)'}}>›</span>
            </span>
        </button>
    )
})


export default memo(ToolCallRendererBase, (prevProps, nextProps) => {
    return prevProps.toolCall.id === nextProps.toolCall.id
})

export {UltraCompactToolGroup, UltraCompactCombinedGroup}
