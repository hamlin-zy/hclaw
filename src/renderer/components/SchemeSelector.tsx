import {useCallback, useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {switchActiveScheme, useModelSchemeStore} from '../stores/modelSchemeStore'
import {useMenuBarStore} from '../stores/menuBarStore'
import type {ModelRole, ModelScheme} from '@shared/types'
import {useAgentStore} from '../stores/agentStore'

/** 模型方案的颜色标识 */
const SCHEME_COLORS = [
    {dot: 'bg-purple-500', selected: 'border-purple-500/50'},
    {dot: 'bg-yellow-500', selected: 'border-yellow-500/50'},
    {dot: 'bg-red-500', selected: 'border-red-500/50'},
    {dot: 'bg-green-500', selected: 'border-green-500/50'},
    {dot: 'bg-blue-500', selected: 'border-blue-500/50'},
    {dot: 'bg-pink-500', selected: 'border-pink-500/50'},
    {dot: 'bg-orange-500', selected: 'border-orange-500/50'},
    {dot: 'bg-cyan-500', selected: 'border-cyan-500/50'},
]

/**
 * Fixed 定位的 Dropdown 组件
 * 使用 fixed 定位来避免被外层 stacking context 遮挡
 */
function FixedDropdown({
                           open,
                           buttonRef,
                           schemes,
                           activeSchemeId,
                           isSwitching,
                           onSwitch,
                           onOpenConfig,
                       }: {
    open: boolean
    buttonRef: React.RefObject<HTMLDivElement | null>
    schemes: ModelScheme[]
    activeSchemeId: string | null
    isSwitching: boolean
    onSwitch: (schemeId: string) => void
    onOpenConfig: () => void
}) {
    const [position, setPosition] = useState({top: 0, right: 0})
    const dropdownRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (open && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect()
            setPosition({
                top: rect.bottom + 6,
                right: window.innerWidth - rect.right,
            })
        }
    }, [open, buttonRef])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                dropdownRef.current &&
                buttonRef.current &&
                !dropdownRef.current.contains(e.target as Node) &&
                !buttonRef.current.contains(e.target as Node)
            ) {
                // Close will be handled by parent
            }
        }
        if (open) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [open, buttonRef])

    if (!open) return null

    return (
        <motion.div
            ref={dropdownRef}
            initial={{opacity: 0, y: -8, scale: 0.96}}
            animate={{opacity: 1, y: 0, scale: 1}}
            exit={{opacity: 0, y: -8, scale: 0.96}}
            transition={{duration: 0.15, ease: [0.4, 0, 0.2, 1]}}
            style={{top: position.top, right: position.right}}
            className="fixed z-[9999] min-w-[200px] max-w-[280px]"
        >
            {/* 下拉面板 - 毛玻璃效果 */}
            <div className="bg-[var(--surface-elevated)]/92 backdrop-blur-lg border border-[var(--border)] rounded-2xl shadow-2xl shadow-black/20 overflow-hidden">
                <div className="p-1.5 flex flex-col">
                    {/* 方案列表 */}
                    {schemes.map((scheme, index) => {
                        const colorIndex = index % SCHEME_COLORS.length
                        const isActive = activeSchemeId === scheme.id
                        const colors = SCHEME_COLORS[colorIndex]

                        return (
                            <button
                                key={scheme.id}
                                onClick={() => onSwitch(scheme.id)}
                                disabled={isSwitching}
                                className={`w-full px-3 py-2.5 text-left text-xs rounded-xl transition-all disabled:opacity-50 ${
                                    isActive
                                        ? `bg-[var(--brand-primary)]/15`
                                        : 'hover:bg-[var(--surface-muted)]'
                                }`}
                            >
                                <div className="flex items-center gap-2.5">
                                    {/* 彩色圆点 */}
                                    <div className={`w-2 h-2 rounded-full ${colors.dot} ${isActive ? '' : 'opacity-60'}`}/>

                                    <div className="flex-1 min-w-0">
                                        <div className={`font-medium truncate ${isActive ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'}`}>
                                            {scheme.name}
                                        </div>
                                        {scheme.description && (
                                            <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">
                                                {scheme.description}
                                            </div>
                                        )}
                                    </div>

                                    {/* 选中对勾 */}
                                    {isActive && (
                                        <svg className="w-4 h-4 text-[var(--brand-primary)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <polyline points="20 6 9 17 4 12"/>
                                        </svg>
                                    )}
                                </div>
                            </button>
                        )
                    })}

                    {schemes.length === 0 && (
                        <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">
                            暂无可用方案
                        </div>
                    )}

                    <div className="my-1.5 h-px bg-[var(--border)]"/>

                    {/* 配置入口 */}
                    <button
                        onClick={onOpenConfig}
                        className="w-full px-3 py-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded-xl flex items-center gap-2.5 transition-colors"
                    >
                        <svg
                            className="w-3.5 h-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                        </svg>
                        <span>方案配置</span>
                    </button>
                </div>
            </div>
        </motion.div>
    )
}

