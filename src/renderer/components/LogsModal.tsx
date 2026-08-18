/**
 * LogsModal - LLM 调用日志面板
 *
 * 支持两种模式：
 * - modal: 全屏居中弹窗，带 backdrop
 * - panel: 直接填充父容器，无 backdrop
 */

import { useState, useEffect } from 'react'
import { Activity, ArrowRight, Bot, BrainCircuit, ChevronDown, ChevronRight, Database, FileCode, TerminalSquare, User, Wrench, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { clsx, type ClassValue } from 'clsx'
import {formatTokenCompact} from '../lib/format'
import {type LlmCallLog} from '@shared/types'

function cn(...inputs: ClassValue[]) {
    return clsx(inputs)
}

interface LogBlock {
    role: 'user' | 'model' | 'tool'
    type: 'text' | 'thinking' | 'tool_call' | 'tool_result'
    content: string
    toolName?: string
}

interface LogsModalProps {
    logs: LlmCallLog[]
    selectedLogId: string | null
    onSelectLog: (id: string) => void
    onClose: () => void
    mode?: 'modal' | 'panel'
}

/**
 * 将 messages 数组转换为 LogBlock[] 用于 timeline 展示
 */
function transformToLogBlocks(messages: LlmCallLog['messages']): LogBlock[] {
    if (!messages || messages.length === 0) {
        return []
    }

    const blocks: LogBlock[] = []
    const toolCallIdToName = new Map<string, string>()

    // 第一次遍历：收集所有 tool_call 的 id → name 映射
    for (const msg of messages) {
        if (msg.role === 'model' && msg.toolCalls) {
            for (const tc of msg.toolCalls) {
                toolCallIdToName.set(tc.id, tc.name)
            }
        }
    }

    // 第二次遍历：构建 blocks（倒序，最新的在前面）
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]

        if (msg.role === 'user') {
            blocks.push({ role: 'user', type: 'text', content: msg.content })
            continue
        }

        if (msg.role === 'tool') {
            // 通过 toolCallId 查找工具名
            const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined
            blocks.push({
                role: 'tool',
                type: 'tool_result',
                content: msg.toolResult || msg.content,
                toolName
            })
            continue
        }

        if (msg.role === 'model' || msg.role === 'assistant') {
            // 先处理 toolCalls（倒序，所以先处理后面的）
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                for (let j = msg.toolCalls.length - 1; j >= 0; j--) {
                    const tc = msg.toolCalls[j]
                    blocks.push({
                        role: 'model',
                        type: 'tool_call',
                        content: JSON.stringify(tc.arguments, null, 2),
                        toolName: tc.name
                    })
                }
            }

            // 即使 content 为空也要显示（可能有 toolCalls）
            if (msg.content && msg.content.trim().length > 0) {
                blocks.push({
                    role: 'model',
                    type: 'text',
                    content: msg.content
                })
            }
        }
    }

    return blocks
}

