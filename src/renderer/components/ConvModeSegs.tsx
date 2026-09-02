import {createContext, useContext, useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import type {RunMode} from '@shared/types'
import type {DisplayMode} from '../lib/displayMode'

/**
 * 模式区可见宽度 context。
 * InputToolbar 通过 ResizeObserver 监听 action 容器、测量右侧固定内容占宽并下传；
 * ConvModeSegs 据此判断"安全/显示模式"分组是否被挤压，决定折叠/隐藏等级。
 * 未测量（null）时视为空间充足，回退为完整展开（旧行为）。
 */
export const ModeSpaceContext = createContext<number | null>(null)

const PERM_MODES: Array<{id: RunMode; label: string}> = [
    {id: 'auto', label: '自动'},
    {id: 'safe', label: '安全'},
]

const DISP_MODES: Array<{id: DisplayMode; label: string}> = [
    {id: 'detailed', label: '详细'},
    {id: 'compact', label: '简洁'},
    {id: 'ultra-compact', label: '极简'},
]

const permTitle = (id: RunMode) => (id === 'auto' ? '自动模式：全程自动执行' : '安全模式：破坏性操作需确认')
const DISP_TITLES: Record<DisplayMode, string> = {
    detailed: '详细模式',
    compact: '简洁模式：思考块折叠',
    'ultra-compact': '极简模式：工具汇总行',
}
const dispTitle = (id: DisplayMode) => DISP_TITLES[id]

/**
 * 折叠态：只显示当前选中项的单选胶囊，hover 时向上弹出该组其余选项。
 * 弹层通过 createPortal 渲染到 document.body，突破 input-toolbar-actions 的
 * overflow: hidden 裁剪（向上弹出会越出容器上边界，必须脱离容器）。
 *
 * hover 交互：胶囊与弹层之间用"延迟隐藏"衔接——鼠标离开胶囊后延时关闭，
 * 期间鼠标滑入弹层则取消关闭，从而允许鼠标移动到选项上并点击；只有鼠标
 * 同时离开胶囊和弹层区域，弹层才自动收起。胶囊本身不带原生 title tooltip
 * （挤压态只弹选项、不弹提示气泡）。
 */
function CollapsedSeg<T extends string>({
    options,
    activeId,
    onSelect,
    title,
    groupLabel,
}: {
    options: Array<{id: T; label: string}>
    activeId: T
    onSelect: (id: T) => void
    title: (id: T) => string
    groupLabel: string
}) {
    const pillRef = useRef<HTMLSpanElement>(null)
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{left: number; top: number} | null>(null)
    const active = options.find((o) => o.id === activeId)

    const clearHideTimer = () => {
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    }
    const openPop = () => {
        clearHideTimer()
        const el = pillRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        setPos({left: r.left + r.width / 2, top: r.top}) // 弹层置于胶囊上方，水平居中
        setOpen(true)
    }
    const scheduleHide = () => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        hideTimerRef.current = setTimeout(() => setOpen(false), 180)
    }
    // 卸载时清理定时器
    useEffect(() => clearHideTimer, [])

    return (
        <span
            className="seg-collapsed"
            data-name={`conv-mode-collapsed-${groupLabel}`}
            onMouseEnter={openPop}
            onMouseLeave={scheduleHide}
        >
            {/* 当前选中项胶囊（无原生 title，避免干扰选项弹层） */}
            <span ref={pillRef} className="seg-collapsed-pill" role="button" tabIndex={0} aria-label={groupLabel}>
                {active?.label}
            </span>

            {/* hover 上弹其余选项（Portal 到 body，向上弹出不被 overflow 裁剪） */}
            {open && pos && createPortal(
                <span
                    className="seg-pop"
                    role="listbox"
                    aria-label={`${groupLabel}选项`}
                    style={{left: pos.left, top: pos.top, transform: 'translate(-50%, -100%) translateY(-4px)'}}
                    onMouseEnter={clearHideTimer}
                    onMouseLeave={scheduleHide}
                >
                    {options.map((o) => (
                        <button
                            key={o.id}
                            type="button"
                            role="option"
                            aria-selected={o.id === activeId}
                            className={`seg-pop-item ${o.id === activeId ? 'active' : ''}`}
                            onClick={() => onSelect(o.id)}
                            title={title(o.id)}
                        >
                            {o.label}
                        </button>
                    ))}
                </span>,
                document.body,
            )}
        </span>
    )
}