/**
 * 方案选择器
 *
 * 按照参考图片优化：胶囊形状 + 品牌绿边框 + 毛玻璃下拉面板
 * 方案切换是实时的，下次 LLM 调用自动使用新方案。
 */
export default function SchemeSelector() {
    const {schemes, activeSchemeId} = useModelSchemeStore()
    const {openDialog} = useMenuBarStore()
    const [isOpen, setIsOpen] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [toastMessage, setToastMessage] = useState<string | null>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)

    const enabledSchemes = schemes.filter((s) => s.enabled)
    const activeScheme = schemes.find((s) => s.id === activeSchemeId)

    const showToast = useCallback((message: string, duration = 3000) => {
        setToastMessage(message)
        setTimeout(() => setToastMessage(null), duration)
    }, [])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleSchemeSwitch = async (schemeId: string) => {
        if (isSwitching) return

        setIsSwitching(true)
        setIsOpen(false)

        try {
            const result = await switchActiveScheme(schemeId)

            if (result.switched && result.schemeName) {
                showToast(`已切换至「${result.schemeName}」`, 3000)
            }
        } catch (err) {
            showToast('方案切换失败', 3000)
        } finally {
            setIsSwitching(false)
        }
    }

    const isActive = activeScheme?.enabled

    return (
        <>
            {/* Toast 提示 */}
            <AnimatePresence>
                {toastMessage && (
                    <motion.div
                        initial={{opacity: 0, y: -10}}
                        animate={{opacity: 1, y: 0}}
                        exit={{opacity: 0, y: -10}}
                        transition={{duration: 0.2, ease: 'easeOut'}}
                        className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] px-4 py-2 rounded-lg bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated text-sm text-[var(--text-primary)] flex items-center gap-2"
                        role="status"
                        aria-live="polite"
                    >
                        <svg className="w-4 h-4 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="2">
                            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                        {toastMessage}
                    </motion.div>
                )}
            </AnimatePresence>

            <div ref={dropdownRef} className="relative">
                {/* 胶囊形状按钮 - 品牌绿边框 */}
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    disabled={isSwitching}
                    className={`
                        relative flex items-center gap-2 px-3 py-1.5 rounded-md
                        border border-transparent hover:border-[var(--border)]
                        transition-all duration-200
                        disabled:opacity-50 disabled:cursor-not-allowed
                        ${isActive
                            ? 'bg-[var(--brand-primary)]/10'
                            : 'hover:bg-[var(--surface-muted)] bg-[var(--surface)]'
                        }
                    `}
                    aria-expanded={isOpen}
                    aria-label="选择模型方案"
                >
                    {/* 状态指示灯 */}
                    <div className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-[var(--brand-primary)]' : 'bg-[var(--text-muted)]'}`}/>

                    {/* 方案名称 */}
                    <span className={`text-xs font-medium ${isActive ? 'text-[var(--brand-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        {isSwitching ? '切换中...' : activeScheme?.name || '选择方案'}
                    </span>

                    {/* 下拉箭头 */}
                    <svg
                        className={`w-3 h-3 transition-transform duration-200 ${isActive ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'} ${isOpen ? 'rotate-180' : ''}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                    >
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                </button>

                <FixedDropdown
                    open={isOpen}
                    buttonRef={dropdownRef}
                    schemes={enabledSchemes}
                    activeSchemeId={activeSchemeId}
                    isSwitching={isSwitching}
                    onSwitch={handleSchemeSwitch}
                    onOpenConfig={() => {
                        setIsOpen(false)
                        openDialog('scheme-config')
                    }}
                />
            </div>
        </>
    )
}