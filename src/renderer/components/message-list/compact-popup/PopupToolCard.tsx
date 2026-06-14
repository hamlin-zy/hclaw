/**
 * 单个工具卡片（Popup 内使用）
 */
import {memo, useMemo} from 'react'
import type {ToolCall} from '@shared/types'
import {useToolCallsStore} from '../../../stores/toolCallsStore'
import {useMcpStore} from '../../../stores/mcpStore'
import {parseMcpToolName, buildMcpShortIdMap, resolveMcpDisplayName, extractMcpToolName, isMcpToolName} from '@shared/utils/mcpShortId'
import {getToolArgSummary, getToolDetail} from '../utils/messageUtils'
import {getCompactStatusConfig} from '../config/toolStatusConfig'
import {truncate} from '../../../lib/format'
import MarkdownRenderer from '../MarkdownRenderer'
import {renderDiff, CopyButton} from './popupUtils'

/**
 * 格式化输出值（处理对象、数组等非字符串类型）
 */
function formatOutput(output: unknown): string {
    if (typeof output === 'string') return output
    if (output === null || output === undefined) return ''
    try {
        return JSON.stringify(output, null, 2)
    } catch {
        return String(output)
    }
}

/**
 * 获取 Skill 调用的详细信息
 */
function getSkillDetail(tc: ToolCall): string | null {
    const args = tc.arguments as any
    if (!args) return null
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
        if (k === 'reason') continue
        cleaned[k] = v
    }
    return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned, null, 2) : null
}

/**
 * 工具调用状态配置（简约版，仅用于 Popup 卡片）
 */
const statusConfig = getCompactStatusConfig

