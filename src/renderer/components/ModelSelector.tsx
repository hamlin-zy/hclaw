import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useLLMStore} from '../stores/llmStore'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import type {ModelOverride} from '@shared/types'

interface ModelSelectorProps {
    /** 当前会话 ID（切换会话时恢复各自选择） */
    conversationId: string
}

/** 弹出层视图：closed=关闭 / providers=服务商 popover / models=级联子菜单展开 */
type ViewState = 'closed' | 'providers' | 'models'

/** 子菜单与父项水平间隙 */
const SUBMENU_GAP = 6
/** 子菜单贴窗口边缘的最小留白 */
const EDGE_MARGIN = 8
/** hover 开关防抖延迟（ms）：兼顾快速扫过不抖、跨间隙进子菜单不误关 */
const HOVER_DELAY = 120

/**
 * 模型选择器 — 会话级模型覆盖（替代 WorkModeSelector）
 * - 无 override：虚拟选中当前方案 primary（只读匹配，不写库）
 * - 用户选定具体模型：当前会话后续轮次直接使用（会话级 override，持久化）
 * - 位置：InputArea 下方统计栏（t/s 徽章旁），popover 向上展开
 * - 交互：popover 列服务商 → hover/点击服务商项 → 右侧级联子菜单列模型（点击即应用）
 *   （Windows 传统菜单语义：子菜单紧邻父项右侧水平展开，垂直对齐父项、高度自适应内容）
 */
