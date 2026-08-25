import CacheRateTooltip from './CacheRateTooltip'
import ToolMenu from './ToolMenu'
import ModelSelector from './ModelSelector'

/** 状态栏脉冲圆点 */
const StatusDot = ({color = 'var(--info)'}: {color?: string}) => (
    <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{backgroundColor: color}}/>
)

interface InputToolbarProps {
    isRunning: boolean
    compactInProgress: boolean
    needsSession: boolean
    needsModel: boolean
    pendingMessagesCount: number
    canSend: boolean
    /** 当前会话 ID（ModelSelector 会话级 override 读取/写入；可选以兼容未传入的调用方） */
    conversationId?: string
    /** ★ 新增：action 插槽，渲染于 input-toolbar-actions 最左侧（会话级控件注入点） */
    extraActions?: React.ReactNode
    onSubmit: () => void
    onAbort: () => void
    onUploadFile: (files: any[]) => void
    onOpenCommandPalette: () => void
}

/**
 * 底部输入工具栏 — 状态提示 / 缓存命中率 / 模型选择 / 工具菜单 / 发送 / 终止
 */
export default function InputToolbar({
    isRunning,
    compactInProgress,
    needsSession,
    needsModel,
    pendingMessagesCount,
    canSend,
    conversationId,
    extraActions,
    onSubmit,
    onAbort,
    onUploadFile,
    onOpenCommandPalette,
}: InputToolbarProps) {
    return (
        <div data-name="input-toolbar" className="flex items-center justify-between px-2 py-1 border-t border-[var(--border)]" role="status" aria-live="polite">
            <div data-name="input-toolbar-status" className="flex items-center gap-2 text-xs text-[var(--text-muted)] flex-1 min-w-0 overflow-hidden">
                {/* 模型 + 阶段状态（"模型 思考中/响应中"）已合并至消息气泡底部
                    （MessageList statusNote），运行态不再于输入栏显示文案/脉冲点 */}
                {compactInProgress ? (
                    <span className="flex items-center gap-1 text-[var(--warning)] min-w-0">
                        <StatusDot color="var(--warning)"/>
                        <span className="truncate min-w-0">正在压缩上下文以节省 token...</span>
                    </span>
                ) : needsSession ? (
                    <span className="truncate min-w-0">请先选择工作目录和会话</span>
                ) : needsModel ? (
                    <span className="truncate min-w-0">请先在右上角选择 LLM 服务商</span>
                ) : (
                    <span className="truncate min-w-0">按 Shift+Enter 换行，Enter 发送</span>
                )}
                {pendingMessagesCount > 0 && (
                    <span className="text-[var(--warning)] flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <StatusDot color="var(--warning)"/>
                        {pendingMessagesCount} 条消息待处理
                    </span>
                )}
            </div>

            {/* 操作区：min-w-0 + justify-end + overflow-hidden → 宽度不足时从左侧开始
                裁剪（模式段/缓存徽章/模型选择等次要控件先隐藏），右侧发送/停止按钮
                shrink-0 严格保留，杜绝停止按钮被裁掉的回归 */}
            <div data-name="input-toolbar-actions" className="flex items-center justify-end gap-1 min-w-0 overflow-hidden">
                <div data-name="input-toolbar-actions-variable" className="flex items-center gap-1 shrink-0">
                    {/* ★ 会话级控件插槽（安全模式/显示模式），保持原有元素顺序与样式零改动 */}
                    {extraActions && <>{extraActions}</>}
                    {/* 缓存命中率 + 窗口占用 + 平均吞吐 */}
                    <CacheRateTooltip/>

                    {/* 会话级模型选择器（auto 默认），ms-2 与徽章组形成 8px 分组间隔 */}
                    <ModelSelector conversationId={conversationId ?? ''}/>

                    {/* + 展开按钮 */}
                    <ToolMenu
                        onUploadFile={onUploadFile}
                        onOpenCommandPalette={onOpenCommandPalette}
                    />
                </div>

                {/* 发送按钮 */}
                <button
                    data-name="input-toolbar-send"
                    onClick={onSubmit}
                    disabled={!canSend}
                    className={`shrink-0 p-1 rounded-md transition-all ${
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
                        data-name="input-toolbar-abort"
                        onClick={onAbort}
                        className="shrink-0 p-1.5 rounded-md bg-red-500 text-white hover:bg-red-600 transition-all"
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
