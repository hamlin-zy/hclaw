import {useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'

/**
 * 消息显示模式选择器 (MessageDisplayModeSelector)
 *
 * 三种模式：
 * - 详细模式 (detailed) → 当前样式
 * - 简洁模式 (compact) → 思考块默认折叠、工具调用显示调用次数
 * - 紧凑模式 (ultra-compact) → 工具汇总行·Popup 展开详情
 *
 * 设计风格：扁平化图标+文字，次要操作，链接图标传达"紧凑连接"概念。
 */
export default function MessageDisplayModeSelector() {
    const {messageDisplayMode, setMessageDisplayMode} = useAgentStore()
    const [isOpen, setIsOpen] = useState(false)
    const [position, setPosition] = useState({top: 0, right: 0})
    const dropdownRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (isOpen && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect()
            setPosition({
                top: rect.bottom + 6,
                right: window.innerWidth - rect.right,
            })
        }
    }, [isOpen])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && buttonRef.current &&
                !dropdownRef.current.contains(e.target as Node) &&
                !buttonRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const modes = [
        {
            id: 'detailed' as const,
            name: '详细模式',
            icon: (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                </svg>
            ),
            desc: '当前默认样式',
            color: 'text-green-500',
            hoverColor: 'hover:text-green-400',
        },
        {
            id: 'compact' as const,
            name: '简洁模式',
            icon: (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="8" y1="6" x2="21" y2="6"/>
                    <line x1="8" y1="12" x2="21" y2="12"/>
                    <line x1="8" y1="18" x2="21" y2="18"/>
                    <line x1="3" y1="6" x2="3.01" y2="6"/>
                    <line x1="3" y1="12" x2="3.01" y2="12"/>
                    <line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
            ),
            desc: '思考块折叠·工具调用聚合',
            color: 'text-blue-500',
            hoverColor: 'hover:text-blue-400',
        },
        {
            id: 'ultra-compact' as const,
            name: '紧凑模式',
            icon: (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="4 14 10 14 10 20"/>
                    <polyline points="20 10 14 10 14 4"/>
                    <line x1="14" y1="10" x2="21" y2="3"/>
                    <line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
            ),
            desc: '工具汇总行·Popup 展开详情',
            color: 'text-orange-500',
            hoverColor: 'hover:text-orange-400',
        },
    ]

    const activeMode = modes.find(m => m.id === messageDisplayMode) || modes[0]

    return (
        <div ref={dropdownRef} className="relative">
            {/* 扁平化按钮 - 仅图标+文字 */}
            <button
                ref={buttonRef}
                onClick={() => setIsOpen(!isOpen)}
                className={`
                    flex items-center gap-1.5 px-2.5 py-1 rounded-md
                    border border-transparent hover:border-[var(--border)]
                    text-xs transition-all duration-200 bg-[var(--surface)]
                    text-[var(--text-secondary)]
                `}
                aria-expanded={isOpen}
                title={activeMode.name}
            >
                {/* 链接/列表图标 */}
                <span className="text-[var(--text-secondary)]">{activeMode.icon}</span>

                {/* 模式名称 */}
                <span className="text-[var(--text-muted)]">{activeMode.name}</span>

                {/* 下拉箭头 */}
                <svg
                    className={`w-3 h-3 text-[var(--text-muted)] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{opacity: 0, y: -8, scale: 0.96}}
                        animate={{opacity: 1, y: 0, scale: 1}}
                        exit={{opacity: 0, y: -8, scale: 0.96}}
                        transition={{duration: 0.15, ease: [0.4, 0, 0.2, 1]}}
                        style={{top: position.top, right: position.right, width: '180px'}}
                        className="fixed z-[9999]"
                    >
                        {/* 毛玻璃面板 */}
                        <div className="bg-[var(--surface-elevated)]/92 backdrop-blur-lg border border-[var(--border)] rounded-2xl shadow-2xl shadow-black/20 overflow-hidden">
                            <div className="p-1.5">
                                {/* 标题 */}
                                <div className="px-2.5 py-2 text-[10px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] mb-1">
                                    消息显示
                                </div>

                                {modes.map((m) => {
                                    const isActive = messageDisplayMode === m.id

                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => {
                                                setMessageDisplayMode(m.id)
                                                setIsOpen(false)
                                            }}
                                            className={`
                                                w-full px-2.5 py-2.5 text-left text-xs rounded-xl
                                                transition-all duration-150 flex items-center gap-2.5
                                                ${isActive
                                                    ? `bg-[var(--brand-primary)]/15 ${m.color}`
                                                    : `text-[var(--text-muted)] hover:bg-[var(--surface-muted)] ${m.hoverColor}`
                                                }
                                            `}
                                        >
                                            {/* 左侧图标 */}
                                            <span className={isActive ? '' : 'opacity-70'}>{m.icon}</span>

                                            {/* 名称 */}
                                            <span className={`font-medium ${isActive ? '' : 'text-[var(--text-secondary)]'}`}>
                                                {m.name}
                                            </span>
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}