function formatTimeShort(ts: number): string {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function formatDateTime(ts: number): string {
    const d = new Date(ts)
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function truncate(text: string, maxLength: number): string {
    if (!text) return ''
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength) + '...'
}

export function LogsModal({ logs, selectedLogId, onSelectLog, onClose, mode = 'modal' }: LogsModalProps) {
    const [systemPromptExpanded, setSystemPromptExpanded] = useState(false)
    const [collapsedTools, setCollapsedTools] = useState<Set<number>>(new Set())

    const selectedLog = logs.find(log => log.id === selectedLogId) || null
    const logBlocks = selectedLog?.messages ? transformToLogBlocks(selectedLog.messages) : []

    // 工具调用默认折叠 - 每次选择新日志时重置
    useEffect(() => {
        const toolIndices = new Set<number>()
        logBlocks.forEach((block, idx) => {
            if (block.type === 'tool_call' || block.type === 'tool_result') {
                toolIndices.add(idx)
            }
        })
        setCollapsedTools(toolIndices)
    }, [selectedLogId])

    const toggleToolCollapsed = (idx: number) => {
        setCollapsedTools(prev => {
            const next = new Set(prev)
            if (next.has(idx)) {
                next.delete(idx)
            } else {
                next.add(idx)
            }
            return next
        })
    }

    const isPanel = mode === 'panel'

    return (
        <div className={isPanel ? "flex flex-1 overflow-hidden min-h-0" : "fixed inset-0 z-50 flex items-center justify-center"}>
            {!isPanel && (
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            )}

            {!isPanel && (
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 z-10 p-2 rounded-full transition-colors hover:bg-[var(--surface-muted)]"
                    style={{ color: 'var(--text-muted)' }}
                >
                    <X className="w-5 h-5" />
                </button>
            )}

            <div
                className={isPanel ? "flex flex-1 overflow-hidden" : "relative w-full max-w-6xl h-full max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex border border-[var(--border)]"}
                style={{ backgroundColor: 'var(--surface)' }}
                onClick={isPanel ? undefined : e => e.stopPropagation()}
            >
                {/* Left Panel: Log List */}
                <div className="w-64 flex-shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--surface-muted)]">
                    <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--border)]">
                        <div className="flex items-center gap-2">
                            <Activity className="w-3.5 h-3.5" style={{ color: 'var(--brand-primary)' }} />
                            <span className="text-xs font-semibold text-[var(--text-primary)]">日志列表</span>
                        </div>
                        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">{logs.length} 条</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {logs.map(log => (
                            <button
                                key={log.id}
                                onClick={() => onSelectLog(log.id)}
                                className={cn(
                                    "w-full text-left px-3 py-2.5 rounded-md border transition-colors flex flex-col gap-1.5",
                                    selectedLogId === log.id
                                        ? "border-[var(--brand-primary)] bg-[var(--surface)]"
                                        : "border-transparent hover:bg-[var(--surface-overlay)]"
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                                        {truncate(log.inputContent, 60) || '无内容'}
                                    </span>
                                    <span className="text-[10px] text-[var(--text-muted)] shrink-0 tabular-nums">{formatTimeShort(log.timestamp)}</span>
                                </div>
                                <div className="flex items-center gap-2.5 text-[10px] font-mono tabular-nums text-[var(--text-muted)]">
                                    <span className="truncate text-[var(--text-secondary)]">{log.model}</span>
                                    <span className="shrink-0 flex items-center gap-1" title="Input Tokens">
                                        <ArrowRight className="w-2.5 h-2.5" style={{ color: 'var(--success)' }} />
                                        <span className="text-[var(--success)]">{formatTokenCompact(log.inputTokens)}</span>
                                    </span>
                                    <span className="shrink-0 flex items-center gap-1" title="Output Tokens">
                                        <ArrowRight className="w-2.5 h-2.5 rotate-180" style={{ color: 'var(--brand-primary)' }} />
                                        <span className="text-[var(--brand-primary)]">{formatTokenCompact(log.outputTokens)}</span>
                                    </span>
                                </div>
                            </button>
                        ))}
                        {logs.length === 0 && (
                            <div className="text-center text-sm py-10 text-[var(--text-muted)]">暂无日志</div>
                        )}
                    </div>
                </div>

                {/* Right Panel: Log Details */}
                <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--surface)' }}>
                    {selectedLog ? (
                        <>
                            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)] shrink-0">
                                <div className="flex items-center gap-3 min-w-0">
                                    <h2 className="text-xs font-semibold text-[var(--text-primary)] shrink-0">请求详情</h2>
                                    <span className="text-[11px] text-[var(--text-muted)] truncate">{formatDateTime(selectedLog.timestamp)} · {selectedLog.model}</span>
                                </div>
                                <div className="flex items-center gap-3 text-xs font-mono tabular-nums px-3 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] shrink-0">
                                    <div className="flex items-center gap-1.5">
                                        <span style={{ color: 'var(--text-muted)' }}>IN:</span>
                                        <span className="font-semibold text-[var(--success)]">{formatTokenCompact(selectedLog.inputTokens)}</span>
                                    </div>
                                    <div className="w-px h-3.5" style={{ backgroundColor: 'var(--border)' }} />
                                    <div className="flex items-center gap-1.5">
                                        <span style={{ color: 'var(--text-muted)' }}>OUT:</span>
                                        <span className="font-semibold text-[var(--brand-primary)]">{formatTokenCompact(selectedLog.outputTokens)}</span>
                                    </div>
                                    <div className="w-px h-3.5" style={{ backgroundColor: 'var(--border)' }} />
                                    <div className="flex items-center gap-1.5">
                                        <span style={{ color: 'var(--text-muted)' }}>TOTAL:</span>
                                        <span className="font-semibold">{formatTokenCompact(selectedLog.inputTokens + selectedLog.outputTokens)}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-5 space-y-6">
                                {selectedLog.systemPrompt && (
                                    <div className="space-y-2">
                                        <button onClick={() => setSystemPromptExpanded(!systemPromptExpanded)} className="flex items-center gap-2 text-xs font-semibold w-full text-left" style={{ color: 'var(--text-primary)' }}>
                                            {systemPromptExpanded ? <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} /> : <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />}
                                            <TerminalSquare className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                                            System Prompt
                                        </button>
                                        {systemPromptExpanded && (
                                            <div className="p-3 rounded-lg border text-xs font-mono leading-relaxed overflow-auto" style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text-secondary)', maxHeight: '200px' }}>
                                                {selectedLog.systemPrompt}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                                        <Database className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                                        历史上下文 (Context)
                                    </div>

                                    <div className="space-y-3 relative">
                                        <div className="absolute inset-0 ml-4 -translate-x-px w-px" style={{ backgroundColor: 'var(--border)' }} />

                                        {logBlocks.map((block, idx) => {
                                            const isCollapsed = collapsedTools.has(idx)
                                            const isToggleable = block.type === 'tool_call' || block.type === 'tool_result'

                                            return (
                                            <div key={idx} className="relative flex items-start gap-3 group">
                                                <div
                                                    className="flex items-center justify-center w-8 h-8 rounded-full border shrink-0 z-10"
                                                    style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                                                >
                                                    {block.role === 'user' && <User className="w-3.5 h-3.5" style={{ color: 'var(--brand-primary)' }} />}
                                                    {block.role === 'model' && block.type === 'text' && <Bot className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} />}
                                                    {block.role === 'model' && block.type === 'thinking' && <BrainCircuit className="w-3.5 h-3.5" style={{ color: '#a855f7' }} />}
                                                    {block.role === 'model' && block.type === 'tool_call' && <Wrench className="w-3.5 h-3.5" style={{ color: '#f59e0b' }} />}
                                                    {block.role === 'tool' && <FileCode className="w-3.5 h-3.5" style={{ color: '#3b82f6' }} />}
                                                </div>

                                                <div
                                                    className="flex-1 min-w-0 px-3 py-2.5 rounded-lg border"
                                                    style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                                                >
                                                    <div className="flex items-center gap-2 mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                                                        {block.role === 'user' && 'User Message'}
                                                        {block.role === 'model' && block.type === 'text' && 'Model Response'}
                                                        {block.role === 'model' && block.type === 'thinking' && 'Model Thinking'}
                                                        {block.role === 'model' && block.type === 'tool_call' && `Tool Call: ${block.toolName || 'unknown'}`}
                                                        {block.role === 'tool' && `Tool Result: ${block.toolName || 'unknown'}`}
                                                    </div>

                                                    {block.type === 'tool_call' || block.type === 'tool_result' ? (
                                                        <div>
                                                            {isToggleable && (
                                                                <button
                                                                    onClick={() => toggleToolCollapsed(idx)}
                                                                    className="flex items-center gap-1 text-[10px] mb-1.5 hover:opacity-70"
                                                                    style={{ color: 'var(--text-muted)' }}
                                                                >
                                                                    {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                                    {isCollapsed ? '展开' : '折叠'}
                                                                </button>
                                                            )}
                                                            {!isCollapsed && (
                                                                <div className="rounded-md p-2.5 overflow-x-auto border" style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)' }}>
                                                                    <pre className="text-xs font-mono m-0" style={{ color: 'var(--text-secondary)' }}>
                                                                        {block.content}
                                                                    </pre>
                                                                </div>
                                                            )}
                                                        </div>
                                                    ) : block.type === 'thinking' ? (
                                                        <div className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
                                                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{block.content}</ReactMarkdown>
                                                        </div>
                                                    ) : (
                                                        <div className="prose prose-sm max-w-none">
                                                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{block.content}</ReactMarkdown>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            )
                                        })}

                                        {logBlocks.length === 0 && (
                                            <div className="text-center text-sm py-4" style={{ color: 'var(--text-muted)' }}>
                                                暂无上下文数据
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                            选择左侧日志查看详情
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export { type LogBlock }
export default LogsModal
