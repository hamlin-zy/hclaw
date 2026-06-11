import {type ReactNode, useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useAgentStore} from '../stores/agentStore'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import {useMenuBarStore} from '../stores/menuBarStore'
import {resolveRoleDisplay} from '@shared/modelSchemeHelpers'
import {renderWorkModeIcon} from '@shared/roleIcons'
import type {ModelScheme} from '@shared/types'

/* ─── Role SVG Icons (monochrome, consistent with menu bar) ─────────── */

function RolePrimaryIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>
        </svg>
    )
}

function RoleChatIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
    )
}

function RoleBrainIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
        </svg>
    )
}

function RoleImageIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <path d="M21 15l-5-5L5 21"/>
        </svg>
    )
}

function RoleAudioIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
    )
}

function RoleVideoIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
        </svg>
    )
}

function RoleArtIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v2M12 21v2M1 12h2M21 12h2"/>
            <path d="M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42"/>
            <path d="M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
    )
}

function RoleMusicIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
        </svg>
    )
}

/** Map role ID to monochrome SVG icon component */
function getRoleIcon(roleId: string): ReactNode {
    const icons: Record<string, ReactNode> = {
        primary: <RolePrimaryIcon/>,
        lightweight: <RoleChatIcon/>,
        reasoning: <RoleBrainIcon/>,
        image_understanding: <RoleImageIcon/>,
        audio_understanding: <RoleAudioIcon/>,
        video_understanding: <RoleVideoIcon/>,
        image_generation: <RoleArtIcon/>,
        video_generation: <RoleVideoIcon/>,
        voice_clone: <RoleAudioIcon/>,
        voice_synthesis: <RoleAudioIcon/>,
        music_generation: <RoleMusicIcon/>,
    }
    return icons[roleId] ?? <RolePrimaryIcon/>
}

/**
 * 工作模式选择器 (WorkModeSelector)
 *
 * 从当前激活方案的角色列表中读取工作模式。
 * - auto 模式为特殊模式
 * - 文本角色显示为可选工作模式
 * - 底部提供添加工作模式入口
 */
export default function WorkModeSelector() {
    const {workMode, setWorkMode} = useAgentStore()
    const {openDialog} = useMenuBarStore()
    const [isOpen, setIsOpen] = useState(false)
    const [position, setPosition] = useState({top: 0, right: 0})
    const dropdownRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)

    const activeScheme = useModelSchemeStore((s) => {
        const scheme = s.schemes.find((sc) => sc.id === s.activeSchemeId)
        return scheme || null
    })

    // 构建模式列表：方案中的文本角色
    const modes = buildModeList(activeScheme)

    useEffect(() => {
        const initMode = async () => {
            try {
                const mode = await (window.electronAPI as any)?.agentGetWorkMode?.()
                if (mode) {
                    useAgentStore.setState({workMode: mode})
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

    const activeMode = modes.find(m => m.id === workMode) ?? modes[0] ?? DEFAULT_MODE

    return (
        <div ref={dropdownRef} className="relative">
            <button
                ref={buttonRef}
                onClick={() => setIsOpen(!isOpen)}
                className={`
                    flex items-center gap-1.5 px-2.5 py-1 rounded-md
                    border border-transparent hover:border-[var(--border)]
                    text-xs transition-all duration-200 bg-[var(--surface)]
                `}
                aria-expanded={isOpen}
            >
                <span>{activeMode.icon}</span>
                <span className="text-[var(--text-muted)]">{activeMode.name}</span>
                <svg
                    className={`w-3 h-3 text-[var(--text-muted)] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
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
                        style={{top: position.top, right: position.right, width: '200px'}}
                        className="fixed z-[9999]"
                    >
                        <div className="bg-[var(--surface-elevated)]/92 backdrop-blur-lg border border-[var(--border)] rounded-2xl shadow-2xl shadow-black/20 overflow-hidden">
                            <div className="p-1.5">
                                <div className="px-2.5 py-2 text-[10px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] mb-1">
                                    工作模式
                                </div>

                                {modes.map((m) => {
                                    const isActive = workMode === m.id

                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => {
                                                setWorkMode(m.id)
                                                setIsOpen(false)
                                            }}
                                            className={`
                                                w-full px-2.5 py-2 text-left text-xs rounded-xl
                                                transition-all duration-150 flex items-center gap-2.5
                                                ${isActive
                                                    ? 'bg-[var(--brand-primary)]/15'
                                                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
                                                }
                                            `}
                                        >
                                            <span className={`${isActive ? '' : 'opacity-70'}`}>{m.icon}</span>
                                            <span className={`font-medium flex-1 ${isActive ? '' : 'text-[var(--text-secondary)]'}`}>
                                                {m.name}
                                            </span>
                                            {m.effortLabel && (
                                                <span className="text-[9px] text-purple-400 font-medium">{m.effortLabel}</span>
                                            )}
                                        </button>
                                    )
                                })}

                                {activeScheme && activeScheme.roles.filter(r => r.modelType === 'text').length > 0 && (
                                    <div className="border-t border-[var(--border)] mt-1 pt-1">
                                        <button
                                            onClick={() => {
                                                setIsOpen(false)
                                                openDialog('scheme-config')
                                            }}
                                            className="w-full flex items-center gap-1.5 px-2.5 py-2 text-left text-xs rounded-xl text-brand-500 hover:bg-brand-50 transition-colors"
                                        >
                                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <path d="M12 5v14M5 12h14"/>
                                            </svg>
                                            配置工作模式
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ─── 辅助函数 ─────────────────────────────────────────────

interface ModeItem {
    id: string
    name: string
    icon: ReactNode
    description?: string
    effortLabel: string | null
}

const DEFAULT_MODE: ModeItem = {
    id: 'primary',
    name: '工作模式',
    icon: <RolePrimaryIcon/>,
    effortLabel: null,
}

function buildModeList(activeScheme: ModelScheme | null): ModeItem[] {
    if (!activeScheme) return []

    return activeScheme.roles
        .filter(r => r.modelType === 'text' && r.enabled)
        .map(role => {
            const display = resolveRoleDisplay(role)
            return {
                id: role.role,
                name: display.name,
                icon: role.icon ? renderWorkModeIcon(role.icon) : getRoleIcon(role.role),
                description: display.description,
                effortLabel: role.thinkingEffort ? `强度:${EFFORT_SHORT[role.thinkingEffort] || role.thinkingEffort}` : null,
            }
        })
}

const EFFORT_SHORT: Record<string, string> = {
    auto: '自动',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
}
