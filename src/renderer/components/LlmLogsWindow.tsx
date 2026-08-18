/**
 * LLM 调用日志窗口组件
 *
 * 使用 LogsModal 显示日志列表和详情
 * 支持日志开关状态检测
 *
 * 视觉设计语言对齐用量统计窗口（src/renderer/components/usage/UsageWindow.tsx）：
 * 标题栏 + 紧凑工具栏（px-5 py-2.5 / --border 底边）、卡片式空态（rounded-lg border）、
 * 全部使用 globals.css 既有 CSS 变量与工具类，不引入新主题概念。
 */

import {useCallback, useEffect, useState} from 'react'
import {LogsModal} from './LogsModal'
import {type LlmCallLog} from '@shared/types'
import {useThemeSync} from '../lib/theme'
import WindowTitleBar from './common/WindowTitleBar'

export default function LlmLogsWindow() {
    useThemeSync()
    const [logs, setLogs] = useState<LlmCallLog[]>([])
    const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
    const [enabled, setEnabled] = useState(false)

    const loadLogs = useCallback(async () => {
        try {
            const result = await window.electronAPI?.getLlmCallLogs?.()
            if (result && Array.isArray(result)) {
                setLogs(result)
            }
        } catch {
            // Error silently ignored
        }
    }, [])

    const clearLogs = useCallback(async () => {
        try {
            await window.electronAPI?.clearLlmCallLogs?.()
            setLogs([])
        } catch {
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
        } catch {
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
            <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
                <WindowTitleBar title="LLM 调用日志"/>
                {/* 顶部工具栏 */}
                <div className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--border)] shrink-0">
                    <div className="flex items-center gap-2.5">
                        <h1 className="text-xs font-semibold text-[var(--text-primary)]">LLM 调用日志</h1>
                        <span className="text-[11px] text-[var(--text-muted)]">未开启</span>
                    </div>
                    <div className="ml-auto">
                        <button
                            onClick={toggleLog}
                            className="px-2.5 py-1 text-xs rounded-md bg-[var(--brand-primary)] text-white font-medium transition-opacity hover:opacity-90"
                        >
                            开启日志记录
                        </button>
                    </div>
                </div>

                {/* 空状态提示 */}
                <div className="flex-1 overflow-y-auto p-5">
                    <div className="rounded-lg border border-[var(--border)] py-16 flex flex-col items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                        <svg className="w-10 h-10 mb-1 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                        <div className="text-sm">日志记录已关闭</div>
                        <div className="text-xs">点击上方「开启日志记录」按钮启用</div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
            <WindowTitleBar title="LLM 调用日志"/>
            {/* 顶部工具栏 */}
            <div className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--border)] shrink-0 flex-wrap">
                <div className="flex items-center gap-3">
                    <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)] shrink-0"/>
                    <h1 className="text-xs font-semibold text-[var(--text-primary)]">LLM 调用日志</h1>
                    <span className="text-[11px] text-[var(--text-muted)] tabular-nums">{logs.length} 条记录</span>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                    <button
                        onClick={loadLogs}
                        className="px-2.5 py-1 text-xs rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        刷新
                    </button>
                    <button
                        onClick={toggleLog}
                        className="px-2.5 py-1 text-xs rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        暂停记录
                    </button>
                    <button
                        onClick={clearLogs}
                        className="px-2.5 py-1 text-xs rounded-md border border-[var(--error)] text-[var(--error)] hover:bg-[var(--error)] hover:text-white transition-colors"
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
