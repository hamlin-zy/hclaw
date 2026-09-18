import {type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'
import {useConversationStore} from '../stores/conversationStore'
import {useSidebarStore} from '../stores/sidebarStore'
import {getBasename, getRelativeTime} from '../lib/format'
import {useLLMStore} from '../stores/llmStore'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import {useAgentStore} from '../stores/agentStore'
import {INPUT_FOCUS} from '../lib/inputFocus'
import {popoverUp} from '../lib/motionPresets'
import {confirm} from './ConfirmDialog'
import {showUsageStats} from './dialogs/UsageStatsDialog'
import {collectDescendants} from '../stores/conversationTree'
import {useTransientFlag} from '../hooks/useTransientFlag'
import {useThemeStore} from '../stores/themeStore'
import {useUpdaterStore} from '../stores/updaterStore'
import {usePluginUpdateStore} from '../stores/pluginUpdateStore'
import {useRepoUpdateStore} from '../stores/repoUpdateStore'
import {useMcpUpdateStore} from '../stores/mcpUpdateStore'
import {useInitProgressStore} from '../stores/initProgressStore'
import {useProjectGroupStore} from '../stores/projectGroupStore'
import {newConversation} from '../services/newConversation'
import type {ConversationSection} from '../lib/conversationSections'
import SchemeSelector from './SchemeSelector'
import {DRAWER_WIDTH, ProjectGroupDrawer} from './ProjectGroupDrawer'
import {Folders} from 'lucide-react'
import {ConversationSectionHeader} from './ConversationSectionHeader'
import {SIDEBAR_MENU_GROUPS, type SidebarMenuItem} from './sidebar/menuItems'
import CopyToast from './common/CopyToast'
import {formatShortcut} from './common/Kbd'
import type {ConversationSummary, ThemeName} from '@shared/types'

type SystemStatus =
    'initializing'
    | 'missing_model'
    | 'missing_scheme'
    | 'no_workspace'
    | 'no_conversation'
    | 'ready'
    | 'working'

/** 从 store 派生系统状态 */
function useSystemStatus(): {status: SystemStatus; runningCount: number; runningConvIds: string[]} {
    const hasRehydrated = useModelSchemeStore((s) => s.hasRehydrated)
    const llmHasRehydrated = useLLMStore((s) => s.hasRehydrated)
    const providers = useLLMStore((s) => s.providers)
    const schemes = useModelSchemeStore((s) => s.schemes)
    const activeSchemeId = useModelSchemeStore((s) => s.activeSchemeId)
    const agentStatus = useAgentStore((s) => s.agentState.status)
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const convAgentStates = useAgentStore((s) => s.convAgentStates)

    // 运行中会话 id 列表：计数与「运行中会话」浮层共用同一份聚合，避免口径漂移
    // （判定与 ConversationItem 的 isRunning 一致：running / thinking）
    const runningConvIds = useMemo(
        () => Object.keys(convAgentStates).filter((cid) => {
            const st = convAgentStates[cid]?.agentState?.status
            return st === 'running' || st === 'thinking'
        }),
        [convAgentStates],
    )
    const runningCount = runningConvIds.length

    let status: SystemStatus
    if (!hasRehydrated || !llmHasRehydrated) status = 'initializing'
    else if (providers.length === 0) status = 'missing_model'
    else if (schemes.length === 0 || activeSchemeId === null) status = 'missing_scheme'
    else if (!currentWorkspacePath) status = 'no_workspace'
    else if (!activeConversationId) status = 'no_conversation'
    else if (agentStatus === 'thinking' || agentStatus === 'running' || runningCount > 0) status = 'working'
    else status = 'ready'

    return {status, runningCount, runningConvIds}
}

/* ─── System Status Indicator ─── */

const STATUS_CONFIG: Record<SystemStatus, { label: string; colorClass: string; dotClass: string }> = {
    initializing: {
        label: '初始化...',
        colorClass: 'text-[var(--warning)]',
        dotClass: 'bg-[var(--warning)] animate-pulse',
    },
    missing_model: {
        label: '缺少模型配置',
        colorClass: 'text-[var(--error)]',
        dotClass: 'bg-[var(--error)]',
    },
    missing_scheme: {
        label: '缺少方案配置',
        colorClass: 'text-[var(--error)]',
        dotClass: 'bg-[var(--error)]',
    },
    no_workspace: {
        label: '请选择项目',
        colorClass: 'text-[var(--warning)]',
        dotClass: 'bg-[var(--warning)]',
    },
    no_conversation: {
        label: '请创建一个会话',
        colorClass: 'text-[var(--warning)]',
        dotClass: 'bg-[var(--warning)]',
    },
    ready: {
        label: '系统已就绪',
        colorClass: 'text-[var(--success)]',
        dotClass: 'bg-[var(--success)]',
    },
    working: {
        label: '工作中...',
        colorClass: 'text-[var(--text-brand)]',
        dotClass: 'bg-[var(--brand-primary)] animate-pulse',
    },
}

/* ─── Init Phase Indicator ─── */

/** 初始化阶段文案（动词） */
const INIT_STAGE_LABELS: Record<string, string> = {
    plugin: '扫描插件',
    agent: '加载 Agent',
    skill: '加载技能',
    command: '加载命令',
    mcp: '连接 MCP',
}

/** 读取启动能力初始化阶段文案（纯展示，不改动 status 判定）；无阶段返回 null */
function useInitPhase(): string | null {
    const active = useInitProgressStore((s) => s.active)
    const stage = useInitProgressStore((s) => s.stage)
    const done = useInitProgressStore((s) => s.done)
    const total = useInitProgressStore((s) => s.total)

    if (!active || !stage) return null

    const verb = INIT_STAGE_LABELS[stage] || ''
    // 有分母显示 done/total；无分母补省略号——「加载技能」这类纯动词短语看起来
    // 像已结束的静态文案，加省略号才有「进行中」的语感。
    // 省略号沿用 STATUS_CONFIG 的写法（'初始化...' / '工作中...'），保持同款视觉。
    return total > 0 ? `${verb} ${done}/${total}` : `${verb}...`
}

/* ─── Running Sessions Popover ─── */

/** 运行中会话的一条展示记录：会话元数据跨工作区解析后的视图 */
interface RunningSessionEntry {
    id: string
    title: string
    channel?: string
    pinned?: boolean
    updatedAt: number
    /** 所属工作目录；本地缓存未命中时为 null（此时不切目录，仅激活会话） */
    workspacePath: string | null
}

/** 跨工作区按 convId 定位会话元数据（store 中会话按工作目录 path 分组存放） */
function findConvAcrossWorkspaces(
    workspaces: Record<string, {conversations: ConversationSummary[]}>,
    convId: string,
): {conv: ConversationSummary; workspacePath: string} | null {
    for (const [workspacePath, ws] of Object.entries(workspaces)) {
        const conv = ws.conversations.find((c) => c.id === convId)
        if (conv) return {conv, workspacePath}
    }
    return null
}

/**
 * 「工作中... (N个会话)」点击后向上展开的运行中会话列表。
 * 定位与关闭逻辑对齐 SidebarGearMenu（同在 footer、同样必须向上弹出以免被视口底边裁剪），
 * 进出场动画复用 lib/motionPresets 的 popoverUp。
 * 点击某一行 → 跳转到该会话；跨工作目录时先切目录（复用 sendToConversation 的路径）。
 */
function RunningSessionsPopover({open, anchorRef, convIds, onClose}: {
    open: boolean
    anchorRef: RefObject<HTMLDivElement | null>
    convIds: string[]
    onClose: () => void
}) {
    const workspaces = useConversationStore((s) => s.workspaces)
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const panelRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState<{bottom: number; left: number} | null>(null)

    // 运行中会话 → 展示视图（标题 / 渠道图标 / 所属目录），最近更新的排前面
    const entries = useMemo<RunningSessionEntry[]>(() => convIds.map((id) => {
        const hit = findConvAcrossWorkspaces(workspaces, id)
        return hit
            ? {
                id,
                title: hit.conv.title,
                channel: hit.conv.channel,
                pinned: hit.conv.pinned,
                updatedAt: hit.conv.updatedAt,
                workspacePath: hit.workspacePath,
            }
            : {id, title: '未命名会话', updatedAt: 0, workspacePath: null}
    }).sort((a, b) => b.updatedAt - a.updatedAt), [convIds, workspaces])

    // 向上展开：bottom = 视口底 - 锚点顶 + 间距
    useEffect(() => {
        if (!open) return
        const rect = anchorRef.current?.getBoundingClientRect()
        if (rect) setPos({bottom: window.innerHeight - rect.top + 6, left: rect.left})
    }, [open, anchorRef])

    // 点击外部关闭（mousedown 判定，与 SidebarGearMenu 一致）
    useEffect(() => {
        if (!open) return
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (anchorRef.current?.contains(target)) return
            if (panelRef.current?.contains(target)) return
            onClose()
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [open, anchorRef, onClose])

    // Esc 关闭
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [open, onClose])

    /** 跳转：跨工作目录先切目录，再激活会话 */
    const handleJump = useCallback(async (entry: RunningSessionEntry) => {
        onClose()
        const store = useConversationStore.getState()
        const switchingWorkspace = !!entry.workspacePath && entry.workspacePath !== store.currentWorkspacePath
        if (switchingWorkspace) {
            // 与 sendToConversation 同款跨目录路径：setWorkspace 会同时持久化主进程当前工作区。
            // 但它会把该目录首个根会话置为活跃（内部水合是 fire-and-forget，conversationStore.ts:669）——
            // 目标恰是首个根会话时 setActiveConversation 会幂等短路，跳过消息合并与 agent 状态同步，
            // 运行中会话只会显示 DB 半成品快照。故此处必须 force 重走完整切换。
            await store.setWorkspace(entry.workspacePath!)
            await store.setActiveConversation(entry.id, {force: true})
        } else {
            // 同目录：目标本就是当前会话时 setActiveConversation 幂等短路（no-op），
            // 绝不能再补水合——DB 快照会覆盖内存中正在流式的内容
            await store.setActiveConversation(entry.id)
        }
    }, [onClose])

    return createPortal(
        <AnimatePresence>
            {open && pos && (
                <motion.div
                    ref={panelRef}
                    {...popoverUp}
                    transition={{duration: 0.15}}
                    style={{bottom: pos.bottom, left: pos.left}}
                    className="fixed z-[9999] w-[260px] max-h-[60vh] overflow-y-auto py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md shadow-lg"
                    role="dialog"
                    aria-label="运行中会话"
                    data-name="running-sessions-popover"
                >
                    <div className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-[var(--text-secondary)]">运行中会话</div>
                    {entries.map((entry) => {
                        const isActive = entry.id === activeConversationId
                        const crossWorkspace = !!entry.workspacePath && entry.workspacePath !== currentWorkspacePath
                        return (
                            <button key={entry.id} type="button"
                                    onClick={() => void handleJump(entry)}
                                    title={entry.workspacePath ?? undefined}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-muted)] transition-colors"
                                    data-name="running-sessions-item">
                                <span className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center ${isActive ? '[color:var(--brand-primary)]' : 'text-[var(--text-muted)]'}`}>
                                    <SessionIcon channel={entry.channel} pinned={entry.pinned} isActive={isActive}/>
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className={`block truncate text-xs ${isActive ? 'text-[var(--text-brand)] font-medium' : 'text-[var(--text-secondary)]'}`}>{entry.title}</span>
                                    {crossWorkspace && (
                                        <span className="block truncate text-[10px] text-[var(--text-secondary)]">{getBasename(entry.workspacePath!)}</span>
                                    )}
                                </span>
                                {entry.updatedAt > 0 && (
                                    <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{getRelativeTime(entry.updatedAt)}</span>
                                )}
                            </button>
                        )
                    })}
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    )
}

function SystemStatusIndicator() {
    const {status, runningCount, runningConvIds} = useSystemStatus()
    const initPhaseLabel = useInitPhase()
    const anchorRef = useRef<HTMLDivElement>(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const closeMenu = useCallback(() => setMenuOpen(false), [])

    // 渲染优先级：working > 初始化阶段 > 常规系统状态
    const showInitPhase = status !== 'working' && initPhaseLabel !== null
    const {label, colorClass, dotClass} = showInitPhase
        ? {...STATUS_CONFIG.initializing, label: initPhaseLabel}
        : STATUS_CONFIG[status]
    const displayLabel = status === 'working' && runningCount > 0
        ? `${label} (${runningCount}个会话)`
        : label

    // 有会话在跑 → 提示可点击，展开运行中会话列表
    const clickable = runningCount > 0

    // 会话全部结束 / 状态切走时收起浮层，避免浮层停留在空列表
    useEffect(() => {
        if (!clickable) setMenuOpen(false)
    }, [clickable])

    return (
        <>
            <div ref={anchorRef} className="flex items-center gap-[var(--space-snug)] text-2xs text-[var(--text-muted)]"
                 title={clickable ? undefined : label}>
                <div className={`w-1.5 h-1.5 rounded-full ${dotClass}`} aria-hidden="true"/>
                {clickable ? (
                    <button type="button"
                            onClick={() => setMenuOpen((v) => !v)}
                            aria-haspopup="dialog"
                            aria-expanded={menuOpen}
                            title="查看运行中的会话"
                            className={`${colorClass} cursor-pointer rounded-sm hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)]`}
                            data-name="running-sessions-trigger">
                        {displayLabel}
                    </button>
                ) : (
                    <span className={colorClass}>{displayLabel}</span>
                )}
            </div>
            <RunningSessionsPopover open={menuOpen} anchorRef={anchorRef} convIds={runningConvIds} onClose={closeMenu}/>
        </>
    )
}

/** 打开侧边栏菜单项对应的窗口（齿轮菜单与折叠态图标共用） */
function openMenuItem(type: string): void {
    if (type === 'llm-call-logs') {
        window.electronAPI?.openLlmLogsWindow?.()
    } else if (type === 'usage-stats') {
        window.electronAPI?.openUsageStatsWindow?.()
    } else {
        window.electronAPI?.openConfigWindow?.(type)
    }
}

/** 渲染菜单项图标（复用 item.icon 的属性与子元素，仅调整尺寸） */
function MenuItemIcon({item, className}: {item: SidebarMenuItem; className: string}) {
    return <svg className={className} {...item.icon.props}>{item.icon.props.children}</svg>
}

/** 主题按钮 aria-label（展示下一档主题名，与图标联动） */
function themeNextLabel(theme: ThemeName): string {
    if (theme === 'yuanshandai') return '切换到十样锦模式'
    if (theme === 'shiyangjin') return '切换到浅色模式'
    if (theme === 'dark') return '切换到远山黛模式'
    return '切换到深色模式'
}

/** 主题专属图标（与旧 MenuBar 四档映射一致） */
function ThemeIcon({theme}: {theme: ThemeName}) {
    if (theme === 'shiyangjin') {
        return (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                {/* 十样锦图标 — 锦花 */}
                <path d="M12 3L21 12l-9 9-9-9z" opacity="0.6"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
        )
    }
    if (theme === 'yuanshandai') {
        return (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                {/* 远山黛图标 — 双峰山 */}
                <path d="M3 20L9 8l4 8 4-6 4 10h1"/>
            </svg>
        )
    }
    if (theme === 'dark') {
        return (
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                {/* 深色主题 — 月亮 */}
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
        )
    }
    return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {/* 浅色主题 — 太阳 */}
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
    )
}

/** 齿轮分组功能菜单（原 MenuBar 功能项，分组展示） */
function SidebarGearMenu({anchorRef}: {anchorRef: RefObject<HTMLDivElement | null>}) {
    const [isOpen, setIsOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)
    const hasUpdate = useUpdaterStore((s) => s.result?.status === 'update-available')
    const pluginHasUpdate = usePluginUpdateStore((s) => s.hasUpdate)
    const repoHasUpdate = useRepoUpdateStore((s) => s.hasUpdate)
    const mcpHasUpdate = useMcpUpdateStore((s) => s.hasUpdate)

    // 监听全局快捷键：单独按 Alt → 切换本菜单（见 useGlobalHotkeys.ts）
    useEffect(() => {
        const toggle = () => setIsOpen((v) => !v)
        window.addEventListener('hclaw:toggle-gear-menu', toggle)
        return () => window.removeEventListener('hclaw:toggle-gear-menu', toggle)
    }, [])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (anchorRef.current?.contains(target)) return
            if (menuRef.current && !menuRef.current.contains(target)) setIsOpen(false)
        }
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside)
            return () => document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [isOpen, anchorRef])

    const handleItemClick = (type: string) => {
        openMenuItem(type)
        setIsOpen(false)
    }

    const showUpdateDot = hasUpdate || pluginHasUpdate || repoHasUpdate || mcpHasUpdate

    // 空间检测：齿轮按钮位于 footer（窗口底部），向下弹出会被视口底边裁剪。
    // 下方剩余空间不足时改为向上弹出（bottom 定位），保证菜单完整可见。
    const gearMenuPortal = (() => {
        if (!isOpen) return null
        const anchorRect = anchorRef.current?.getBoundingClientRect()
        const spaceBelow = anchorRect ? window.innerHeight - anchorRect.bottom : 0
        const dropUp = spaceBelow < 320
        const menuStyle = anchorRect
            ? {
                left: anchorRect.left,
                ...(dropUp
                    ? {bottom: window.innerHeight - anchorRect.top + 4}
                    : {top: anchorRect.bottom + 4}),
            }
            : {left: 0, top: 4}
        return createPortal(
            <div ref={menuRef} className="fixed z-[9999] py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md shadow-lg min-w-[160px] max-h-[70vh] overflow-y-auto"
                 style={menuStyle}
                 onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} data-name="conversation-sidebar-div">
                {SIDEBAR_MENU_GROUPS.map((g, gi) => (
                    <div key={g.group} className={gi > 0 ? 'mt-1 border-t border-[var(--border-muted)]' : undefined}>
                        <div className="px-3 pt-2.5 pb-1 text-[10px] font-medium tracking-wide text-[var(--text-secondary)]">{g.group}</div>
                        {g.items.map((item) => (
                            <button key={item.type} onClick={() => handleItemClick(item.type!)}
                                    className="relative w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors" data-name="conversation-sidebar-button">
                                <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                                    <MenuItemIcon item={item} className="w-3.5 h-3.5"/>
                                </span>
                                <span>{item.label}</span>
                                {((item.type === 'about' && hasUpdate) || (item.type === 'plugins' && pluginHasUpdate) || (item.type === 'skills' && repoHasUpdate) || (item.type === 'mcp' && mcpHasUpdate)) && (
                                    <span className="ml-auto w-1.5 h-1.5 rounded-full bg-red-500" aria-label="有新版本"/>
                                )}
                            </button>
                        ))}
                    </div>
                ))}
            </div>,
            document.body,
        )
    })()

    return (
        <>
            <div ref={anchorRef} className="relative">
                <button
                    onClick={() => setIsOpen((v) => !v)}
                    aria-label="功能菜单"
                    aria-expanded={isOpen}
                    title="切换菜单 (Alt)"
                    className="icon-btn flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                 data-name="conversation-sidebar-menu-toggle-button">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        {/* 三横线菜单图标（hamburger）：功能菜单语义，比齿轮更符合大众习惯 */}
                        <line x1="3" y1="6" x2="21" y2="6"/>
                        <line x1="3" y1="12" x2="21" y2="12"/>
                        <line x1="3" y1="18" x2="21" y2="18"/>
                    </svg>
                    {showUpdateDot && (
                        <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-red-500" aria-label="有新版本" />
                    )}
                </button>
            </div>
            {gearMenuPortal}
        </>
    )
}

export default function ConversationSidebar() {
    const {leftCollapsed, setLeftCollapsed, toggleLeft, leftWidth, suppressLeftWidthAnimation, clearLeftWidthAnimationSuppress} = useSidebarStore()
    const {theme, toggleTheme} = useThemeStore()
    const viewScope = useConversationStore((s) => s.viewScope)
    const gearRef = useRef<HTMLDivElement>(null)

    // Ctrl+N → 新建会话。监听必须挂在**常驻**的本组件上：
    // 挂在 NewChatButton 内时，折叠侧栏 / 组视图下该按钮不渲染 → 监听不存在 → 快捷键静默失效。
    // 事件监听与顶部大按钮点击共用此 handler（唯一入口 = newConversation 服务）；
    // 创建成功后派发 focus-input 让 InputArea 聚焦（服务返回 null = 用户取消选目录 → 不派发）。
    const startNewConversation = useCallback(() => {
        void newConversation().then((id) => {
            if (id) window.dispatchEvent(new CustomEvent('hclaw:focus-input'))
        })
    }, [])

    useEffect(() => {
        window.addEventListener('hclaw:new-conversation', startNewConversation)
        return () => window.removeEventListener('hclaw:new-conversation', startNewConversation)
    }, [startNewConversation])

    // 拖拽提交宽度的那次渲染跳过 framer 宽度动画（元素已被手柄直改到终值；
    // 不跳过则 framer 从内部旧值重播动画 → 展开方向可见抖动）。下一帧恢复正常动画。
    useEffect(() => {
        if (suppressLeftWidthAnimation) clearLeftWidthAnimationSuppress()
    }, [suppressLeftWidthAnimation, clearLeftWidthAnimationSuppress])

  return (
      <div className="relative h-full flex shrink-0">
          {/* 侧边栏主体 */}
          {/* 宽度与 App.tsx 左栏卡片共用 leftWidth（拖拽调宽后两处一致；
              --sidebar-width 变量同时被右侧面板消费，这里不再依赖它） */}
          <motion.div
              initial={false}
              animate={{width: leftCollapsed ? 'var(--sidebar-collapsed-width, 36px)' : `${leftWidth}px`}}
              transition={suppressLeftWidthAnimation ? {duration: 0} : {duration: 0.2, ease: [0.4, 0, 0.2, 1]}}
              className="h-full flex flex-col overflow-hidden sidebar-shadow"
              data-name="conversation-sidebar-inner"
              role="navigation"
              aria-label="会话列表"
          >
              {/* 展开状态内容 */}
              {!leftCollapsed && (
                  <>
                      {/* Workspace dropdown */}
                      <div className="px-[var(--space-relaxed)] pt-[var(--space-relaxed)] pb-[var(--space-tight)]">
                          <WorkspaceSelector/>
                      </div>

                      {/* New conversation + Search */}
                      <div className="px-[var(--space-relaxed)] py-[var(--space-relaxed)] space-y-[var(--space-snug)]">
                          {/* 顶部大按钮仅单项目视图存在（组视图用段头「+」）；
                              viewScope 为 null（全新用户）时必须保留——那是选目录的唯一入口 */}
                          {viewScope?.type !== 'group' && <NewChatButton onClick={startNewConversation}/>}
                          <SearchInput/>
                      </div>

                      {/* Conversation list */}
                      <ConversationList/>

                      {/* Footer：状态行 + 全局控件行 */}
                      <footer className="px-[var(--space-relaxed)] py-[var(--space-snug)] border-t border-[var(--border-muted)] mt-auto">
                          <div className="status-row flex items-center justify-between gap-2">
                              <SystemStatusIndicator/>
                              <button
                                  onClick={toggleLeft}
                                  aria-label="折叠侧边栏"
                                  title={`折叠侧边栏 (${formatShortcut('Ctrl+B')})`}
                                  className="mini-toggle flex items-center justify-center w-[30px] h-[30px] rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                               data-name="conversation-sidebar-collapse-button">
                                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                      <polyline points="15 18 9 12 15 6"/>
                                  </svg>
                              </button>
                          </div>
                          <div className="tools-row flex items-center gap-[6px] mt-[var(--space-snug)]">
                              <SidebarGearMenu anchorRef={gearRef}/>
                              <div className="flex-1 min-w-0 flex justify-center">
                                  <SchemeSelector/>
                              </div>
                              <button
                                  onClick={toggleTheme}
                                  aria-label={themeNextLabel(theme)}
                                  title={`切换主题 (${formatShortcut('Ctrl+Shift+T')})`}
                                  className="icon-btn flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                               data-name="conversation-sidebar-theme-toggle-button">
                                  <ThemeIcon theme={theme}/>
                              </button>
                          </div>
                      </footer>
                  </>
              )}

                    {/* 折叠状态：全部菜单项（与齿轮菜单同源，从底部向上紧凑排列）+ 底部展开按钮
                        用户要求：全部选项全显示、从底部往上排；不显示「打开新项目」按钮 */}
                    {leftCollapsed && (
                        <div className="flex flex-col items-center h-full overflow-hidden">
                            <div data-name="sidebar-collapsed-icons" className="flex flex-col items-center justify-end gap-[var(--space-tight)] flex-1 min-h-0 overflow-y-auto w-full pt-[var(--space-tight)] pb-[8px]">
                                {SIDEBAR_MENU_GROUPS.flatMap((g) => g.items)
                                    .map((item) => (
                                        <button
                                            key={item.type}
                                           data-name="collapsed-item"
                                            onClick={() => openMenuItem(item.type!)}
                                            title={item.label}
                                            aria-label={item.label}
                                            data-tooltip-placement="right"
                                            className="relative flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                        >
                                            <MenuItemIcon item={item} className="w-3.5 h-3.5"/>
                                        </button>
                                    ))}
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); setLeftCollapsed(false) }}
                                aria-label="展开侧边栏"
                                className="flex items-center justify-center w-[26px] h-[26px] mb-[8px] mt-[4px] rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors z-10"
                             data-name="conversation-sidebar-expand-button">
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                    <polyline points="9 18 15 12 9 6"/>
                                </svg>
                            </button>
                        </div>
                    )}
          </motion.div>

          {/* 右侧边缘展开按钮（仅折叠状态显示） */}
          {leftCollapsed && (
              <button
                  onClick={(e) => {
                      e.stopPropagation();
                      setLeftCollapsed(false);
                  }}
                  aria-label="展开侧边栏"
                  className="absolute top-0 h-full flex items-center z-50"
                  style={{right: '-24px'}}
               data-name="conversation-sidebar-hover-expand-button">
                  <div
                      className="w-6 h-20 rounded-r flex items-center justify-center text-[var(--text-muted)] hover:[color:var(--brand-primary)] hover:bg-[var(--surface-muted)] transition-colors">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2.5">
                          <polyline points="9 18 15 12 9 6"/>
                      </svg>
                  </div>
              </button>
          )}
      </div>
  )
}

/* ─── Workspace Selector (Dropdown) ─── */

/** git 分支徽章（纯展示只读；branch 为 null 时不渲染） */
function GitBranchBadge({branch, className}: {branch: string | null, className?: string}) {
    if (!branch) return null
    return (
        <span
            className={`inline-flex items-center gap-0.5 min-w-0 flex-initial max-w-[130px] rounded-full bg-[var(--chip-bg)] border border-[var(--chip-border)] px-1.5 py-px text-[11px] font-medium text-gray-500 dark:text-gray-400 overflow-hidden ${className || ''}`}
            data-tooltip={branch}>
            <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" aria-hidden="true">
                {/* git branch 图标 */}
                <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/>
                <path d="M6 9v6M18 9a9 9 0 01-9 9"/>
            </svg>
            <span className="truncate">{branch}</span>
        </span>
    )
}

export function WorkspaceSelector() {
  const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
  const gitBranch = useConversationStore((s) => s.gitBranch)
  const viewScope = useConversationStore((s) => s.viewScope)
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (drawerRef.current?.contains(target)) return
      setIsOpen(false)
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [])

  const closeDrawer = () => {
    setIsOpen(false)
    setSearch('')
  }

  /**
   * 展开时锚定到左侧边栏卡片的右上角。
   * 动态读取卡片实际坐标（App.tsx 中 data-name="left-sidebar-card"，位于 TitleBar/MenuBar
   * 之下的 main 区内，含 px-2/py-2 内边距）——不硬编码偏移，随布局自适应。
   */
  const positionDrawer = () => {
    const drawerEl = drawerRef.current
    const card = ref.current?.closest<HTMLElement>('[data-name="left-sidebar-card"]')
    if (!drawerEl || !card) return
    const cardRect = card.getBoundingClientRect()
    const left = Math.min(cardRect.right, window.innerWidth - DRAWER_WIDTH - 10)
    const top = cardRect.top
    const maxHeight = Math.max(120, window.innerHeight - top - 12)
    drawerEl.style.left = `${left}px`
    drawerEl.style.top = `${top}px`
    drawerEl.style.maxHeight = `${maxHeight}px`
  }

  useEffect(() => {
    const onResize = () => { if (isOpen) positionDrawer() }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isOpen])

  // 触发按钮的无障碍名称（spec §3.2 / §6.1）：组视图附组名 + 成员数，其余（项目视图 / 无作用域）用基准串。
  const groups = useProjectGroupStore((s) => s.groups)
  const scopedGroup = viewScope?.type === 'group'
    ? groups.find((g) => g.id === viewScope.groupId) ?? null
    : null
  // 可见名称：组视图 = 组名（不再显示项目名/分支/路径 —— 组视图的语义是"看整组"，单项目信息会让用户误以为在看那个项目）；
  // 项目视图 / 无作用域 = 项目名（末段）或占位串。
  const displayName = scopedGroup
    ? scopedGroup.name
    : (currentWorkspacePath ? getBasename(currentWorkspacePath) : '切换项目 / 项目组')
  const groupScope = scopedGroup ? {name: scopedGroup.name, count: scopedGroup.members.length} : null
  const triggerLabel = scopedGroup
    ? `切换项目 / 项目组：${scopedGroup.name}（${scopedGroup.members.length} 个项目）`
    : '切换项目 / 项目组'

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center">
        <WorkspaceNameButton
          isOpen={isOpen}
          onToggle={() => {
            const next = !isOpen
            setIsOpen(next)
            if (next) requestAnimationFrame(positionDrawer)
          }}
          currentWorkspacePath={currentWorkspacePath}
          gitBranch={gitBranch}
          displayName={displayName}
          groupScope={groupScope}
          ariaLabel={triggerLabel}
        />
      </div>

      {isOpen && (
        <WorkspaceDrawerPortal key="workspace-drawer">
          <ProjectGroupDrawer
            drawerRef={drawerRef}
            search={search}
            setSearch={setSearch}
            onClose={closeDrawer}
          />
        </WorkspaceDrawerPortal>
      )}
    </div>
  )
}

/**
 * 抽屉的 portal 外壳：把内容挂到 body。
 *
 * 为什么必须 portal：`.bg-enabled` 下 `.app-surface-card`（左侧栏卡片）带 `backdrop-filter`，
 * 它会成为后代 `position: fixed` 元素的 containing block —— 抽屉的 `left/top` 是按视口坐标算的，
 * 一旦被卡片困住，既定位错位又被卡片的 `overflow-hidden` 裁掉。挂到 body 才脱离这层包含块。
 */
function WorkspaceDrawerPortal({children}: {children: ReactNode}) {
  return createPortal(children, document.body)
}

/** 工作目录名称按钮（展开/收起工作区切换抽屉） */
function WorkspaceNameButton({isOpen, onToggle, currentWorkspacePath, gitBranch, displayName, groupScope, ariaLabel}: {
  isOpen: boolean
  onToggle: () => void
  currentWorkspacePath: string | null
  gitBranch: string | null
  displayName: string
  groupScope: {name: string; count: number} | null
  ariaLabel: string
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      aria-label={ariaLabel}
      className="flex-1 min-w-0 flex items-center justify-between p-2 pl-1 rounded-xl hover:bg-[var(--surface-overlay)] transition-colors duration-200 group focus:outline-none focus:bg-[var(--surface-overlay)]"
      data-name="conversation-sidebar-workspace-select-button">
      <div className="flex items-center flex-1 min-w-0">
          <div className="flex flex-col items-start overflow-hidden text-left w-full">
          {groupScope ? (
              <div className="flex items-center justify-center gap-1.5 w-full min-w-0">
                  <span
                      className="font-semibold text-gray-900 dark:text-gray-100 text-[13px] tracking-tight truncate shrink-0 max-w-[65%]"
                      title={groupScope.name}>
                      {groupScope.name}
                  </span>
                  <span
                      className="inline-flex items-center gap-0.5 min-w-0 shrink-0 rounded-full bg-[var(--chip-bg)] border border-[var(--chip-border)] px-1.5 py-px text-[11px] font-medium text-gray-500 dark:text-gray-400"
                      data-name="workspace-group-count-badge"
                      title={`${groupScope.count} 个项目`}>
                      <Folders className="w-2.5 h-2.5 shrink-0" aria-hidden="true"/>
                      <span>{groupScope.count}</span>
                  </span>
              </div>
          ) : (
          <>
          {/* 名称行：项目名 + git 徽章同行流式排列，min-w-0 + truncate 溢出隐藏，不挤压右侧 › */}
          <div className="flex items-center gap-1.5 w-full min-w-0">
              <span
                  className={`font-semibold text-gray-900 dark:text-gray-100 text-[13px] tracking-tight truncate shrink-0 max-w-[65%] ${!currentWorkspacePath ? 'text-gray-400 dark:text-gray-500' : ''}`}
                  title={currentWorkspacePath || ''}>
                  {displayName}
              </span>
              {currentWorkspacePath && <GitBranchBadge branch={gitBranch}/>}
          </div>
          {currentWorkspacePath && (
              <span className="w-full min-w-0">
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 font-medium truncate block w-full">{currentWorkspacePath}</span>
              </span>
          )}
          </>
          )}
          </div>
      </div>
      <svg
          className={`w-4 h-4 shrink-0 transition-transform duration-200 ${isOpen ? 'text-gray-600 dark:text-[var(--text-muted)] rotate-180' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-[var(--text-muted)]'}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          {/* 向右箭头（>）；展开时 rotate-180 指向左，隐喻"抽屉从右侧展开/收回" */}
          <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  )
}

/* ─── New Chat Button ─── */

function NewChatButton({onClick}: {onClick: () => void}) {
  return (
    <button
      onClick={onClick}
      aria-label="新建对话"
      title={`新建会话 (${formatShortcut('Ctrl+N')})`}
      className="w-full flex items-center justify-center gap-2 py-2.5 bg-[var(--brand-ink)] dark:bg-[var(--chip-bg)] border border-transparent dark:border-[var(--border)] text-white dark:text-[var(--text-secondary)] rounded-[18px] text-[13px] font-medium hover:bg-[var(--brand-ink-hover)] dark:hover:bg-[var(--surface-overlay)] dark:hover:text-gray-100 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.18)] dark:shadow-none transition-all active:scale-[0.98] group"
     data-name="conversation-sidebar-new-button">
        <svg className="w-4 h-4 opacity-75 group-hover:opacity-100 dark:opacity-100 dark:text-gray-500 dark:group-hover:text-[var(--text-primary)] transition-opacity"
             viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span className="font-medium">新建对话</span>
    </button>
  )
}

/* ─── Search ─── */

function SearchInput() {
  const searchQuery = useConversationStore((s) => s.searchQuery)
  const setSearchQuery = useConversationStore((s) => s.setSearchQuery)
  return (
    <div className="relative group">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500 group-focus-within:text-gray-600 dark:group-focus-within:text-[var(--text-muted)] transition-colors"
             viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索对话..."
        aria-label="搜索对话"
        className={`w-full pl-9 pr-4 py-2 bg-[var(--surface-muted)] hover:bg-[var(--surface-overlay)] border border-[var(--border)] rounded-[36px] text-[13px] text-[var(--text-primary)] placeholder-[var(--text-secondary)] ${INPUT_FOCUS}`}
      data-name="conversation-sidebar-search-input"/>
    </div>
  )
}

/* ─── Conversation List ─── */

/**
 * 将会话 id 及其全部祖先加入集合（自近及远），返回集合引用。
 * convById 为会话 id→对象 映射，T 只需满足 parentConvId?: string 即可。
 */
function addSelfAndAncestors<T extends {parentConvId?: string}>(
    set: Set<string>,
    convById: Map<string, T>,
    id: string,
): Set<string> {
    let cur: string | null = id
    while (cur) {
        set.add(cur)
        cur = convById.get(cur)?.parentConvId || null
    }
    return set
}

import {buildRecentConversations} from '../lib/recentConversations'

export function ConversationList() {
    const getScopedSections = useConversationStore((s) => s.getScopedSections)
    const workspaces = useConversationStore((s) => s.workspaces)
    const viewScope = useConversationStore((s) => s.viewScope)
    // ★ I-2：getScopedSections 的段集合依赖 projectGroupStore.groups（组档按成员分段、
    //   解散/调序/拖入拖出都只改这个 store）→ 必须订阅并进 sections memo deps，
    //   否则停在组视图时抽屉里的这些操作不会让列表重算（列表陈旧）。
    const groups = useProjectGroupStore((s) => s.groups)
    const searchQuery = useConversationStore((s) => s.searchQuery)
    const collapsedGroupIds = useConversationStore((s) => s.collapsedGroupIds)
    const sectionWindowSizes = useConversationStore((s) => s.sectionWindowSizes)
    const singleViewWindowHintShown = useConversationStore((s) => s.singleViewWindowHintShown)
    const gitBranches = useConversationStore((s) => s.gitBranches)
    // ★ gitBranch：getScopedSections 对「当前项目」用它做分支回退（store line 890），
    //   故必须进下面 sections memo 的 deps。否则外部切分支时只有顶部 GitBranchBadge
    //   （直接订阅 gitBranch）更新，段头徽章停留在旧值（两处不一致）。
    const gitBranch = useConversationStore((s) => s.gitBranch)
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const pendingFocusProject = useConversationStore((s) => s.pendingFocusProject)
    const toggleSectionCollapsed = useConversationStore((s) => s.toggleSectionCollapsed)
    const expandSection = useConversationStore((s) => s.expandSection)
    const dismissWindowHint = useConversationStore((s) => s.dismissWindowHint)
    const clearFocusProject = useConversationStore((s) => s.clearFocusProject)
    const refreshVisibleBranches = useConversationStore((s) => s.refreshVisibleBranches)
    const [showCopyToast, flashCopyToast] = useTransientFlag(1500)
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        id: string;
        title: string;
        pinned?: boolean;
        parentConvId?: string;
    } | null>(null)
    const [renamingId, setRenamingId] = useState<string | null>(null)
    const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set())
    const listRef = useRef<HTMLDivElement>(null)

    // 监听全局点击以关闭菜单
    // ★ 注意：不监听 window 的 scroll 事件。原因见 tasks/01-context-menu-close.md：
    //   任何可滚动元素（包括 messageList 的消息列表容器）的自动滚动
    //   （新消息到达、流式内容跟随、初始化滚动到底部）都会向 window
    //   抛 scroll 事件。若在此处用捕获阶段监听 window scroll，
    //   会导致 messageList 刷新/追加消息时右键菜单被意外关闭。
    //   菜单关闭只由「点击外部」「右键」「Esc」触发，与消息数据更新解耦。
    useEffect(() => {
        if (!contextMenu) return
        const close = () => setContextMenu(null)
        window.addEventListener('click', close)
        window.addEventListener('contextmenu', close)
        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('contextmenu', close)
    }
    }, [contextMenu])

    // ★ 取数唯一入口 = getScopedSections（spec §5.3，Task 12 交付）。deps 必须覆盖它读取的
    //   全部 state —— 少了任一项（尤其 viewScope），「仅该项变化」时列表会陈旧：
    //   例：组视图内点其他成员项目的会话只动 viewScope，段集合却按旧值渲染。
    const sections = useMemo(
        () => getScopedSections(),
        [getScopedSections, workspaces, viewScope, searchQuery, collapsedGroupIds, sectionWindowSizes, gitBranches, gitBranch, currentWorkspacePath, groups],
    )

    // ★ 段路径签名 = 段集合的「项目路径集合」指纹。用它而不是 sections 数组身份来驱动
    //   effect：刷新 gitBranches 会重建 sections 对象（memo deps 含 gitBranches），
    //   但路径集合不变 → 以签名为 dep 的 effect 不会被重新触发，避免自激循环。
    const sectionsPathSignature = sections.map(s => s.projectPath).join('|')

    // ★ 组视图「最近会话」跨项目列表（spec §16 追加）：范围 = 组内成员项目（即当前
    //   sections 的项目段集合，复用 getScopedSections 的作用域口径）；排序 = updatedAt desc
    //   （与 §7.2 段内 createdAt 口径不同，见 recentConversations.ts 的注释）。
    //   只读启动时已全量在内存的摘要，不做任何消息预热（§10.2-1 禁组视图批量预热）。
    //   搜索态 / 非组视图 → 空数组（区块不渲染）。
    const recentConversations = useMemo(
        () => (viewScope?.type !== 'group' || searchQuery)
            ? []
            : buildRecentConversations(sections.map(s => ({
                workspacePath: s.projectPath,
                conversations: workspaces[s.projectPath]?.conversations ?? [],
            }))),
        [sections, workspaces, viewScope, searchQuery],
    )

    // ★ 段头分支徽章的批量来源（I-1）：gitBranches 此前无填充方（refreshVisibleBranches
    //   无调用点）。挂载与段集合变化时各跑一次；它只写 gitBranches、不改段集合 → 不重触发。
    useEffect(() => {
        void refreshVisibleBranches()
    }, [sectionsPathSignature, refreshVisibleBranches])

    // 单项目视图：只有一个段且不在组视图 → 段头不渲染 chevron 与「+」（§7.3）
    const singleProject = sections.length <= 1 && viewScope?.type !== 'group'

    // ★ rows 只带 {id, parentConvId, indentLevel, childCount}：渲染行时需按 id 从该段
    //   会话列表查回 ConversationSummary（与 store.getFilteredConversations 同口径）；
    //   查不到（缓存未加载）的行跳过，不崩。
    const rowById = useMemo(() => {
        const map = new Map<string, ConversationSection['rows'][number]>()
        for (const section of sections) for (const row of section.rows) map.set(row.id, row)
        return map
    }, [sections])

    // ★ 预计算 parentId → childIds 映射（子会话祖先链判断 + 父会话运行脉冲共用）
    const childIdsMap = useMemo(() => {
        const map = new Map<string, string[]>()
        for (const section of sections) for (const row of section.rows) {
            if (!row.parentConvId) continue
            map.set(row.parentConvId, [...(map.get(row.parentConvId) ?? []), row.id])
        }
        return map
    }, [sections])

    // ★ 新子会话自动展开父级：检测 childIdsMap 变化，新出现的子会话 → 展开其父会话
    //   注意：prevChildrenRef 初始为 null，首次渲染跳过（避免启动时把所有父会话展开一轮，
    //   覆盖掉「激活会话展开」逻辑）；后续变化时只展开真正新增的子会话的父级。
    //   同时沿 parentConvId 链向上展开所有祖先，确保二级子会话出现时其父（一级子会话）
    //   与其祖父（主会话）都处于展开态，侧栏才能完整显示嵌套树。
    const prevChildrenRef = useRef<Map<string, Set<string>> | null>(null)

    // ★ I-2：折叠/展开或「···」增长窗口会改变段内行集——折叠态 rows 为空 → childIdsMap
    //   塌缩；展开时这些父会话会被下方 effect 误判为「新子会话出现」，从而自动展开它们
    //   及其全部祖先。折叠集合 / 段窗口变化时清空记录，下一轮重新记录（不误判为新增）。
    //   本 effect 必须声明在下方「新子会话自动展开」effect 之前（React 按声明顺序执行）。
    useEffect(() => {
        prevChildrenRef.current = null
    }, [collapsedGroupIds, sectionWindowSizes])

    useEffect(() => {
        const current = new Map<string, Set<string>>()
        for (const [parentId, childIds] of childIdsMap) {
            current.set(parentId, new Set(childIds))
        }
        const prev = prevChildrenRef.current
        if (prev) {
            // 查找新增的子会话
            for (const [parentId, childIds] of current) {
                const prevIds = prev.get(parentId) || new Set<string>()
                for (const cid of childIds) {
                    if (!prevIds.has(cid)) {
                        // 新子会话出现 → 展开其父会话及其所有祖先
                        setExpandedParentIds(prevSet =>
                            addSelfAndAncestors(new Set(prevSet), rowById, parentId))
                        break
                    }
                }
            }
        }
        prevChildrenRef.current = current
    }, [childIdsMap])

    // ★ handleParentClick 必须在早期 return 之前声明（React Hooks 规则）
    // expandedParentIds: 已展开的父会话 ID 集合（空 = 所有父会话子会话折叠）。
    // 点击父会话在集合中切换展开/折叠；激活子会话时自动展开其全部祖先（见下方 effect）。
    const handleParentClick = useCallback((convId: string, isCurrentlyActive: boolean, activeChildOfThisParent: boolean) => {
        setExpandedParentIds(prev => {
            // 当前选中该父会话 OR 当前激活的是其子会话 → 不折叠，保持展开
            if (isCurrentlyActive || activeChildOfThisParent) {
                if (prev.has(convId)) return prev
                return new Set(prev).add(convId)
            }
            const next = new Set(prev)
            if (next.has(convId)) next.delete(convId)
            else next.add(convId)
            return next
        })
    }, [])

    // ★ 当 activeConversationId 变化时自动管理 expandedParentIds
    //    handleParentClick 仅处理父会话点击的展开/折叠切换；
    //    此 effect 负责子会话和独立会话场景的展开/折叠。
    //    只依赖 activeConversationId：用户手动折叠当前父会话不会触发本 effect（依赖不变），
    //    因此「激活的父会话始终展开其子会话」不会覆盖用户的手动折叠。
    //    ★ 同一时刻只允许一个父会话分支展开：新展开集合 = active 的祖先链 ∪ { active 自身（若有子） }，
    //    其余父会话一律折叠 —— 修复「父会话 A ↔ B 切换时旧父会话不折叠」的问题。
    useEffect(() => {
        if (!activeConversationId) return
        const activeRow = rowById.get(activeConversationId)
        if (!activeRow) return

        setExpandedParentIds(prev => {
            // 需要保持展开的父级：active 的祖先链 + active 自身（若其有子会话）
            const keep = new Set<string>()
            if (activeRow.parentConvId) {
                addSelfAndAncestors(keep, rowById, activeRow.parentConvId)
            }
            if (childIdsMap.has(activeRow.id)) {
                keep.add(activeRow.id)
            }

            // 折叠不在 keep 内的父会话，并确保 keep 内的父会话均展开
            const next = new Set<string>()
            for (const id of prev) {
                if (keep.has(id)) next.add(id)
            }
            for (const id of keep) {
                next.add(id)
            }
            return next
        })
    }, [activeConversationId])

    // ★ §15.1①「定位该项目段」：pendingFocusProject 变化时把对应段滚入视野并复位。
    //   段 key = projectPath（与 toggleSectionCollapsed 的入参口径一致）。
    //   ★ I-4：只在命中段时才 clearFocusProject —— 未命中说明该段尚未出现（典型：抽屉层 2
    //   「添加项目」只登记不切视图，该键还没进 workspaces），此时复位会让请求永久丢失。
    //   deps 含段路径签名 → 段稍后出现时仍会重试定位。
    useEffect(() => {
        if (!pendingFocusProject) return
        const el = listRef.current?.querySelector(`[data-project-path="${CSS.escape(pendingFocusProject)}"]`)
        if (!el) return
        el.scrollIntoView?.({block: 'nearest'})
        clearFocusProject()
    }, [pendingFocusProject, sectionsPathSignature, clearFocusProject])

    if (sections.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-[var(--space-loose)] text-center">
                <div
                    className="w-12 h-12 rounded-lg bg-[var(--surface-muted)] flex items-center justify-center mb-4 opacity-40">
                    <svg className="w-6 h-6 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.5">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                    </svg>
            </div>
                <p className="text-xs text-[var(--text-secondary)]">选择项目或项目组</p>
          </div>
        )
    }

    /**
     * 渲染一个段的行集。
     * · rows 顺序 = 段内最终顺序（置顶优先 → createdAt desc，由 buildConversationSections 保证）
     * · 子会话仅当「其全部祖先都展开」时才显示（沿用既有 groupByParent 的祖先链语义）
     * · 行内元素与动效一律不动（spec §7.3）
     */
    function renderSectionRows(section: ConversationSection) {
        const convs = workspaces[section.projectPath]?.conversations ?? []
        const byId = new Map(convs.map(c => [c.id, c]))
        return section.rows.map(row => {
            // 祖先链未全部展开 → 隐藏该子树
            let cur = row.parentConvId || null
            while (cur) {
                if (!expandedParentIds.has(cur)) return null
                cur = rowById.get(cur)?.parentConvId || null
            }
            // 段窗口内查不到摘要（会话缓存未加载）→ 跳过整行，不中断渲染
            const conv = byId.get(row.id)
            if (!conv) return null
            return (
                <ConversationItem
                    key={conv.id}
                    id={conv.id}
                    title={conv.title}
                    timestamp={conv.createdAt ?? conv.updatedAt}
                    pinned={conv.pinned}
                    channel={conv.channel}
                    status={conv.status}
                    indentLevel={row.indentLevel}
                    childCount={row.childCount}
                    childIds={childIdsMap.get(conv.id)}
                    onParentClick={row.childCount > 0 ? handleParentClick : undefined}
                    isRenaming={renamingId === conv.id}
                    onStopRename={() => setRenamingId(null)}
                    onOpenMenu={(x, y) => setContextMenu({x, y, id: conv.id, title: conv.title, pinned: conv.pinned, parentConvId: conv.parentConvId})}
                />
            )
        })
    }

    return (
        <div
            ref={listRef}
            className="flex-1 overflow-y-auto px-[var(--space-relaxed)] py-[var(--space-tight)] scrollbar-thin relative space-y-3"
        >
            {sections.map(section => (
                <section key={section.key} data-name="conversation-section" data-project-path={section.projectPath}>
                    <ConversationSectionHeader
                        section={section}
                        singleProject={singleProject}
                        onToggleCollapsed={() => toggleSectionCollapsed(section.key)}
                        onOpenProjectManager={() => window.electronAPI?.projectManager?.openProjectManager(section.projectPath)}
                        onNewConversation={() => void newConversation({workspacePath: section.projectPath, stayInScope: true})}
                    />
                    {!section.collapsed && <div className="space-y-0.5">{renderSectionRows(section)}</div>}
                    {!section.collapsed && section.rows.length === 0 && (
                        <p className="px-2 py-1 text-[11px] text-[var(--text-secondary)]">暂无会话</p>
                    )}
                    {/* §15.1⑤ 单项目视图窗口化是「无截断全量列表 → 10 条 + ···」的可感知行为变更：
                        一次性小字提示（只由点击「···」置位，此后不再出现）。
                        说明文案用 --text-secondary（globals.css 的 muted 用途契约：muted 为 AA 豁免档） */}
                    {!section.collapsed && section.hasMore && singleProject && !singleViewWindowHintShown && (
                        <p data-name="single-view-window-hint" className="px-2 pb-1 text-2xs text-[var(--text-secondary)]">
                            列表已按项目分页展示，点 ··· 可加载更多会话
                        </p>
                    )}
                    {!section.collapsed && section.hasMore && (
                        <button
                            data-name="section-show-more"
                            title="加载更多"
                            aria-label="加载更多会话"
                            onClick={() => { expandSection(section.key); if (singleProject) dismissWindowHint() }}
                            className="w-full py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                        >···</button>
                    )}
                </section>
            ))}

            {/* 组视图「最近会话」区块：上下双区结构的下半区（上半区 = 组内项目分段）。
                仅组视图 + 非搜索态 + 结果非空时渲染；行复用 ConversationItem ——
                运行脉冲 / 待确认徽章 / hover 行为全部免费继承。
                ★ 组视图下 ConversationItem 的 hover 预热本就禁用（hoverPreloadAllowed
                = viewScope?.type !== 'group'，见 ConversationItem :1466-1467），最近列表
                行也在组视图内渲染 → 自动免预热，符合 §10.2-1。 */}
            {recentConversations.length > 0 && (
                <div
                    data-name="sidebar-recent-section"
                    className="border-t border-[var(--border-muted)] pt-[var(--space-tight)]"
                >
                    {/* 轻量节头（不带段头操作位，故不用 ConversationSectionHeader） */}
                    <div
                        data-name="sidebar-recent-header"
                        className="flex items-center gap-1.5 px-2 pb-1 text-[11px] text-[var(--text-secondary)]"
                    >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        最近会话
                    </div>
                    <div className="space-y-0.5">
                        {recentConversations.map(({conv, workspacePath}) => (
                            <ConversationItem
                                key={`recent-${conv.id}`}
                                id={conv.id}
                                title={conv.title}
                                // 最近使用语义：时间戳用 updatedAt（段内行用 createdAt，见 §7.2）
                                timestamp={conv.updatedAt ?? conv.createdAt}
                                pinned={conv.pinned}
                                channel={conv.channel}
                                status={conv.status}
                                projectLabel={getBasename(workspacePath)}
                                isRenaming={false}
                                onStopRename={() => {}}
                                onOpenMenu={(x, y) => setContextMenu({x, y, id: conv.id, title: conv.title, pinned: conv.pinned, parentConvId: conv.parentConvId})}
                                onOpen={(convId) => {
                                    // 跨项目跳转走标准入口：非当前项目时同步 currentWorkspacePath +
                                    // setActiveConversation + 消息水合。与 MemoPanel 的跳转按钮同口径。
                                    // ★ follow 仅在非组视图时开启：组视图内点击最近会话是「组内换会话」，
                                    //   不得写 viewScope（否则被踢出组视图，违反 store 的跟随矩阵分工）。
                                    void useConversationStore.getState().openConversationInWorkspace(convId, workspacePath, {follow: viewScope?.type !== 'group'})
                                }}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* 统一的全局右键菜单 */}
            <AnimatePresence>
                {contextMenu && (
                    <GlobalContextMenu
                        {...contextMenu}
                        onClose={() => setContextMenu(null)}
                        onStartRename={(id) => {
                            setRenamingId(id)
                            setContextMenu(null)
                        }}
                        onCopyId={async (id) => {
                            setContextMenu(null)
                            try {
                                await navigator.clipboard.writeText(id)
                                flashCopyToast()
                            } catch { /* clipboard unavailable */ }
                        }}
                    />
                )}
            </AnimatePresence>
            <CopyToast visible={showCopyToast}/>
        </div>
    )
}

// ── 右键菜单布局常量 ──
// 5 个按钮 + 分隔线；dev 模式下多一个"复制会话 ID"，按 6 个按钮估算避免底部溢出
const CONTEXT_MENU_HEIGHT = 320
const CONTEXT_MENU_WIDTH = 180
// 菜单项通用样式；删除按钮叠加 error 变体
const MENU_ITEM_CLASS = 'w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors'

function GlobalContextMenu({x, y, id, title, pinned, parentConvId, onClose, onStartRename, onCopyId}: {
    x: number; y: number; id: string; title: string; pinned?: boolean; parentConvId?: string;
    onClose: () => void; onStartRename: (id: string) => void; onCopyId: (id: string) => void
}) {
    const deleteConversation = useConversationStore((s) => s.deleteConversation)
    const togglePinConversation = useConversationStore((s) => s.togglePinConversation)

    // 边界检测：确保菜单在视口内
    const adjustedX = Math.min(x, window.innerWidth - CONTEXT_MENU_WIDTH - 10)
    const adjustedY = y + CONTEXT_MENU_HEIGHT > window.innerHeight
        ? Math.max(10, window.innerHeight - CONTEXT_MENU_HEIGHT - 10)
        : y

    // 阻止事件冒泡并关闭菜单，避免菜单的全局点击/滚动监听器干扰后续弹窗
    const stopAndClose = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
    }

    const handleDeleteClick = async (e: React.MouseEvent) => {
        stopAndClose(e)
        // 计算后代子会话数（含间接后代），用于删除确认文案。
        // ★ I-1(b)：按**会话自身所属项目**展开 —— 组视图下右键的对象可能不属于
        //   currentWorkspacePath；按当前项目算会把文案说成 0 个子会话（实际连带删除）。
        const state = useConversationStore.getState()
        const home = findConvAcrossWorkspaces(state.workspaces, id)
        const allConvs = home ? state.workspaces[home.workspacePath]?.conversations ?? [] : []
        const descendants = collectDescendants(allConvs, [id])
        const childCount = descendants.length - 1
        // 使用 App 级别的 ConfirmDialog（在 App.tsx 顶层渲染），
        // 完全隔离于侧边栏的 AnimatePresence 和流式重渲染影响
        await confirm({
            title: '删除会话',
            message: childCount > 0
                ? `确定要删除"${title}"吗？\n该会话包含 ${childCount} 个子会话，将一并删除。\n此操作不可撤销。`
                : `确定要删除"${title}"吗？此操作不可撤销。`,
            confirmText: '确认删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                await deleteConversation(id)
            },
        })
    }

    const handleUsageStatsClick = (e: React.MouseEvent) => {
        stopAndClose(e)
        showUsageStats({convId: id, title})
    }

    return createPortal(
        <motion.div
            initial={{opacity: 0, scale: 0.95}}
            animate={{opacity: 1, scale: 1}}
            exit={{opacity: 0, scale: 0.95}}
            transition={{duration: 0.1}}
            style={{position: 'fixed', left: adjustedX, top: adjustedY, zIndex: 9999}}
            className="bg-[var(--surface)] border border-[var(--border-emphasis)] rounded-xl shadow-elevated py-1.5 min-w-[160px] ring-1 ring-black/5"
            role="menu"
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
        >
            {!parentConvId && (
            <button
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    togglePinConversation(id)
                }}
                className={MENU_ITEM_CLASS}
             data-name="conversation-sidebar-menu-pin-button">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'}
                     stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                </svg>
                {pinned ? '取消置顶' : '置顶会话'}
            </button>
            )}

            <button
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onStartRename(id)
                }}
                className={MENU_ITEM_CLASS}
             data-name="conversation-sidebar-menu-rename-button">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                重命名
            </button>

            <button
                onClick={handleUsageStatsClick}
                className={MENU_ITEM_CLASS}
             data-name="conversation-sidebar-menu-usage-stats-button">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="20" x2="18" y2="10"/>
                    <line x1="12" y1="20" x2="12" y2="4"/>
                    <line x1="6" y1="20" x2="6" y2="14"/>
                </svg>
                用量统计
            </button>

            <div className="my-1.5 h-px bg-[var(--border-muted)] mx-2"/>
            {/* 调试用：仅 dev / --devtools 启动时可见 */}
            {window.electronAPI?.isDevMode && (
            <button
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onCopyId(id)
                }}
                className={MENU_ITEM_CLASS}
             data-name="conversation-sidebar-menu-copy-id-button">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                复制会话 ID
            </button>
            )}
            <button
                onClick={handleDeleteClick}
                className={`${MENU_ITEM_CLASS} text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]`}
             data-name="conversation-sidebar-menu-delete-button">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
                删除会话
            </button>
        </motion.div>,
        document.body
    )
}