export default function ModelSelector({conversationId}: ModelSelectorProps) {
    const modelOverride = useAgentStore(s => s.modelOverride)
    const setModelOverride = useAgentStore(s => s.setModelOverride)
    const providers = useLLMStore(s => s.providers)
    const [view, setView] = useState<ViewState>('closed')
    const [selProviderId, setSelProviderId] = useState('')
    const [position, setPosition] = useState({bottom: 0, right: 0})
    // 子菜单定位：anchor=父项 rect 快照（hover 时抓取），pos=测量后修正的最终 left/top
    const [submenuAnchor, setSubmenuAnchor] = useState<DOMRect | null>(null)
    const [submenuPos, setSubmenuPos] = useState({left: 0, top: 0})
    const buttonRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const submenuRef = useRef<HTMLDivElement>(null)
    const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 会话切换 → 重新读取该会话 override
    useEffect(() => {
        (async () => {
            try {
                const res = await (window.electronAPI as any)?.modelOverrideGet?.(conversationId)
                if (res?.success) {
                    useAgentStore.setState({
                        modelOverride: res.data.override ?? null,
                    })
                }
            } catch { /* 静默 */ }
        })()
    }, [conversationId])

    // 监听多窗口广播
    useEffect(() => {
        const handler = (_e: any, data: {convId: string; override: ModelOverride | null}) => {
            if (data.convId === conversationId) useAgentStore.setState({modelOverride: data.override ?? null})
        }
        window.addEventListener('model-override-changed' as any, handler as any)
        return () => window.removeEventListener('model-override-changed' as any, handler as any)
    }, [conversationId])

    // 解析生效显示：与 selectModelForTurn 决策对齐（findEffectiveOverride 只认会话 override，
    // 无记录=默认 primary）。★ 不回退历史选择：老会话无 override 记录时显示 primary 模型名（虚拟选中），
    //   否则显示与实际生效不一致。新会话无 override 记录 → 默认 primary，显示 primary 模型名。
    const active = modelOverride

    // 当前方案 primary 角色（无 override 时作为虚拟选中目标；只读匹配，不写库）
    const primaryRole = useMemo(() => {
        const scheme = useModelSchemeStore.getState().getActiveScheme()
        return scheme?.roles.find(r => r.role === 'primary' && r.enabled && r.endpointId && r.modelId) ?? null
        // 依赖 scheme 变更：用 useModelSchemeStore 订阅（见下方依赖数组）
    }, [useModelSchemeStore(s => s.schemes), useModelSchemeStore(s => s.activeSchemeId)])

    const activeLabel = useMemo(() => {
        if (active) {
            const provider = providers.find(p => p.id === active.endpointId)
            const model = provider?.models.find(m => m.id === active.modelId)
            if (provider && model) return `${provider.name}: ${model.name}`
            return active.modelId || active.providerName || ''
        }
        // 无 override → 显示当前方案 primary 模型名（虚拟选中语义）
        if (primaryRole) {
            const provider = providers.find(p => p.id === primaryRole.endpointId)
            const model = provider?.models.find(m => m.id === primaryRole.modelId)
            if (provider && model) return `${provider.name}: ${model.name}`
        }
        return '主力模型'  // primary 未配置/不可解析 → 兜底文案（原"自动"）
    }, [active, primaryRole, providers])

    // popover 向上展开定位（基于按钮 rect；子菜单独立 fixed 定位，见下方 useLayoutEffect）
    useEffect(() => {
        if (view !== 'closed' && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect()
            setPosition({
                bottom: window.innerHeight - rect.top + 6, // 向上展开
                right: window.innerWidth - rect.right,
            })
        }
    }, [view])

    // 子菜单定位：默认从父项右侧水平展开；右缘空间不足则向左展开或贴右缘；
    // 垂直方向与父项对齐，贴近窗口顶部/底部时做 min/max 夹取保证完整可见。
    // useLayoutEffect 在绘制前运行，测量 offsetWidth/Height 后修正，无闪烁。
    useLayoutEffect(() => {
        if (view !== 'models' || !submenuAnchor || !submenuRef.current) return
        const el = submenuRef.current
        const w = el.offsetWidth
        const h = el.offsetHeight

        let left = submenuAnchor.right + SUBMENU_GAP
        if (left + w > window.innerWidth - EDGE_MARGIN) {
            // 右侧放不下：优先向左展开（贴父项左缘），若左边也不够则贴窗口右缘
            const leftAlt = submenuAnchor.left - w - SUBMENU_GAP
            left = leftAlt >= EDGE_MARGIN ? leftAlt : Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN)
        }
        const top = Math.max(EDGE_MARGIN, Math.min(submenuAnchor.top, window.innerHeight - h - EDGE_MARGIN))
        setSubmenuPos({left, top})
    }, [view, selProviderId, submenuAnchor])

    // 点击外部关闭：providers 看 popover，models 需同时排除 popover 与子菜单
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (view === 'closed') return
            const target = e.target as Node
            if (buttonRef.current?.contains(target)) return
            if (panelRef.current?.contains(target)) return
            if (submenuRef.current?.contains(target)) return
            setView('closed')
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [view])

    // Esc 关闭全部层
    useEffect(() => {
        if (view === 'closed') return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setView('closed')
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [view])

    // 卸载时清理 hover 定时器
    useEffect(() => {
        return () => {
            if (openTimerRef.current) clearTimeout(openTimerRef.current)
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
        }
    }, [])

    const enabledProviders = providers.filter(p => p.enabled)
    const selProvider = enabledProviders.find(p => p.id === selProviderId)
    const selModels = selProvider?.models.filter(m => m.enabled) || []

    const handleApply = (providerId: string, modelId: string) => {
        const provider = enabledProviders.find(p => p.id === providerId)
        const ov: ModelOverride = {
            endpointId: providerId,
            modelId,
            providerName: provider?.name,
        }
        setModelOverride(conversationId, ov)
        setView('closed')
        setSubmenuAnchor(null)
    }

    /** 取消挂起的关闭定时器（悬停进入父项或子菜单时调用） */
    const cancelClose = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
    }

    /** 挂起关闭子菜单：移出父项或子菜单后短暂延迟，给跨间隙/跨项留桥接时间。
     *  只关闭二级子菜单（models → providers），一级菜单保持打开；
     *  一级菜单仅在选模型 / 点击外部 / Esc 时关闭。 */
    const scheduleClose = () => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
        closeTimerRef.current = setTimeout(() => {
            setView(v => (v === 'models' ? 'providers' : v))
            setSelProviderId('')
            setSubmenuAnchor(null)
        }, HOVER_DELAY)
    }

    /**
     * 展开某服务商的级联子菜单：快照父项 rect 供定位，短延迟防快速扫过抖动。
     * hover 与 click 共用（Windows 菜单点击父项同样打开子菜单）。
     */
    const openProviderSubmenu = (providerId: string, el: HTMLElement) => {
        if (openTimerRef.current) clearTimeout(openTimerRef.current)
        cancelClose()
        const anchor = el.getBoundingClientRect()
        openTimerRef.current = setTimeout(() => {
            setSelProviderId(providerId)
            setSubmenuAnchor(anchor)
            setView('models')
        }, HOVER_DELAY)
    }

    return (
        <div className="relative ms-2">
            <button
                ref={buttonRef}
                onClick={() => setView(view === 'closed' ? 'providers' : 'closed')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)] ${
                    view !== 'closed'
                        ? 'border-[var(--brand-primary)] bg-[var(--brand-muted)] text-[var(--brand-primary)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-emphasis)] hover:bg-[var(--surface-muted)] active:bg-[var(--surface-overlay)]'
                }`}
                aria-expanded={view !== 'closed'}
                aria-haspopup="menu"
                title="选择模型"
            >
                <span className="text-[var(--text-muted)] whitespace-nowrap">{activeLabel}</span>
                <svg className={`w-2.5 h-2.5 text-[var(--text-muted)] transition-transform ${view !== 'closed' ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 15 12 9 18 15"/>
                </svg>
            </button>

            {/* 服务商 popover（一级菜单，向上展开；子菜单展开期间保持打开） */}
            {createPortal(
                <AnimatePresence>
                    {view !== 'closed' && (
                        <motion.div
                            initial={{opacity: 0, y: 8, scale: 0.96}}
                            animate={{opacity: 1, y: 0, scale: 1}}
                            exit={{opacity: 0, y: 8, scale: 0.96}}
                            transition={{duration: 0.15}}
                            style={{bottom: position.bottom, right: position.right}}
                            className="fixed z-[9999] w-max min-w-[168px] max-w-[340px]"
                            onMouseDown={(e) => e.stopPropagation()}
                            ref={panelRef}
                        >
                            {/* overflow-hidden 仅裁剪自身圆角；子菜单独立 portal 到 body，不受影响。
                                max-h-[80vh]：弹窗最大高度 = 主窗口 80%；内容少时按需渲染，超出才滚动 */}
                            <div className="bg-[var(--surface-elevated)]/92 backdrop-blur-lg border border-[var(--border)] rounded-xl shadow-2xl shadow-black/20 overflow-hidden flex flex-col max-h-[80vh]">
                                <div className="p-2 flex flex-col flex-1 min-h-0">
                                    <div className="px-2 py-1.5 text-[10px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] mb-1">
                                        模型选择
                                    </div>

                                    {/* 服务商列表：已启用服务商（hover/点击 → 右侧级联子菜单） */}
                                    <div className="flex-1 min-h-0 overflow-y-auto">
                                        {enabledProviders.length === 0 && (
                                            <div className="px-2.5 py-2 text-xs text-[var(--text-muted)]">暂无已启用服务商</div>
                                        )}
                                        {enabledProviders.map(p => {
                                            const isActive = active?.endpointId === p.id
                                                || (!active && primaryRole?.endpointId === p.id)   // 虚拟选中：primary 所在服务商
                                            return (
                                                <button
                                                    key={p.id}
                                                    onClick={(e) => openProviderSubmenu(p.id, e.currentTarget)}
                                                    onMouseEnter={(e) => openProviderSubmenu(p.id, e.currentTarget)}
                                                    onMouseLeave={scheduleClose}
                                                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs rounded-lg transition-colors ${
                                                        isActive ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
                                                    }`}
                                                >
                                                    <span className="truncate">{p.name}</span>
                                                    {/* chevron：Windows 菜单「有子菜单」语义 */}
                                                    <svg className="w-3 h-3 shrink-0 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                                        <polyline points="9 18 15 12 9 6"/>
                                                    </svg>
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body,
            )}

            {/* 模型级联子菜单（fixed 浮层，紧邻父项右侧；非全高抽屉） */}
            {createPortal(
                <AnimatePresence>
                    {view === 'models' && selProvider && (
                        <motion.div
                            ref={submenuRef}
                            initial={{opacity: 0, x: -4, scale: 0.96}}
                            animate={{opacity: 1, x: 0, scale: 1}}
                            exit={{opacity: 0, x: -4, scale: 0.96}}
                            transition={{duration: 0.15}}
                            style={{left: submenuPos.left, top: submenuPos.top}}
                            className="fixed z-[9999] w-max min-w-[148px] max-w-[340px]"
                            onMouseDown={(e) => e.stopPropagation()}
                            onMouseEnter={cancelClose}
                            onMouseLeave={scheduleClose}
                        >
                            <div className="bg-[var(--surface-elevated)]/92 backdrop-blur-lg border border-[var(--border)] rounded-xl shadow-2xl shadow-black/20 overflow-hidden">
                                <div className="p-1.5">
                                    <div className="px-2 py-1.5 text-[10px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] mb-1 truncate">
                                        {selProvider.name}
                                    </div>
                                    <div className="max-h-72 overflow-y-auto">
                                        {selModels.length === 0 && (
                                            <div className="px-2.5 py-2 text-xs text-[var(--text-muted)]">该服务商暂无可用模型</div>
                                        )}
                                        {selModels.map(m => {
                                            const isSelected = (active?.endpointId === selProviderId && active?.modelId === m.id)
                                                || (!active && primaryRole?.endpointId === selProviderId && primaryRole.modelId === m.id)  // 虚拟选中：primary 模型项
                                            return (
                                                <button
                                                    key={m.id}
                                                    onClick={() => handleApply(selProviderId, m.id)}
                                                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs rounded-lg transition-colors ${
                                                        isSelected ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
                                                    }`}
                                                >
                                                    <span className="truncate">{m.name}</span>
                                                    {isSelected && (
                                                        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                                                            <polyline points="20 6 9 17 4 12"/>
                                                        </svg>
                                                    )}
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </div>
    )
}
