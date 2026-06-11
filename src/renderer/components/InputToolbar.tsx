import {type ReactNode} from 'react'
import CacheRateTooltip from './CacheRateTooltip'
import ToolMenu from './ToolMenu'

/** 状态栏脉冲圆点 */
const StatusDot = ({color = 'var(--info)'}: {color?: string}) => (
    <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{backgroundColor: color}}/>
)

interface InputToolbarProps {
    isRunning: boolean
    compactInProgress: boolean
    needsSession: boolean
    needsModel: boolean
    agentState: {currentModelProvider?: string; currentModelName?: string}
    pendingMessagesCount: number
    isPreviewMode: boolean
    canSend: boolean
    onTogglePreview: () => void
    onSubmit: () => void
    onAbort: () => void
    onUploadFile: (files: any[]) => void
    onOpenDialog: (...args: any[]) => void
    onOpenCommandPalette: () => void
}

/**
 * 底部输入工具栏 — 状态提示 / 缓存命中率 / 工具菜单 / 预览 / 发送 / 终止
 */
export default function InputToolbar({
    isRunning,
    compactInProgress,
    needsSession,
    needsModel,
    agentState,
    pendingMessagesCount,
    isPreviewMode,
    canSend,
    onTogglePreview,
    onSubmit,
    onAbort,
    onUploadFile,
    onOpenDialog,
    onOpenCommandPalette,
}: InputToolbarProps) {
    return (
        <div className="flex items-center justify-between px-2 py-1 border-t border-[var(--border)]" role="status" aria-live="polite">
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                {isRunning ? (
                    <span className="flex items-center gap-1 text-[var(--info)]">
                        <StatusDot color="var(--info)"/>
                        {agentState.currentModelProvider ? agentState.currentModelProvider.charAt(0).toUpperCase() + agentState.currentModelProvider.slice(1) : ''} {agentState.currentModelName} 运行中...
                    </span>
                ) : compactInProgress ? (
                    <span className="flex items-center gap-1 text-[var(--warning)]">
                        <StatusDot color="var(--warning)"/>
                        正在压缩上下文以节省 token...
                    </span>
                ) : needsSession ? (
                    <span>请先选择工作目录和会话</span>
                ) : needsModel ? (
                    <span>请先在右上角选择 LLM 服务商</span>
                ) : (
                    <span>按 Shift+Enter 换行，Enter 发送</span>
                )}
                {pendingMessagesCount > 0 && (
                    <span className="text-[var(--warning)] flex items-center gap-1">
                        <StatusDot color="var(--warning)"/>
                        {pendingMessagesCount} 条消息待处理
                    </span>
                )}
            </div>

            <div className="flex items-center gap-1">
                {/* 缓存命中率 */}
                <CacheRateTooltip/>

                {/* + 展开按钮 */}
                <ToolMenu
                    onUploadFile={onUploadFile}
                    onOpenDialog={onOpenDialog}
                    onOpenCommandPalette={onOpenCommandPalette}
                />

                {/* 预览按钮 */}
                <button
                    type="button"
                    onClick={onTogglePreview}
                    className={`p-1 rounded-md transition-colors ${
                        isPreviewMode
                            ? 'text-[var(--brand-primary)] bg-[var(--brand-muted)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                    }`}
                    title={isPreviewMode ? '关闭预览' : 'Markdown 预览'}
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                </button>

                {/* 发送按钮 */}
                <button
                    onClick={onSubmit}
                    disabled={!canSend}
                    className={`p-1 rounded-md transition-all ${
                        canSend
                            ? 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary)]/80'
                            : 'text-[var(--text-muted)] cursor-not-allowed'
                    }`}
                    aria-label={canSend ? '发送消息' : '无法发送'}
                    aria-disabled={!canSend}
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                </button>
                {isRunning && (
                    <button
                        onClick={onAbort}
                        className="p-1.5 rounded-md bg-red-500 text-white hover:bg-red-600 transition-all"
                        title="点击终止"
                    >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="6" y="6" width="12" height="12" rx="1"/>
                        </svg>
                    </button>
                )}
            </div>
        </div>
    )
}
