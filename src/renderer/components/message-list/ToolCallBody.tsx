/**
 * ToolCallBody — 工具调用展开详情组件
 *
 * 展示命令、参数、执行过程（合并 timeline+stream 交织渲染）、输出结果、错误信息、运行指示器和 Token 用量
 */

import type {ToolCall} from '@shared/types'
import type {ExtendedToolResult, ProgressEntry, SubAgentStreamEntry} from '../../stores/toolCallsStore'
import {isMcpToolName} from '@shared/utils/mcpShortId'
import {formatToolArgs} from './utils/messageUtils'
import {truncate} from '../../lib/format'
import ToolCallError from './ToolCallError'
import ToolCallResult from './ToolCallResult'
import {StreamEntryCard, ProgressTimeline, mergeTimeline, getLastActiveTime} from './StreamEntryRenderer'

interface ToolCallBodyProps {
    toolCall: ToolCall
    command: string | null
    effectiveResult: ExtendedToolResult | undefined
    effectiveProgress?: string
    effectiveAgentProgress?: string
    effectiveProgressLog?: ProgressEntry[]
    effectiveSubAgentStream?: SubAgentStreamEntry[]
    effectiveTokenUsage?: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
    }
    effectiveStatus: string
    isRunning: boolean
}

/**
 * 展开的详情内容
 */
