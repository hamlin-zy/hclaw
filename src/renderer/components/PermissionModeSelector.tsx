import {useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'

/**
 * 运行模式选择器 (PermissionModeSelector)
 *
 * 支持 Auto / Safe 两种模式的切换。
 * 设计风格：扁平化图标+文字，次要操作，盾牌图标传达"安全"概念。
 */
export default function PermissionModeSelector() {
    const {permissionMode, setPermissionMode} = useAgentStore()
    const [isOpen, setIsOpen] = useState(false)
    const [position, setPosition] = useState({top: 0, right: 0})
    const dropdownRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        const initMode = async () => {
            try {
                const mode = await (window.electronAPI as any)?.agentGetPermissionMode?.()
                if (mode) {
                    useAgentStore.setState({permissionMode: mode})
                }
            } catch (err) {
                // Error silently ignored
            }
        }
        initMode()
    }, [])

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
            id: 'auto',
            name: '自动模式',
            icon: (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
            ),
            desc: '全程自动执行',
            color: 'text-yellow-500',
            hoverColor: 'hover:text-yellow-400',
            bgColor: 'bg-yellow-500',
        },
        {
            id: 'safe',
            name: '安全模式',
            icon: (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
            ),
            desc: '有保护，更安全',
            color: 'text-red-500',
            hoverColor: 'hover:text-red-400',
            bgColor: 'bg-red-500',
        },
    ]

    const activeMode = modes.find(m => m.id === permissionMode) || modes[1]

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
            >
                {/* 盾牌/闪电图标 */}
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
                                    运行模式
                                </div>

                                {modes.map((m) => {
                                    const isActive = permissionMode === m.id

                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => {
                                                setPermissionMode(m.id as any)
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