import {useMemo, useState, useEffect, useRef} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useLLMStore} from '../stores/llmStore'
import {usePrimaryRole} from '../hooks/usePrimaryRole'
import {getEffortOptions, resolveOverrideThinkingEffort} from '@shared/thinkingEffort'
import type {ThinkingEffort} from '@shared/thinkingEffort'
import {useModelSchemeStore} from '../stores/modelSchemeStore'

interface ThinkingEffortSelectorProps {
    /** 当前会话 ID（会话级 override 读取/写入） */
    conversationId: string
}

/**
 * 思考强度选择器 — 会话级思考强度覆盖
 * - 显示生效值：override 显式值 → 方案角色匹配继承 → auto 兜底（与主进程解析同规则，shared 纯函数）
 * - 无 override 时只读展示当前角色继承的生效值；用户改动则以当前活跃模型创建 override
 * - 档位列表按当前生效服务商协议动态渲染（getEffortOptions）
 */
export default function ThinkingEffortSelector({conversationId}: ThinkingEffortSelectorProps) {
    const modelOverride = useAgentStore(s => s.modelOverride)
    const setModelOverride = useAgentStore(s => s.setModelOverride)
    const providers = useLLMStore(s => s.providers)
    const primaryRole = usePrimaryRole()
    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState({bottom: 0, right: 0})

    // 当前生效模型（override 优先，否则方案 primary；与 ModelSelector 的 active 解析口径一致）
    const effectiveProviderId = modelOverride?.endpointId ?? primaryRole?.endpointId ?? ''
    const effectiveModelId = modelOverride?.modelId ?? primaryRole?.modelId ?? ''
    const provider = providers.find(p => p.id === effectiveProviderId)

    // 档位列表按协议动态渲染
    const options = useMemo(() => getEffortOptions(provider?.type), [provider?.type])

    // 生效思考强度（与主进程 resolveOverrideThinkingEffort 同一纯函数）
    const schemes = useModelSchemeStore(s => s.schemes)
    const activeSchemeId = useModelSchemeStore(s => s.activeSchemeId)
    const activeScheme = useMemo(
        () => schemes.find(s => s.id === activeSchemeId) ?? null,
        [schemes, activeSchemeId],
    )
    const effective: ThinkingEffort = useMemo(() => {
        if (modelOverride) {
            return resolveOverrideThinkingEffort(modelOverride, activeScheme)
        }
        // 无 override → 当前即方案角色本身，展示该角色的 thinkingEffort（undefined=未配置 → auto 展示）
        return (primaryRole?.thinkingEffort as ThinkingEffort | undefined) ?? 'auto'
    }, [modelOverride, activeScheme, primaryRole?.thinkingEffort])

    // popover 向上展开定位（与 ModelSelector 同模式）
    useEffect(() => {
        if (open && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect()
            setPosition({
                bottom: window.innerHeight - rect.top + 6,
                right: window.innerWidth - rect.right,
            })
        }
    }, [open])

    // 点击外部 / Esc 关闭
    useEffect(() => {
        if (!open) return
        const handleClickOutside = (e: MouseEvent) => {
            if (buttonRef.current?.contains(e.target as Node)) return
            if (panelRef.current?.contains(e.target as Node)) return
            setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', handleClickOutside)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    /** 选择档位：以当前活跃模型创建/更新会话级 override（携带 thinkingEffort） */
    const handleSelect = (effort: ThinkingEffort) => {
        setOpen(false)
        const baseEndpointId = effectiveProviderId || modelOverride?.endpointId
        const baseModelId = effectiveModelId || modelOverride?.modelId
        if (!baseEndpointId || !baseModelId || !conversationId) return
        setModelOverride(conversationId, {
            endpointId: baseEndpointId,
            modelId: baseModelId,
            providerName: provider?.name,
            thinkingEffort: effort,
        })
    }

    const currentLabel = options.find(o => o.value === effective)?.label ?? effective

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                onClick={() => setOpen(v => !v)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)] ${
                    open
                        ? 'border-[var(--brand-primary)] bg-[var(--brand-muted)] text-[var(--brand-primary)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-emphasis)] hover:bg-[var(--surface-muted)] active:bg-[var(--surface-overlay)]'
                }`}
                aria-expanded={open}
                aria-haspopup="menu"
                title="思考强度"
            >
                <span className="text-[var(--text-muted)] whitespace-nowrap">思维:{currentLabel}</span>
                <svg className={`w-2.5 h-2.5 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 15 12 9 18 15"/>
                </svg>
            </button>

            {createPortal(
                <AnimatePresence>
                    {open && (
                        <motion.div
                            initial={{opacity: 0, y: 8, scale: 0.96}}
                            animate={{opacity: 1, y: 0, scale: 1}}
                            exit={{opacity: 0, y: 8, scale: 0.96}}
                            transition={{duration: 0.15}}
                            style={{bottom: position.bottom, right: position.right}}
                            className="fixed z-[9999] w-max min-w-[200px] max-w-[340px]"
                            onMouseDown={(e) => e.stopPropagation()}
                            ref={panelRef}
                        >
                            <div className="bg-[var(--surface-elevated)]/92 backdrop-blur-lg border border-[var(--border)] rounded-xl shadow-2xl shadow-black/20 overflow-hidden">
                                <div className="p-1.5">
                                    <div className="px-2 py-1.5 text-[10px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] mb-1">
                                        思考强度
                                    </div>
                                    {options.map(o => (
                                        <button
                                            key={o.value}
                                            onClick={() => handleSelect(o.value)}
                                            title={o.hint}
                                            className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs rounded-lg transition-colors ${
                                                o.value === effective
                                                    ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]'
                                                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
                                            }`}
                                        >
                                            <span>{o.label}</span>
                                            {o.value === effective && (
                                                <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                                                    <polyline points="20 6 9 17 4 12"/>
                                                </svg>
                                            )}
                                        </button>
                                    ))}
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
