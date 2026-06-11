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
                <div
                    className="w-60 flex-shrink-0 flex flex-col border-r"
                    style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-muted)' }}
                >
                    <div
                        className="p-4 border-b flex items-center gap-2 font-medium"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                    >
                        <Activity className="w-5 h-5" style={{ color: 'var(--brand-primary)' }} />
                        日志列表
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                        {logs.map(log => (
                            <button
                                key={log.id}
                                onClick={() => onSelectLog(log.id)}
                                className={cn(
                                    "w-full text-left p-3 rounded-xl border transition-all flex flex-col gap-2",
                                    selectedLogId === log.id ? "shadow-sm" : "hover:border-[var(--border-emphasis)]"
                                )}
                                style={{
                                    backgroundColor: selectedLogId === log.id ? 'var(--surface)' : 'var(--surface)',
                                    borderColor: selectedLogId === log.id ? 'var(--brand-primary)' : 'var(--border)'
                                }}
                            >
                                <div className="text-xs flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
                                    <span>{formatTimeShort(log.timestamp)}</span>
                                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--surface-muted)', color: 'var(--text-secondary)' }}>
                                        {log.id.slice(0, 12)}...
                                    </span>
                                </div>
                                <div className="text-sm font-medium line-clamp-2" style={{ color: 'var(--text-primary)' }}>
                                    {truncate(log.inputContent, 60) || '无内容'}
                                </div>
                                <div className="flex items-center gap-3 text-xs font-mono mt-1" style={{ color: 'var(--text-muted)' }}>
                                    <div className="flex items-center gap-1" title="Input Tokens">
                                        <ArrowRight className="w-3 h-3" style={{ color: 'var(--success)' }} />
                                        {log.inputTokens}
                                    </div>
                                    <div className="flex items-center gap-1" title="Output Tokens">
                                        <ArrowRight className="w-3 h-3 rotate-180" style={{ color: 'var(--brand-primary)' }} />
                                        {log.outputTokens}
                                    </div>
                                </div>
                            </button>
                        ))}
                        {logs.length === 0 && (
                            <div className="text-center text-sm py-8" style={{ color: 'var(--text-muted)' }}>
                                暂无日志
                            </div>
                        )}
                    </div>
                </div>

                {/* Right Panel: Log Details */}
                <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--surface)' }}>
                    {selectedLog ? (
                        <>
                            <div className="p-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: 'var(--border)' }}>
                                <div className="flex items-center gap-3">
                                    <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>请求详情</h2>
                                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatDateTime(selectedLog.timestamp)}</span>
                                </div>
                                <div className="flex items-center gap-4 text-sm font-mono px-3 py-1.5 rounded-lg border" style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                                    <div className="flex items-center gap-1.5">
                                        <span style={{ color: 'var(--text-muted)' }}>IN:</span>
                                        <span className="font-semibold" style={{ color: 'var(--success)' }}>{selectedLog.inputTokens}</span>
                                    </div>
                                    <div className="w-px h-4" style={{ backgroundColor: 'var(--border)' }} />
                                    <div className="flex items-center gap-1.5">
                                        <span style={{ color: 'var(--text-muted)' }}>OUT:</span>
                                        <span className="font-semibold" style={{ color: 'var(--brand-primary)' }}>{selectedLog.outputTokens}</span>
                                    </div>
                                    <div className="w-px h-4" style={{ backgroundColor: 'var(--border)' }} />
                                    <div className="flex items-center gap-1.5">
                                        <span style={{ color: 'var(--text-muted)' }}>TOTAL:</span>
                                        <span className="font-semibold">{selectedLog.inputTokens + selectedLog.outputTokens}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-6 space-y-8">
                                {selectedLog.systemPrompt && (
                                    <div className="space-y-2">
                                        <button onClick={() => setSystemPromptExpanded(!systemPromptExpanded)} className="flex items-center gap-2 text-sm font-semibold w-full text-left" style={{ color: 'var(--text-primary)' }}>
                                            {systemPromptExpanded ? <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} /> : <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
                                            <TerminalSquare className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                                            System Prompt
                                        </button>
                                        {systemPromptExpanded && (
                                            <div className="p-4 rounded-xl border text-sm font-mono leading-relaxed overflow-auto" style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text-secondary)', maxHeight: '200px' }}>
                                                {selectedLog.systemPrompt}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                                        <Database className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                                        历史上下文 (Context)
                                    </div>

                                    <div className="space-y-4 relative">
                                        <div className="absolute inset-0 ml-5 -translate-x-px w-0.5 bg-gradient-to-b" style={{ backgroundColor: 'var(--border)' }} />

                                        {logBlocks.map((block, idx) => {
                                            const isCollapsed = collapsedTools.has(idx)
                                            const isToggleable = block.type === 'tool_call' || block.type === 'tool_result'

                                            return (
                                            <div key={idx} className="relative flex items-start justify-between group">
                                                <div
                                                    className="flex items-center justify-center w-10 h-10 rounded-full border-4 shrink-0 z-10"
                                                    style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--surface)', color: 'var(--text-muted)' }}
                                                >
                                                    {block.role === 'user' && <User className="w-4 h-4" style={{ color: 'var(--brand-primary)' }} />}
                                                    {block.role === 'model' && block.type === 'text' && <Bot className="w-4 h-4" style={{ color: 'var(--success)' }} />}
                                                    {block.role === 'model' && block.type === 'thinking' && <BrainCircuit className="w-4 h-4" style={{ color: '#a855f7' }} />}
                                                    {block.role === 'model' && block.type === 'tool_call' && <Wrench className="w-4 h-4" style={{ color: '#f59e0b' }} />}
                                                    {block.role === 'tool' && <FileCode className="w-4 h-4" style={{ color: '#3b82f6' }} />}
                                                </div>

                                                <div
                                                    className="w-[calc(100%-3rem)] ml-4 p-4 rounded-2xl border shadow-sm"
                                                    style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}
                                                >
                                                    <div className="flex items-center gap-2 mb-2 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
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
                                                                    className="flex items-center gap-1 text-xs mb-2 hover:opacity-70"
                                                                    style={{ color: 'var(--text-muted)' }}
                                                                >
                                                                    {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                                    {isCollapsed ? '展开' : '折叠'}
                                                                </button>
                                                            )}
                                                            {!isCollapsed && (
                                                                <div className="rounded-lg p-3 overflow-x-auto border" style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)' }}>
                                                                    <pre className="text-xs font-mono m-0" style={{ color: 'var(--text-secondary)' }}>
                                                                        {block.content}
                                                                    </pre>
                                                                </div>
                                                            )}
                                                        </div>
                                                    ) : block.type === 'thinking' ? (
                                                        <div className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
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