export default function ToolCallBody({
    toolCall,
    command,
    effectiveResult,
    effectiveProgress,
    effectiveAgentProgress,
    effectiveProgressLog,
    effectiveSubAgentStream,
    effectiveTokenUsage,
    effectiveStatus,
    isRunning,
}: ToolCallBodyProps) {
    return (
        <div
            className="border-t border-[rgba(255,255,255,0.03)] px-3 py-2.5 bg-[var(--surface-elevated)]/30 space-y-2">
            {/* Command (for bash) */}
            {command && (
                <div>
                    <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">命令</span>
                    <pre
                        className="text-[11px] text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mt-1 p-2 bg-[var(--surface)]/40 border border-[rgba(255,255,255,0.03)] rounded-md">
                        {command}
                    </pre>
                </div>
            )}

            {/* Arguments (for file_edit) — 显示修改前后对比 */}
            {toolCall.name === 'file_edit' && (toolCall.arguments as any).oldString && (
                <div>
                    <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">修改内容</span>
                    <div className="mt-1 space-y-1">
                        <div className="flex items-start gap-1">
                            <span
                                className="text-[10px] px-2 py-1 rounded-md font-mono whitespace-pre-wrap bg-[var(--error-muted)]/40 border border-[rgba(196,92,92,0.15)] text-[var(--error)]">
                                - {truncate(String((toolCall.arguments as any).oldString), 500)}
                            </span>
                        </div>
                        <div className="flex items-start gap-1">
                            <span
                                className="text-[10px] px-2 py-1 rounded-md font-mono whitespace-pre-wrap bg-[var(--success-muted)]/40 border border-[rgba(16,185,129,0.15)] text-[var(--success)]">
                                + {truncate(String((toolCall.arguments as any).newString ?? ''), 500)}
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Diff first (for file_edit), then output — placeholder for future use */}
            {toolCall.name === 'file_edit' && toolCall.result?.diff && <div/>}

            {/* Written content (for file_write) */}
            {toolCall.name === 'file_write' && toolCall.result?.artifacts?.[0]?.content && (
                <div>
                    <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">写入内容</span>
                    <pre
                        className="text-[11px] text-[var(--text-secondary)] max-h-48 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed p-2 mt-1 bg-[var(--success-muted)]/20 border border-[rgba(16,185,129,0.12)] rounded-md">
                        {truncate(String(toolCall.result.artifacts[0].content), 2000)}
                    </pre>
                </div>
            )}

            {/* ── MCP Tools: show full arguments ── */}
            {isMcpToolName(toolCall.name) && Object.keys(toolCall.arguments).length > 0 && (
                <div>
                    <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">请求参数</span>
                    <pre
                        className="text-[11px] text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mt-1 p-2 bg-[var(--surface)]/40 border border-[rgba(255,255,255,0.03)] rounded-md">
                        {formatToolArgs(toolCall.arguments)}
                    </pre>
                </div>
            )}

            {/* ── Generic arguments fallback (non-bash, non-file_edit, non-mcp) ── */}
            {!isMcpToolName(toolCall.name) &&
                toolCall.name !== 'bash' &&
                toolCall.name !== 'file_edit' &&
                toolCall.name !== 'file_write' &&
                toolCall.name !== 'file_read' &&
                Object.keys(toolCall.arguments).length > 0 && (
                    <div>
                        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                            请求参数
                        </span>
                        <pre
                            className="text-[11px] text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mt-1 p-2 bg-[var(--surface)]/40 border border-[rgba(255,255,255,0.03)] rounded-md">
                            {formatToolArgs(toolCall.arguments)}
                        </pre>
                    </div>
                )}

            {/* ── Agent 工具：处理过程 + 详细输出（按真实时间序交织渲染）── */}
            {toolCall.name === 'agent' && (
                (effectiveProgressLog?.length ?? 0) > 0 || (effectiveSubAgentStream?.length ?? 0) > 0
            ) && (() => {
                const entries = mergeTimeline(effectiveProgressLog, effectiveSubAgentStream)
                const lastTime = getLastActiveTime(effectiveProgressLog, effectiveSubAgentStream)
                return (
                    <div>
                        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1 block">
                            执行过程
                        </span>
                        <div className="space-y-0.5">
                            {entries.map((e, i) => {
                                const isLast = (e.kind === 'progress' ? e.log.timestamp : e.entry.timestamp) === lastTime
                                if (e.kind === 'progress') {
                                    return (
                                        <div key={`p-${i}`} className="flex items-start gap-2 text-[11px]">
                                            <div className="flex flex-col items-center shrink-0 pt-1">
                                                <div className={`w-2 h-2 rounded-full ${
                                                    isRunning && isLast
                                                        ? 'bg-[var(--info)] animate-pulse'
                                                        : 'bg-[var(--text-muted)]/40'
                                                }`}/>
                                                {i < entries.length - 1 && (
                                                    <div className="w-px h-3 bg-[var(--border-muted)]"/>
                                                )}
                                            </div>
                                            <span className={isRunning && isLast ? 'text-[var(--info)]' : 'text-[var(--text-secondary)]'}>
                                                {e.log.text.replace(/^子 Agent /, '')}
                                            </span>
                                        </div>
                                    )
                                }
                                return (
                                    <div key={`s-${i}`} className="ml-4">
                                        <StreamEntryCard entry={e.entry} variant="detailed" />
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )
            })()}

            {/* Result output */}
            {effectiveResult?.output && (
                <ToolCallResult
                    output={String(effectiveResult.output)}
                    toolCallName={toolCall.name}
                />
            )}

            {/* Error */}
            {effectiveResult?.error && (
                <ToolCallError error={String(effectiveResult.error)} />
            )}

            {/* Running indicator */}
            {isRunning && !effectiveResult && (
                <div className="flex items-center gap-2 text-[var(--info)] text-[11px]" role="status"
                     aria-live="polite">
                    <span className="inline-block w-1.5 h-1.5 bg-[var(--info)] rounded-full animate-bounce"
                          style={{animationDelay: '0ms'}}/>
                    <span className="inline-block w-1.5 h-1.5 bg-[var(--info)] rounded-full animate-bounce"
                          style={{animationDelay: '150ms'}}/>
                    <span className="inline-block w-1.5 h-1.5 bg-[var(--info)] rounded-full animate-bounce"
                          style={{animationDelay: '300ms'}}/>
                    <span className="ml-1">
                        {typeof effectiveProgress === 'string'
                            ? effectiveAgentProgress
                            : '正在执行...'}
                    </span>
                </div>
            )}

            {/* Token 用量（仅 agent 工具） */}
            {toolCall.name === 'agent' && effectiveTokenUsage && (
                <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-2">
                    <span>Token 消耗:</span>
                    <span>{effectiveTokenUsage.inputTokens.toLocaleString()} → {effectiveTokenUsage.outputTokens.toLocaleString()}</span>
                    <span>(总计 {effectiveTokenUsage.totalTokens.toLocaleString()})</span>
                </div>
            )}
        </div>
    )
}