/** 待确认/权限确认徽章 */
function StatusBadge({type, children}: { type: 'error' | 'warning'; children: ReactNode }) {
    const pulseClass = type === 'error' ? 'animate-badge-pulse' : 'animate-badge-pulse-warning'
    return (
        <span
            className={`text-[9px] font-bold text-white leading-none px-[7px] py-[3px] rounded-[10px] ${pulseClass} flex-shrink-0`}
            style={{backgroundColor: `var(--${type})`}}>
            {children}
        </span>
    )
}

/* ─── Session Icon ─── */

/** 根据 channel 值渲染对应的会话图标 */
function SessionIcon({channel, pinned, isActive}: { channel?: string; pinned?: boolean; isActive: boolean }) {
    if (pinned) {
        return (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24"
                 fill={isActive ? 'currentColor' : 'none'}
                 stroke="currentColor" strokeWidth={isActive ? '0' : '2'}>
                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
            </svg>
        )
    }

    // 平台专属图标映射
    const ch = channel ?? ''
    switch (ch) {
        case 'wechat': {
            const colorClass = isActive ? '[color:var(--brand-primary)]' : 'text-[var(--text-muted)]'
            const opacityClass = isActive ? '' : 'opacity-60'
            return (
                <svg className={`w-[15px] h-[15px] ${colorClass} ${opacityClass}`} viewBox="0 0 24 24" fill="currentColor"
                     stroke="currentColor" strokeWidth="0.5">
                    {/* 微信风格双气泡 */}
                    <path
                        d="M8.5 3C4.36 3 1 5.8 1 9.25c0 1.82 1 3.44 2.62 4.56l-.66 1.99 2.34-1.17c.67.2 1.4.32 2.2.32.2 0 .4-.01.6-.02-.2-.53-.32-1.1-.32-1.68 0-3.15 2.73-5.75 6.22-5.75.2 0 .4.01.6.02C13.16 4.8 11.07 3 8.5 3z"/>
                    <path
                        d="M15.5 8C11.91 8 9 10.57 9 13.75S11.91 19.5 15.5 19.5c.62 0 1.22-.08 1.78-.23l2.52 1.23-.7-2.1C19.55 17.56 21 15.82 21 13.75 21 10.57 18.09 8 15.5 8z"/>
                </svg>
            )
        }
        case 'feishu': {
            const opacityClass = isActive ? '' : 'opacity-60'
            return (
                <svg className={`w-3.5 h-3.5 ${opacityClass}`} viewBox="0 0 24 24" fill={isActive ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {/* 飞书折纸/飞鸟轮廓 — 从 Feishu.exe 图标提取 */}
                    <path d="M4 2 Q7 2 10 8 Q11 10 12 12 Q12 14 10 14 Q7 14 5 12 Q2 9 0 8 Q0 9 0 19 Q2 21 5 21 Q9 21 11 21 Q15 21 17 18 Q19 16 21 12 Q23 9 23 8 Q23 7 21 7 Q19 7 18 7 Q16 5 15 2 Q11 1 4 2 Z"/>
                </svg>
            )
        }
        case 'schedule': {
            const colorClass = isActive ? '[color:var(--brand-primary)]' : 'text-[var(--text-muted)]'
            return (
                <svg className={`w-3.5 h-3.5 ${colorClass}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {/* 时钟图标 - 定时任务 */}
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                </svg>
            )
        }
        default: {
            // 默认聊天气泡 — 选中态用实心填充
            return (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24"
                     fill={isActive ? 'currentColor' : 'none'}
                     stroke="currentColor" strokeWidth={isActive ? '0' : '2.5'}>
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
            )
        }
    }
}

function ConversationItem({id, title, timestamp, isRenaming, onStopRename, onOpenMenu, pinned, channel, status, indentLevel, childCount, childIds, onParentClick, onOpen, projectLabel}: {
    id: string; title: string; timestamp: number;
    isRenaming: boolean; onStopRename: () => void;
    onOpenMenu: (x: number, y: number) => void;
    pinned?: boolean;
    channel?: string;
    status?: 'active' | 'running' | 'archived';
    indentLevel?: number;
    childCount?: number;
    childIds?: string[];
    onParentClick?: (convId: string, isActive: boolean, activeChildOfThisParent: boolean) => void;
    /** 覆盖默认点击行为（默认 setActiveConversation）：最近会话列表用它走 openConversationInWorkspace（跨项目跳转） */
    onOpen?: (convId: string) => void;
    /** 项目名 chip（仅最近会话列表传入；其他调用点不传 → 行为零变化） */
    projectLabel?: string;
}) {
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
    const updateConversationMeta = useConversationStore((s) => s.updateConversationMeta)
    /** ★ 组视图禁用 hover 预热（§10.2-1 本计划结论）：单项目视图下恒为 true */
    const hoverPreloadAllowed = useConversationStore((s) => s.viewScope?.type !== 'group')
    const convData = useAgentStore((s) => s.convAgentStates[id])
    const isActive = id === activeConversationId
    const [renameValue, setRenameValue] = useState(title)
    const preloadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    // 读取该会话的 agent 运行时状态（后台运行/待确认标记）
    const agentStatus = convData?.agentState?.status
    // ★ 检测子会话是否在运行中（用于父会话显示运行脉冲）
    const childRunningStates = useAgentStore((s) => {
        if (!childIds?.length) return false
        return childIds.some(cid => {
            const st = s.convAgentStates[cid]?.agentState?.status
            return st === 'running' || st === 'thinking'
        })
    })
    const isRunning = !isActive && (agentStatus === 'running' || agentStatus === 'thinking' || childRunningStates)
    const hasPendingQuestion = !!convData?.pendingQuestion
    const hasPermissionConfirm = !!convData?.pendingPermissionConfirm
    // ★ tools 变动门同样是「无限等待用户决策」的阻塞态：缺此标识时，后台会话被
    //   handleConvEvent 置为 paused（运行脉冲只认 running/thinking）→ 侧栏看起来
    //   完全空闲。去掉 120s 自动放行后，这是用户唯一的可发现线索。
    const hasToolsChangeConfirm = !!convData?.pendingToolsChangeConfirm
    const hasPending = hasPendingQuestion || hasPermissionConfirm || hasToolsChangeConfirm

    // 当外部触发重命名时，重置内部状态
    useEffect(() => {
        if (isRenaming) setRenameValue(title)
    }, [isRenaming, title])

    // 组件卸载时清除预加载定时器
    useEffect(() => {
        return () => clearTimeout(preloadTimerRef.current)
    }, [])

    const handleRenameConfirm = () => {
        const trimmed = renameValue.trim()
        if (trimmed && trimmed !== title) {
            updateConversationMeta(id, {title: trimmed})
        }
        onStopRename()
    }

    // ── hover 预加载（preloadConversation 内部已跳过已加载的） ──
    // ★ 组视图禁用 hover 预热（§10.2-1）：hover 路径预热的会话不受「每项目缓存池」约束的
    //   收益最小，而组视图项目段多、hover 概率高，逐个 hover 会破坏「键数不随项目数线性
    //   增长」。单项目视图行为不变（回归项）。
    const handleMouseEnter = useCallback(() => {
        if (!hoverPreloadAllowed) return
        clearTimeout(preloadTimerRef.current)
        preloadTimerRef.current = setTimeout(() =>
            useConversationStore.getState().preloadConversation(id), 300)
    }, [id, hoverPreloadAllowed])

    const handleMouseLeave = useCallback(() => {
        clearTimeout(preloadTimerRef.current)
    }, [])

    const hasChildren = (childCount || 0) > 0
    // ★ 当前激活的会话是否为此父会话的子会话（用于 handleParentClick 判断）
    const activeChildOfThisParent = hasChildren && !!childIds?.includes(activeConversationId || '')

    const handleClick = useCallback(() => {
        if (isRenaming) return
        if (onOpen) {
            // 最近会话列表的跨项目跳转入口：由调用方决定激活/跟随语义
            onOpen(id)
            return
        }
        if (hasChildren && onParentClick) {
            onParentClick(id, isActive, activeChildOfThisParent)
        }
        setActiveConversation(id)
    }, [isRenaming, onOpen, hasChildren, onParentClick, id, isActive, activeChildOfThisParent, setActiveConversation])

    // spec §7.3：选中态收窄为「轻底色 + 左侧 2px 品牌条」（去边框 / 去阴影 / 不再是胶囊圆角）
    const containerClass = [
        'group relative flex items-center justify-between gap-3 px-4 py-1.5 rounded-md transition-all cursor-pointer',
        isActive
            ? 'bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-[2px] before:rounded-full before:bg-[var(--brand-primary)]'
            : 'hover:bg-[var(--surface-muted)] active:bg-[var(--surface-overlay)]',
        hasPending && 'ring-1 ring-[color-mix(in_srgb,var(--error)_30%,transparent)]',
    ].filter(Boolean).join(' ')

    // 图标容器 w-5 h-5：行高密度收敛后（py-1.5）目标行高 ≈32px；子会话数徽章偏移随之微调保持视觉居中
    const iconContainerClass = `relative flex items-center justify-center w-5 h-5 rounded-md shrink-0 transition-colors ${
        isActive
            ? 'bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400'
            : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400'
    }`

    // 定时任务会话的运行状态
    const isSchedulerRunning = channel === 'schedule' && status === 'running'
    const showRunningPulse = isRunning || isSchedulerRunning

    return (
        <div
            onClick={handleClick}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenMenu(e.clientX, e.clientY)
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className={containerClass}
            style={indentLevel ? { paddingLeft: 16 + indentLevel * 16 } : undefined}
         data-name="conversation-sidebar-item-row">
            <div className={iconContainerClass}>
                {showRunningPulse && (
                    <div
                        className="absolute inset-[-3px] rounded-[10px] border-2 border-[var(--info)] animate-running-pulse pointer-events-none"/>
                )}
                {childCount !== undefined && childCount > 0 && (
                    <span
                        className={`absolute -left-1 -top-1 min-w-[16px] h-[16px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none px-[3px] z-20 pointer-events-none ${
                            showRunningPulse
                                ? 'bg-[var(--brand-primary)] text-white shadow-sm ring-1 ring-[var(--surface)]'
                                : 'bg-[var(--chip-bg)] text-[var(--text-secondary)] border border-[var(--chip-border)]'
                        }`}
                    >
                        {childCount}
                    </span>
                )}
                <SessionIcon
                    channel={channel}
                    pinned={pinned}
                    isActive={isActive}
                />
            </div>

            <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
                {isRenaming ? (
                    <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameConfirm()
                            if (e.key === 'Escape') onStopRename()
                        }}
                        onBlur={handleRenameConfirm}
                        onClick={(e) => e.stopPropagation()}
                        className={`flex-1 text-xs font-medium px-1.5 py-0.5 rounded border border-[var(--brand-primary)] bg-[var(--surface)] outline-none text-[var(--text-primary)] ${INPUT_FOCUS}`}
                    data-name="conversation-sidebar-rename-input"/>
                ) : (
                    <div
                        title={title}
                        className={`flex-1 min-w-0 truncate transition-colors text-[13px] ${isActive ? 'font-medium text-[var(--text-brand)]' : 'text-gray-600 dark:text-[var(--text-muted)] group-hover:text-gray-900 dark:group-hover:text-gray-100'}`}>
                        {title}
                    </div>
                )}
                {!isRenaming && projectLabel && (
                    // 项目名 chip（最近会话列表专用）：样式抄 MemoPanel 的 ProjectBadge
                    <span
                        data-name="recent-item-project-badge"
                        title={projectLabel}
                        className="inline-flex shrink-0 max-w-[6ch] truncate text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-overlay)] text-[var(--text-secondary)]"
                    >
                        {projectLabel}
                    </span>
                )}
                {!isRenaming && (
                    <>
                        {hasPendingQuestion && <StatusBadge type="error">待确认</StatusBadge>}
                        {hasPermissionConfirm && !hasPendingQuestion &&
                            <StatusBadge type="warning">权限确认</StatusBadge>}
                        {hasToolsChangeConfirm && !hasPendingQuestion && !hasPermissionConfirm &&
                            <StatusBadge type="warning">工具确认</StatusBadge>}
                        <div
                            className={`text-[11px] whitespace-nowrap shrink-0 transition-colors ${isActive ? 'font-medium text-[var(--text-brand)] opacity-70' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400'}`}>
                            {getRelativeTime(timestamp)}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
