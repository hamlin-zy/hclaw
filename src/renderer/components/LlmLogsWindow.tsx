/**
 * LLM 调用日志窗口组件
 *
 * 使用 LogsModal 显示日志列表和详情
 * 支持日志开关状态检测
 */

import {useCallback, useEffect, useState} from 'react'
import {LogsModal} from './LogsModal'
import {type LlmCallLog} from '@shared/types'

export default function LlmLogsWindow() {
    const [logs, setLogs] = useState<LlmCallLog[]>([])
    const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
    const [enabled, setEnabled] = useState(false)

    const loadLogs = useCallback(async () => {
        try {
            const result = await window.electronAPI?.getLlmCallLogs?.()
            if (result && Array.isArray(result)) {
                setLogs(result)
            }
        } catch (err) {
            // Error silently ignored
        }
    }, [])

    const clearLogs = useCallback(async () => {
        try {
            await window.electronAPI?.clearLlmCallLogs?.()
            setLogs([])
        } catch (err) {
            // Error silently ignored
        }
    }, [])

    const toggleLog = useCallback(async () => {
        try {
            const newState = !enabled
            await window.electronAPI?.toggleLlmLog?.(newState)
            setEnabled(newState)
            if (!newState) {
                setLogs([])
            }
        } catch (err) {
            // Error silently ignored
        }
    }, [enabled])

    useEffect(() => {
        // 读取开关状态
        const loadState = async () => {
            try {
                const isEnabled = await window.electronAPI?.getLlmLogEnabled?.()
                setEnabled(isEnabled ?? false)
            } catch {
                setEnabled(false)
            }
        }
        loadState()

        if (!enabled) return

        // 加载历史日志
        loadLogs()

        // 监听新日志事件
        const cleanup = window.electronAPI?.onLlmCallLog?.((log: LlmCallLog) => {
            setLogs(prev => [log, ...prev])
        })

        return () => {
            if (cleanup) cleanup()
        }
    }, [enabled, loadLogs])

    // 日志开关关闭时显示提示
    if (!enabled) {
        return (
            <div className="h-screen flex flex-col bg-[var(--surface, #ffffff)] text-[var(--text-primary, #1a1a1a)] font-['Inter',sans-serif]">
                {/* 顶部工具栏 */}
                <div
                    className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-muted, #e5e7eb)] bg-[var(--surface-muted, #f9fafb)] shrink-0">
                    <div className="flex items-center gap-3">
                        <svg className="w-4 h-4 text-[var(--text-muted, #6b7280)]" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                        <h1 className="text-sm font-medium">LLM 调用日志</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={toggleLog}
                            className="px-3 py-1 text-xs rounded border border-[var(--border-muted, #e5e7eb)] hover:bg-[var(--surface-hover, #f3f4f6)] transition-colors"
                        >
                            开启日志记录
                        </button>
                    </div>
                </div>

                {/* 空状态提示 */}
                <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted, #6b7280)]">
                    <svg className="w-16 h-16 mb-4 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.5">
                        <circle cx="12" cy="12" r="9"/>
                        <line x1="5" y1="5" x2="19" y2="19"/>
                    </svg>
                    <p className="text-sm mb-2">日志记录已关闭</p>
                    <p className="text-xs">点击上方「开启日志记录」按钮启用</p>
                </div>
            </div>
        )
    }

    return (
        <div className="h-screen flex flex-col bg-[var(--surface, #ffffff)] text-[var(--text-primary, #1a1a1a)] font-['Inter',sans-serif]">
            {/* 顶部工具栏 */}
            <div
                className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-muted, #e5e7eb)] bg-[var(--surface-muted, #f9fafb)] shrink-0">
                <div className="flex items-center gap-3">
                    <svg className="w-4 h-4 text-[var(--success, #22c55e)]" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="9"/>
                        <circle cx="12" cy="12" r="3" fill="currentColor"/>
                    </svg>
                    <h1 className="text-sm font-medium">LLM 调用日志</h1>
                    <span
                        className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--success-bg, rgba(34,197,94,0.1))] text-[var(--success, #22c55e)]">记录中</span>
                    <span className="text-xs text-[var(--text-muted, #9ca3af)]">{logs.length} 条记录</span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={loadLogs}
                        className="px-2.5 py-1 text-xs rounded border border-[var(--border-muted, #e5e7eb)] hover:bg-[var(--surface-hover, #f3f4f6)] transition-colors"
                    >
                        刷新
                    </button>
                    <button
                        onClick={toggleLog}
                        className="px-2.5 py-1 text-xs rounded border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
                    >
                        关闭
                    </button>
                    <button
                        onClick={clearLogs}
                        className="px-2.5 py-1 text-xs rounded border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
                    >
                        清空
                    </button>
                </div>
            </div>

            {/* 日志主体 - 使用 LogsModal (panel 模式) */}
            <LogsModal
                logs={logs}
                selectedLogId={selectedLogId}
                onSelectLog={setSelectedLogId}
                onClose={() => setSelectedLogId(null)}
                mode="panel"
            />
        </div>
    )
}