/**
 * 会话级控件：安全模式 + 显示模式 segmented control。
 * 经 InputToolbar.extraActions 插槽注入 input-toolbar-actions 最左侧。
 * 安全模式走会话级链路（meta + 广播目标 worker）；显示模式纯渲染层（meta + 顶层开关）。
 *
 * 挤压分级（availWidth = 模式组在 action 区实际可见宽度，px）：
 *  - 充足：两组完整展开（旧行为）
 *  - 开始被挤压：两组折叠为"当前选中项单选胶囊"，hover 向上弹出其余选项
 *  - 放不下 2 组：优先保留显示模式（折叠单选），隐藏安全模式
 *  - 放不下 1 组：彻底隐藏
 */
export default function ConvModeSegs() {
    const permissionMode = useAgentStore((s) => s.permissionMode)
    const messageDisplayMode = useAgentStore((s) => s.messageDisplayMode)
    const setConvPermissionMode = useAgentStore((s) => s.setConvPermissionMode)
    const setConvDisplayMode = useAgentStore((s) => s.setConvDisplayMode)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const availWidth = useContext(ModeSpaceContext)

    if (!activeConversationId) return null

    // 挤压等级阈值 ≈ 11px 字体下各形态实测宽度（安全组2按钮+显示组3按钮+分隔+间隙）：
    // 完整展开约 240px；两组折叠单选约 110px；单组折叠单选约 54px。
    // availWidth 为 null（未测量）时视为空间充足，回退为完整展开（旧行为）。
    const resolveLevel = (w: number | null): number => {
        if (w == null || w >= 240) return 0
        if (w >= 110) return 1
        if (w >= 54) return 2
        return 3
    }
    const level = resolveLevel(availWidth)
    if (level === 3) return null

    return (
        <>
            {level === 0 && (
                <>
                    <div className="seg perm" role="group" aria-label="安全模式">
                        {PERM_MODES.map((m) => (
                            <button
                                key={m.id}
                                data-v={m.id}
                                data-name={`conv-mode-perm-${m.id}`}
                                className={permissionMode === m.id ? 'active' : ''}
                                onClick={() => setConvPermissionMode(activeConversationId, m.id)}
                                title={permTitle(m.id)}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <div className="seg" role="group" aria-label="显示模式">
                        {DISP_MODES.map((m) => (
                            <button
                                key={m.id}
                                data-name={`conv-mode-disp-${m.id}`}
                                className={messageDisplayMode === m.id ? 'active' : ''}
                                onClick={() => setConvDisplayMode(activeConversationId, m.id)}
                                title={dispTitle(m.id)}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <span className="tb-sep" aria-hidden="true"/>
                </>
            )}

            {(level === 1 || level === 2) && (
                <>
                    {level === 1 && (
                        <CollapsedSeg
                            options={PERM_MODES}
                            activeId={permissionMode}
                            onSelect={(id) => setConvPermissionMode(activeConversationId, id)}
                            title={permTitle}
                            groupLabel="安全模式"
                        />
                    )}
                    <CollapsedSeg
                        options={DISP_MODES}
                        activeId={messageDisplayMode}
                        onSelect={(id) => setConvDisplayMode(activeConversationId, id)}
                        title={dispTitle}
                        groupLabel="显示模式"
                    />
                    <span className="tb-sep" aria-hidden="true"/>
                </>
            )}
        </>
    )
}