export const PopupToolCard = memo(function PopupToolCard({toolCall, index, expanded, onToggle}: {
    toolCall: ToolCall; index: number; expanded: boolean; onToggle: (id: string) => void
}) {
    const isSkillTool = toolCall.name === 'skill'
    const runtimeState = useToolCallsStore((s) => s.states[toolCall.id])
    const effectiveStatus = runtimeState?.status ?? toolCall.status
    const effectiveResult = runtimeState?.result ?? toolCall.result
    const cfg = statusConfig(effectiveStatus)
    const argSummary = getToolArgSummary(toolCall)
    const detail = isSkillTool ? getSkillDetail(toolCall) : getToolDetail(toolCall)
    const hasOutput = effectiveResult?.output && effectiveStatus !== 'running'
    const errorLine = effectiveResult?.error

    // MCP 工具显示名：解析为可读格式
    const mcpServers = useMcpStore(s => s.mcpServers)
    const mcpDisplayName = useMemo(() => {
        if (!isMcpToolName(toolCall.name)) return null
        const parsed = parseMcpToolName(toolCall.name)
        if (!parsed) return null

        // 旧格式：通过 shortId 反查
        if (parsed.shortId) {
            const shortIdMap = buildMcpShortIdMap(mcpServers)
            const info = shortIdMap.get(parsed.shortId)
            if (info) {
                const prefix = info.isPlugin ? 'mp_' : 'm_'
                return `${prefix}${info.name}_${parsed.toolName}`
            }
        }

        // 新格式或兜底：通过 mcpServers 匹配
        const resolved = resolveMcpDisplayName(toolCall.name, mcpServers)
        if (resolved) return resolved

        const toolOnly = extractMcpToolName(toolCall.name)
        return toolOnly ? `m_..._${toolOnly}` : null
    }, [toolCall.name, mcpServers])

    // 工具显示的名称
    const displayName = isSkillTool
        ? (toolCall.skillName || 'skill')
        : (mcpDisplayName ?? toolCall.name)

    return (
        <div className={`rounded-lg overflow-hidden mb-1.5 border transition-colors ${
            effectiveStatus === 'error'
                ? 'border-[rgba(239,68,68,0.2)] bg-[var(--error-muted)]/15'
                : 'border-[var(--border)] bg-[var(--surface-muted)]'
        }`}>
            <button onClick={() => onToggle(toolCall.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors">
                <span className="text-[10px] text-[var(--text-muted)] w-5 shrink-0 text-right font-mono">#{index + 1}</span>
                <span className={`text-xs w-4 text-center shrink-0 ${cfg.color}`}>{cfg.icon}</span>
                <span className="font-semibold text-[var(--text-primary)] text-[11px] shrink-0">
                    {isSkillTool ? 'skill' : ''}<span className={isSkillTool ? 'font-mono' : 'font-mono font-semibold'}>{isSkillTool && displayName ? ` ${displayName}` : displayName}</span>
                </span>
                {argSummary && <span className="text-[10px] text-[var(--text-muted)] truncate flex-1 min-w-0 ml-1">{argSummary}</span>}
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 font-medium ${cfg.badgeClass}`}>{cfg.label}</span>
                <span className="text-[9px] text-[var(--text-muted)] shrink-0 transition-transform"
                     style={{transform: expanded ? 'rotate(90deg)' : 'none'}}>▸</span>
            </button>
            {expanded && (
                <div className="border-t border-[var(--border)] px-4 py-2.5 bg-[var(--surface-muted)] space-y-2 select-text">
                    {detail && (
                        <div className="relative group select-text">
                            <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">{toolCall.name === 'bash' ? '命令' : isSkillTool ? '输入' : '参数'}</span>
                            <pre className="text-[10px] text-[var(--text-primary)] font-mono whitespace-pre-wrap break-all leading-relaxed mt-1 p-2 bg-[var(--surface-overlay)] rounded border border-[var(--border-muted)] max-h-48 overflow-x-hidden overflow-y-auto select-text">{detail}</pre>
                            <CopyButton code={detail} label="复制参数"/>
                        </div>
                    )}
                    {toolCall.name === 'file_edit' && effectiveResult?.diff && (
                        <div>
                            <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">变更差异</span>
                            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all leading-relaxed mt-1 p-2 bg-[var(--surface-overlay)] rounded border border-[var(--border-muted)] max-h-64 overflow-x-hidden overflow-y-auto select-text">{renderDiff(String(effectiveResult.diff))}</pre>
                        </div>
                    )}
                    {hasOutput && !(effectiveResult as any)?.diff && (
                        <div className="relative group select-text">
                            <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">{toolCall.name === 'file_edit' ? '执行结果' : '输出'}</span>
                            <div className="text-[10px] text-[var(--text-primary)] leading-relaxed mt-1 p-2 bg-[var(--surface-overlay)] rounded border border-[var(--border-muted)] max-h-48 overflow-x-hidden overflow-y-auto break-all select-text">
                                <MarkdownRenderer>{truncate(formatOutput(effectiveResult!.output), 4000)}</MarkdownRenderer>
                            </div>
                            <CopyButton code={formatOutput(effectiveResult!.output)} label="复制输出"/>
                        </div>
                    )}
                    {errorLine && (
                        <div className="relative group select-text">
                            <span className="text-[9px] text-[var(--error)] uppercase tracking-wide">错误</span>
                            <pre className="text-[10px] text-[var(--error)] font-mono whitespace-pre-wrap break-all leading-relaxed mt-1 p-2 bg-[var(--error-muted)]/20 rounded border border-[rgba(239,68,68,0.12)] max-h-48 overflow-x-hidden overflow-y-auto select-text">{String(errorLine)}</pre>
                            <CopyButton code={String(errorLine)} label="复制错误"/>
                        </div>
                    )}
                    {effectiveStatus === 'running' && (
                        <div className="flex items-center gap-2 text-[var(--info)] text-[10px]">
                            <span className="inline-block w-1 h-1 bg-[var(--info)] rounded-full animate-bounce" style={{animationDelay: '0ms'}}/>
                            <span className="inline-block w-1 h-1 bg-[var(--info)] rounded-full animate-bounce" style={{animationDelay: '150ms'}}/>
                            <span className="inline-block w-1 h-1 bg-[var(--info)] rounded-full animate-bounce" style={{animationDelay: '300ms'}}/>
                            <span className="ml-1">正在执行...</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
})
