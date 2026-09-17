/**
 * ScheduleScriptLogPanel — 脚本类定时任务的执行记录面板（ui-02 组件拆分，ui-07 加固）
 *
 * 列出脚本执行产生的日志文件，支持就地展开读取内容。
 * 仅消费语义令牌（设计契约 C5），不含十六进制字面量。
 *
 * ui-07 改动：
 * - 失败**不再被吞成空数组**（原 `catch → setLogs([])` 会让「加载失败」伪装成「暂无记录」）；
 *   现在显式区分 加载中 / 失败（可读原因 + 重试）/ 空（说明文案）。
 * - 日志读取出错给出可读原因，不再只写「读取失败」四个字。
 * - 内容过大时明确告知并标注被截断（不静默截断）。
 *
 * 读取上限改由主进程裁定（`scheduler-read-script-log` 只回前 N 字节 + 文件真实总大小）：
 * 本组件消费 main 上报的 **totalSize** 判断这一屏是否完整，不再自己数收到的字符串长度
 * （那是已被截断的副本，数出来永远「读全了」）。
 */

import {useCallback, useEffect, useState} from 'react'
import {pad} from './ScheduleUtils'
import {API_UNAVAILABLE, ErrorBox, PanelShell, type Loadable} from './schedulePanelShell'

/** 脚本日志文件记录 */
interface ScriptLogEntry {
    path: string
    fileName: string
    startTime: number
    size: number
}

/** 单次日志正文的渲染上限（字符）。超过即截断并明确标注，见下方 truncation 提示。 */
const CONTENT_LIMIT = 200_000

/**
 * `readScriptLog` 的返回体：`content` 已被主进程按读取上限截断，
 * `totalSize` 是文件真实字节数 —— 这是判断「这一屏是否完整」的**唯一**依据。
 * 渲染层不再自己数收到的字符串长度：那只会量到已被截断的副本，永远推出「读全了」。
 */
interface ScriptLogContent {
    content: string
    totalSize: number
}

