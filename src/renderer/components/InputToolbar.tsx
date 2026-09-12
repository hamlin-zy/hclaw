import {useLayoutEffect, useRef, useState} from 'react'
import CacheRateTooltip from './CacheRateTooltip'
import ToolMenu from './ToolMenu'
import ModelSelector from './ModelSelector'
import ThinkingEffortSelector from './ThinkingEffortSelector'
import {ModeSpaceContext} from './ConvModeSegs'

/** 状态栏脉冲圆点 */
const StatusDot = ({color = 'var(--info)'}: {color?: string}) => (
    <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{backgroundColor: color}}/>
)

interface InputToolbarProps {
    isRunning: boolean
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
 * 模式组判断时扣除的固定间隙（toolbar padding + 各控件间 gap + 状态/操作区间隙等）。
 * 保守取值；偏大 → availWidth 偏小 → 更倾向折叠，避免误判展开。
 */
const MODE_GAP_ALLOWANCE = 28

/**
 * 状态区可保留的最大宽度（px）。
 * 状态文案（"按 Shift+Enter 换行，Enter 发送" 约 190px）只是操作提示，空间不足时
 * 允许被省略号截断，把宽度让给会话级模式控件（安全模式/显示模式）——模式控件是功能
 * 入口，优先级高于提示文案。超出该值的部分视为"可让渡空间"，计入模式组的宽度预算。
 * 取值依据：≈ 提示文案前半句（"按 Shift+Enter 换…"）仍可读的宽度。
 */
const STATUS_MAX_RESERVE = 96

/**
 * 模式组"可用宽度"（px）的纯计算。抽成纯函数便于单测：jsdom 无布局引擎，
 * clientWidth/scrollWidth 恒为 0，只有纯函数才能在测试里断言真实窗口场景。
 *
 * 语义：窗口可用宽 − 固定内容宽 − 状态文案保留宽 − 间隙预算。
 * 状态文案宽按 STATUS_MAX_RESERVE 封顶（超出部分让渡给模式组）。
 * 结果下限 0（不可为负）。
 */
export function computeModeAvailWidth({
    toolbarW,
    statusTextW,
    restW,
    sendW,
}: {
    toolbarW: number
    statusTextW: number
    restW: number
    sendW: number
}): number {
    const statusW = Math.min(statusTextW, STATUS_MAX_RESERVE)
    return Math.max(toolbarW - statusW - restW - sendW - MODE_GAP_ALLOWANCE, 0)
}

export default function InputToolbar({
    isRunning,
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
    // ── 模式区可见宽度测量 ─────────────────────────────────────────────
    // 模式组（安全/显示）位于 action 区最左侧（justify-end），宽度不足时最先被裁。
    // ★ 必须用"窗口绝对可用空间"而非 action 容器宽度：action 容器是 flex item
    //   （flex-basis:auto），只收缩包裹内容、无多余空间；窗口拉宽时多余宽度被左侧
    //   status（flex-1）吃满。因此若以 action.clientWidth 为基准，在内容无溢出时
    //   会退化为"模式组当前宽度"，模式隐藏（宽=0）时恒为 0 → 拉宽也无法恢复。
    //   正确信号 = toolbar.clientWidth（窗口可用宽）。固定内容宽度用"内容自然宽"：
    //   - status 文案为 flex-1 内的可截断文本，取 scrollWidth（完整文本宽，不受截断影响），
    //     再按 STATUS_MAX_RESERVE 封顶：封顶以外的空间让渡给模式组；
    //   - rest（缓存/模型/思考/菜单）shrink-0，offsetWidth 即内容宽；
    //   - 发送/终止按钮 shrink-0，offsetWidth 即内容宽。
    //   故 availWidth = toolbar 宽 − min(status文案宽, STATUS_MAX_RESERVE) − rest宽 − 发送宽 − 间隙。
    //   该值只随窗口宽度变化，与模式组自身渲染形态无关 → 无振荡，拉宽能正确恢复。
    const toolbarRef = useRef<HTMLDivElement>(null)
    const statusTextRef = useRef<HTMLSpanElement>(null)
    const restRef = useRef<HTMLDivElement>(null)
    const sendRef = useRef<HTMLDivElement>(null)
    const [availWidth, setAvailWidth] = useState<number | null>(null)
    useLayoutEffect(() => {
        const toolbar = toolbarRef.current
        const statusText = statusTextRef.current
        const rest = restRef.current
        const send = sendRef.current
        if (!toolbar || !statusText || !rest || !send) return
        const measure = () => {
            // 状态文案自然宽用 scrollWidth：文案被省略号截断后它仍返回完整文本宽，
            // 避免"测量值随截断变化 → 预算变化"的反馈回路。超出 STATUS_MAX_RESERVE
            // 的部分不让渡给模式组（详见 computeModeAvailWidth）。
            setAvailWidth(computeModeAvailWidth({
                toolbarW: toolbar.clientWidth,
                statusTextW: statusText.scrollWidth,
                restW: rest.offsetWidth,
                sendW: send.offsetWidth,
            }))
        }
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(toolbar)
        ro.observe(rest)
        ro.observe(send)
        return () => ro.disconnect()
    }, [])

    return (
        <div ref={toolbarRef} data-name="input-toolbar" className="flex items-center justify-between px-2 py-1 border-t border-[var(--border)]" role="status" aria-live="polite">
            {/* 状态区：flex-1 吃满剩余；文案 span 自身可收缩（min-w-0），挤不下时用省略号截断 */}
            <div data-name="input-toolbar-status" className="flex items-center gap-2 text-xs text-[var(--text-muted)] flex-1 min-w-0 overflow-hidden">
                <span className="inline-flex items-center gap-2 whitespace-nowrap min-w-0">
                {/* 模型 + 阶段状态（"模型 思考中/响应中"）已合并至消息气泡底部
                    （MessageList statusNote），运行态不再于输入栏显示文案/脉冲点 */}
                {/* 文案为可截断项：父级 min-w-0 + 自身 truncate/min-w-0 → 空间不足时省略号截断，
                    把宽度让给模式控件（见 STATUS_MAX_RESERVE）；scrollWidth 仍返回完整文本宽供测量 */}
                <span ref={statusTextRef} className="truncate min-w-0">
                    {needsSession ? '请先选择工作目录和会话'
                        : needsModel ? '请先在右上角选择 LLM 服务商'
                        : '按 Shift+Enter 换行，Enter 发送'}
                </span>
                {pendingMessagesCount > 0 && (
                    <span className="text-[var(--warning)] flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <StatusDot color="var(--warning)"/>
                        {pendingMessagesCount} 条消息待处理
                    </span>
                )}
                </span>
            </div>

            {/* 操作区：min-w-0 + justify-end + overflow-hidden → 宽度不足时从左侧开始
                裁剪（模式段/缓存徽章/模型选择等次要控件先隐藏），右侧发送/停止按钮
                shrink-0 严格保留，杜绝停止按钮被裁掉的回归 */}
            <div data-name="input-toolbar-actions" className="flex items-center justify-end gap-1 min-w-0 overflow-hidden">
                <ModeSpaceContext.Provider value={availWidth}>
                <div data-name="input-toolbar-actions-variable" className="flex items-center gap-1 shrink-0">
                    {/* ★ 会话级控件插槽（安全模式/显示模式），保持原有元素顺序与样式零改动 */}
                    {extraActions && <>{extraActions}</>}

                    {/* 右侧固定内容：独立包裹以便测量其占宽（不随模式折叠变化） */}
                    <div ref={restRef} data-name="input-toolbar-actions-rest" className="flex items-center gap-1 shrink-0">
                        {/* 缓存命中率 + 窗口占用 + 平均吞吐 */}
                        <CacheRateTooltip/>

                        {/* 会话级模型选择器（auto 默认），ms-2 与徽章组形成 8px 分组间隔 */}
                        <ModelSelector conversationId={conversationId ?? ''}/>

                        {/* 会话级思考强度选择器（档位按当前模型协议动态渲染） */}
                        <ThinkingEffortSelector conversationId={conversationId ?? ''}/>

                        {/* + 展开按钮 */}
                        <ToolMenu
                            onUploadFile={onUploadFile}
                            onOpenCommandPalette={onOpenCommandPalette}
                        />
                    </div>
                </div>

                {/* 发送/终止按钮组：独立包裹以便测量占宽（shrink-0，内容宽稳定） */}
                <div ref={sendRef} data-name="input-toolbar-send-group" className="flex items-center gap-1 shrink-0">
                    <button
                        data-name="input-toolbar-send"
                        onClick={onSubmit}
                        disabled={!canSend}
                        title={canSend ? '发送 (Enter)' : undefined}
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
                </ModeSpaceContext.Provider>
            </div>
        </div>
    )
}