// formatSize 的口径：<1K 记 B，<1M 记 KB，其余记 MB。此处对**字符数**沿用同一口径
// （日志正文按字符近似长度），目的是让「仅显示前 X，共 Y」两个量级可读、可比。
const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export default function ScheduleScriptLogPanel({scheduleId}: { scheduleId: string }) {
    const [logs, setLogs] = useState<Loadable<ScriptLogEntry[]>>({status: 'loading'})
    const [reloadKey, setReloadKey] = useState(0)
    const [expandedLog, setExpandedLog] = useState<string | null>(null)
    const [content, setContent] = useState<Loadable<ScriptLogContent> | null>(null)
    const [contentReloadKey, setContentReloadKey] = useState(0)

    useEffect(() => {
        let cancelled = false

        const fetchLogs = async () => {
            setLogs({status: 'loading'})
            try {
                const api = window.electronAPI?.scheduler
                if (!api?.scriptLogs) {
                    if (!cancelled) setLogs({status: 'error', error: API_UNAVAILABLE})
                    return
                }
                const res = await api.scriptLogs(scheduleId)
                if (cancelled) return
                if (!res) setLogs({status: 'error', error: API_UNAVAILABLE})
                else if (!res.ok) setLogs({status: 'error', error: res.error || '脚本执行记录加载失败'})
                else setLogs({status: 'ready', data: res.data || []})
            } catch (err: unknown) {
                // 失败留下可读原因，绝不回退成 `setLogs([])` 的空态伪装
                if (!cancelled) setLogs({status: 'error', error: err instanceof Error ? err.message : String(err)})
            }
        }

        void fetchLogs()
        return () => { cancelled = true }
    }, [scheduleId, reloadKey])

    const loadContent = useCallback(async (logPath: string) => {
        setContent({status: 'loading'})
        try {
            const api = window.electronAPI?.scheduler
            if (!api?.readScriptLog) {
                setContent({status: 'error', error: API_UNAVAILABLE})
                return
            }
            const res = await api.readScriptLog(logPath)
            if (!res) setContent({status: 'error', error: API_UNAVAILABLE})
            else if (!res.ok) setContent({status: 'error', error: res.error || '日志读取失败'})
            else setContent({status: 'ready', data: res.data ?? {content: '', totalSize: 0}})
        } catch (err: unknown) {
            setContent({status: 'error', error: err instanceof Error ? err.message : String(err)})
        }
    }, [])

    useEffect(() => {
        if (!expandedLog) { setContent(null); return }
        void loadContent(expandedLog)
    }, [expandedLog, contentReloadKey, loadContent])

    const handleView = (logPath: string) => {
        setExpandedLog(prev => (prev === logPath ? null : logPath))
    }

    // 与 ScheduleConversationsPanel 的 PanelShell 同构：行内面板取面板档圆角
    // （契约 D5：面板与浮层 ≥12px，4–6px 只留给徽标与输入控件）。
    // 注：本注释刻意不用反引号包 Tailwind 工具类名——注释/文档漂移守卫会把反引号里
    //     的 kebab 串当成 IPC 通道名，要求它作为字符串字面量出现在源码里。
    return (
        <PanelShell title="脚本执行记录">
            {logs.status === 'loading' && (
                <div className="p-4 text-center">
                    <div className="inline-block w-4 h-4 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">加载执行记录...</div>
                </div>
            )}

            {logs.status === 'error' && (
                <ErrorBox message={logs.error}
                          onRetry={() => setReloadKey(k => k + 1)}
                          retryName="schedule-dialog-script-logs-retry-button"
                          retryLabel="重新加载脚本执行记录"/>
            )}

            {logs.status === 'ready' && logs.data.length === 0 && (
                <div className="p-4 text-center">
                    <div className="text-xs text-[var(--text-secondary)]">暂无脚本执行记录</div>
                </div>
            )}

            {logs.status === 'ready' && logs.data.length > 0 && (
                <div className="divide-y divide-[var(--border-muted)]">
                    {logs.data.map((log, idx) => {
                        const d = new Date(log.startTime)
                        const timeStr = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
                        const isExpanded = expandedLog === log.path
                        const loaded = content?.status === 'ready' ? content.data : null
                        const full = loaded?.content ?? ''
                        // 不完整有两个来源，两者都要提示：
                        // ① 主进程按读取上限截断（收到的字节数小于文件真实总大小）；
                        // ② 本组件自己的显示上限（CONTENT_LIMIT）。「共 Y」的量取自 main 上报的
                        //    文件真实大小，渲染层不再自己数（它数出来的只是已被截断的副本）。
                        const truncated = loaded !== null
                            && (loaded.totalSize > new TextEncoder().encode(full).length || full.length > CONTENT_LIMIT)
                        const totalSize = loaded?.totalSize ?? 0
                        const shown = full.length > CONTENT_LIMIT ? full.slice(0, CONTENT_LIMIT) : full

                        return (
                            <div key={log.path}>
                                <div className="px-3 py-2 flex items-center gap-3">
                                    {/* 序号 */}
                                    <span className="text-2xs text-[var(--text-muted)] font-mono w-5 shrink-0">
                                        {logs.data.length - idx}
                                    </span>

                                    {/* 时间 */}
                                    <span className="text-2xs text-[var(--text-muted)] font-mono shrink-0">
                                        {timeStr}
                                    </span>

                                    {/* 文件大小 */}
                                    <span className="text-2xs text-[var(--text-secondary)]">
                                        {formatSize(log.size)}
                                    </span>

                                    <div className="flex-1"/>

                                    {/* 查看/收起按钮 */}
                                    <button
                                        type="button"
                                        onClick={() => handleView(log.path)}
                                        aria-expanded={isExpanded}
                                        aria-label={isExpanded ? '收起这次执行的日志' : '查看这次执行的日志全文'}
                                        className={`text-xs px-2 py-0.5 rounded transition-colors ${
                                            isExpanded
                                                ? 'bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--text-primary)]'
                                                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                        }`}
                                        data-name="schedule-dialog-toggle-runs-button">
                                        {isExpanded ? '收起' : '查看'}
                                    </button>
                                </div>

                                {/* 展开的日志内容 */}
                                {isExpanded && (
                                    <div className="px-3 pb-2">
                                        {content?.status === 'loading' && (
                                            <div className="text-xs text-[var(--text-secondary)] py-2">加载日志全文...</div>
                                        )}
                                        {content?.status === 'error' && (
                                            <ErrorBox message={content.error}
                                                      onRetry={() => setContentReloadKey(k => k + 1)}
                                                      retryName="schedule-dialog-script-log-retry-button"
                                                      retryLabel="重新加载脚本执行记录"/>
                                        )}
                                        {content?.status === 'ready' && (
                                            <>
                                                <pre className="text-xs text-[var(--text-primary)] font-mono bg-[var(--surface-muted)] rounded p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
                                                    {shown || '（日志为空）'}
                                                </pre>
                                                {truncated && (
                                                    <div className="mt-1 text-xs text-[var(--text-secondary)]"
                                                         data-name="schedule-dialog-log-truncated-notice">
                                                        内容过大，仅显示前 {formatSize(shown.length)}，共 {formatSize(totalSize)}。
                                                        完整的日志请打开文件查看。
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </PanelShell>
    )
}
