import {type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'
import {useConversationStore} from '../stores/conversationStore'
import {useSidebarStore} from '../stores/sidebarStore'
import {getBasename, getRelativeTime} from '../lib/format'
import {useLLMStore} from '../stores/llmStore'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import {useAgentStore} from '../stores/agentStore'
import {fuzzyFilter} from '../lib/search'
import {confirm} from './ConfirmDialog'
import {showUsageStats} from './dialogs/UsageStatsDialog'
import {collectDescendants} from '../stores/conversationTree'
import {useThemeStore} from '../stores/themeStore'
import {useUpdaterStore} from '../stores/updaterStore'
import {usePluginUpdateStore} from '../stores/pluginUpdateStore'
import SchemeSelector from './SchemeSelector'
import {SIDEBAR_MENU_GROUPS, type SidebarMenuItem} from './sidebar/menuItems'

type SystemStatus =
    'initializing'
    | 'missing_model'
    | 'missing_scheme'
    | 'no_workspace'
    | 'no_conversation'
    | 'ready'
    | 'working'

/** 从 store 派生系统状态 */
function useSystemStatus(): {status: SystemStatus; runningCount: number} {
    const hasRehydrated = useModelSchemeStore((s) => s.hasRehydrated)
    const llmHasRehydrated = useLLMStore((s) => s.hasRehydrated)
    const providers = useLLMStore((s) => s.providers)
    const schemes = useModelSchemeStore((s) => s.schemes)
    const activeSchemeId = useModelSchemeStore((s) => s.activeSchemeId)
    const agentStatus = useAgentStore((s) => s.agentState.status)
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const convAgentStates = useAgentStore((s) => s.convAgentStates)

    const runningCount = Object.values(convAgentStates).filter(
        (d) => d.agentState.status === 'running' || d.agentState.status === 'thinking'
    ).length

    let status: SystemStatus
    if (!hasRehydrated || !llmHasRehydrated) status = 'initializing'
    else if (providers.length === 0) status = 'missing_model'
    else if (schemes.length === 0 || activeSchemeId === null) status = 'missing_scheme'
    else if (!currentWorkspacePath) status = 'no_workspace'
    else if (!activeConversationId) status = 'no_conversation'
    else if (agentStatus === 'thinking' || agentStatus === 'running' || runningCount > 0) status = 'working'
    else status = 'ready'

    return {status, runningCount}
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
        label: '请选择工作目录',
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
        colorClass: 'text-[var(--brand-primary)]',
        dotClass: 'bg-[var(--brand-primary)] animate-pulse',
    },
}

function SystemStatusIndicator() {
    const {status, runningCount} = useSystemStatus()

    const {label, colorClass, dotClass} = STATUS_CONFIG[status]
    const displayLabel = status === 'working' && runningCount > 0
        ? `${label} (${runningCount}个会话)`
        : label

    return (
        <div className="flex items-center gap-[var(--space-snug)] text-2xs text-[var(--text-muted)]" title={`${label}${runningCount > 0 ? ` · ${runningCount}个会话运行中` : ''}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${dotClass}`} aria-hidden="true"/>
            <span className={colorClass}>{displayLabel}</span>
        </div>
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

type ThemeName = 'light' | 'dark' | 'yuanshandai' | 'shiyangjin'

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

    const showUpdateDot = hasUpdate || pluginHasUpdate

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
                 onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                {SIDEBAR_MENU_GROUPS.map((g) => (
                    <div key={g.group}>
                        <div className="px-3 pt-2 pb-1 text-[10px] font-medium text-[var(--text-muted)]">{g.group}</div>
                        {g.items.map((item) => (
                            <button key={item.type} onClick={() => handleItemClick(item.type!)}
                                    className="relative w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors">
                                <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                                    <MenuItemIcon item={item} className="w-3.5 h-3.5"/>
                                </span>
                                <span>{item.label}</span>
                                {((item.type === 'about' && hasUpdate) || (item.type === 'plugins' && pluginHasUpdate)) && (
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
                    className="icon-btn flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                >
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
    const {leftCollapsed, setLeftCollapsed, toggleLeft} = useSidebarStore()
    const {theme, toggleTheme} = useThemeStore()
    const gearRef = useRef<HTMLDivElement>(null)

  return (
      <div className="relative h-full flex shrink-0">
          {/* 侧边栏主体 */}
          <motion.div
              initial={false}
              animate={{width: leftCollapsed ? 'var(--sidebar-collapsed-width, 36px)' : 'var(--sidebar-width)'}}
              transition={{duration: 0.2, ease: [0.4, 0, 0.2, 1]}}
              className="h-full flex flex-col overflow-hidden sidebar-shadow"
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
                          <NewChatButton/>
                          <SearchInput/>
                      </div>

                      {/* Conversation list */}
                      <ConversationList/>

                      {/* Footer：状态行 + 全局控件行 */}
                      <footer className="px-[var(--space-relaxed)] py-[var(--space-snug)] border-t border-[var(--border)] mt-auto">
                          <div className="status-row flex items-center justify-between gap-2">
                              <SystemStatusIndicator/>
                              <button
                                  onClick={toggleLeft}
                                  aria-label="折叠侧边栏"
                                  className="mini-toggle flex items-center justify-center w-[30px] h-[30px] rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                              >
                                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                      <polyline points="15 18 9 12 15 6"/>
                                  </svg>
                              </button>
                          </div>
                          <div className="tools-row flex items-center gap-[6px] mt-[var(--space-snug)]">
                              <SidebarGearMenu anchorRef={gearRef}/>
                              <div className="flex-1 min-w-0">
                                  <SchemeSelector/>
                              </div>
                              <button
                                  onClick={toggleTheme}
                                  aria-label={themeNextLabel(theme)}
                                  className="icon-btn flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                              >
                                  <ThemeIcon theme={theme}/>
                              </button>
                          </div>
                      </footer>
                  </>
              )}

                    {/* 折叠状态：全部菜单项（与齿轮菜单同源，从底部向上紧凑排列）+ 底部展开按钮
                        用户要求：18 个选项全显示、从底部往上排；不显示「打开新项目」按钮 */}
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
                            >
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
              >
                  <div
                      className="w-6 h-20 rounded-r flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--surface-muted)] transition-colors">
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

/** 工作区切换抽屉宽度（px） */
const DRAWER_WIDTH = 300

export function WorkspaceSelector() {
  const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
  const setWorkspace = useConversationStore((s) => s.setWorkspace)
  const workspaces = useConversationStore((s) => s.workspaces)
  const removeWorkspace = useConversationStore((s) => s.removeWorkspace)
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

  const workspaceList = Object.entries(workspaces).map(([path, info]) => ({
    path,
    lastOpenedAt: info.lastOpenedAt,
  })).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

    const filtered = fuzzyFilter(workspaceList, search, ['path'])

  const handleSelect = (path: string) => {
    setWorkspace(path)
    setIsOpen(false)
    setSearch('')
  }

  const handleOpenNew = async () => {
    const result = await window.electronAPI?.openFolderDialog?.()
    if (result) {
      setWorkspace(result)
    }
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

  const displayName = currentWorkspacePath ? getBasename(currentWorkspacePath) : '选择工作目录'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          const next = !isOpen
          setIsOpen(next)
          if (next) requestAnimationFrame(positionDrawer)
        }}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="选择工作目录"
        className="w-full flex items-center justify-between p-2 pl-2.5 -ml-2 rounded-xl hover:bg-gray-100/60 dark:hover:bg-white/5 transition-colors duration-200 group focus:outline-none focus:bg-gray-100/80 dark:focus:bg-white/10"
      >
          <div className="flex items-center gap-3 overflow-hidden w-[85%]">
              <div className="w-8 h-8 rounded-[10px] bg-white dark:bg-[#1E1E1E] border border-gray-200/80 dark:border-white/10 shadow-sm flex items-center justify-center shrink-0 group-hover:border-gray-300 dark:group-hover:border-white/20 transition-colors">
                  <svg className="w-4 h-4 text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors"
                       viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  </svg>
              </div>
              <div className="flex flex-col items-start overflow-hidden text-left w-full">
                  <span
                      className={`font-semibold text-gray-900 dark:text-gray-100 text-[13px] tracking-tight truncate w-full ${!currentWorkspacePath ? 'text-gray-400 dark:text-gray-500' : ''}`}
                      title={currentWorkspacePath || ''}>
                      {displayName}
                  </span>
                  {currentWorkspacePath && (
                      <span className="text-[11px] text-gray-400 dark:text-gray-500 font-medium truncate w-full">{currentWorkspacePath}</span>
                  )}
              </div>
          </div>
          <svg
              className={`w-4 h-4 shrink-0 transition-transform duration-200 ${isOpen ? 'text-gray-600 dark:text-gray-300 rotate-180' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300'}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              {/* 向右箭头（>）；展开时 rotate-180 指向左，隐喻"抽屉从右侧展开/收回" */}
              <polyline points="9 18 15 12 9 6"/>
          </svg>
      </button>

      {isOpen && (
        <WorkspaceDrawerPortal
          key="workspace-drawer"
          drawerRef={drawerRef}
          {...{ search, setSearch, filtered, handleSelect, handleOpenNew, removeWorkspace, currentWorkspacePath }}
        />
      )}
    </div>
  )
}

/** 工作区切换抽屉（portal 到 body 的悬浮面板，随开关即时挂载/卸载） */
function WorkspaceDrawerPortal({drawerRef, search, setSearch, filtered, handleSelect, handleOpenNew, removeWorkspace, currentWorkspacePath}: {
    drawerRef: RefObject<HTMLDivElement | null>
    search: string
    setSearch: (v: string) => void
    filtered: { path: string; lastOpenedAt: number }[]
    handleSelect: (path: string) => void
    handleOpenNew: () => void
    removeWorkspace: (path: string) => void
    currentWorkspacePath: string | null
}) {
    return createPortal(
        <motion.div
            ref={drawerRef}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{duration: 0.15}}
            className="fixed bg-[var(--surface)] border border-[var(--border-emphasis)] rounded-xl shadow-elevated overflow-hidden flex flex-col"
            style={{zIndex: 9999, width: DRAWER_WIDTH}}
            role="listbox"
            aria-label="工作目录列表"
        >
            {/* Search */}
              <div className="p-[var(--space-snug)] pt-[var(--space-loose)] border-b border-[var(--border-muted)]">
              <div className="relative">
                  <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-muted)]"
                       viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索目录..."
                  aria-label="搜索目录"
                  className="w-full pl-6 pr-2 py-1.5 text-2xs bg-[var(--surface-muted)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
                />
              </div>
            </div>

            {/* Options */}
              <div className="overflow-y-auto p-[var(--space-tight)] flex-1">
              {/* Open new directory (always first) */}
              <button
                onClick={handleOpenNew}
                role="option"
                className="w-full flex items-center gap-[var(--space-snug)] px-[var(--space-relaxed)] py-[var(--space-snug)] rounded-md text-xs text-[var(--brand-primary)] hover:bg-[var(--brand-muted)] transition-colors"
              >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                <span className="font-medium">打开新目录</span>
              </button>

                  {filtered.length > 0 && <div className="my-1 h-px bg-[var(--border-muted)]" aria-hidden="true"/>}

              {filtered.map((entry) => (
                <div
                  key={entry.path}
                  role="option"
                  aria-selected={entry.path === currentWorkspacePath}
                  className={`group flex items-center gap-[var(--space-snug)] px-[var(--space-relaxed)] py-[var(--space-normal)] rounded-md cursor-pointer transition-colors ${
                    entry.path === currentWorkspacePath
                        ? 'bg-[var(--brand-muted)] text-[var(--brand-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                  }`}
                  onClick={() => handleSelect(entry.path)}
                >
                    <svg className="w-3.5 h-3.5 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                      <div className="text-2xs font-medium truncate">{getBasename(entry.path)}</div>
                      <div className="text-2xs text-[var(--text-muted)] [overflow-wrap:anywhere]">{entry.path}</div>
                  </div>
                  {entry.path === currentWorkspacePath && (
                      <svg className="w-3 h-3 text-[var(--brand-primary)] shrink-0" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" strokeWidth="3" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12"/>
                      </svg>
                  )}
                  {/* Action buttons on right */}
                  <button
                    onClick={(e) => { e.stopPropagation(); window.electronAPI?.openPath?.(entry.path) }}
                    aria-label="在文件管理器中打开"
                    title="在文件管理器中打开"
                    className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--brand-primary)] opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      confirm({
                        title: '删除工作目录',
                        message: `确定要删除"${entry.path}"吗？该目录下的所有会话记录也会一并删除，此操作不可撤销。`,
                        confirmText: '删除',
                        confirmVariant: 'danger',
                        onConfirm: () => removeWorkspace(entry.path)
                      })
                    }}
                    aria-label="从历史中移除"
                    className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--error)] opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}

              {filtered.length === 0 && search.trim() && (
                  <div
                      className="px-[var(--space-relaxed)] py-[var(--space-loose)] text-center text-2xs text-[var(--text-muted)]">无匹配目录</div>
              )}
            </div>
          </motion.div>,
          document.body,
        )
}

/* ─── New Chat Button ─── */

function NewChatButton() {

  const handleNew = async () => {
    const store = useConversationStore.getState()
    if (!store.currentWorkspacePath) {
      const result = await window.electronAPI?.openFolderDialog?.()
      if (result) {
        store.setWorkspace(result)
      } else {
        return
      }
    }
    await useConversationStore.getState().createConversation()
  }

    // 监听全局快捷键：Ctrl+N → 新建会话
    useEffect(() => {
        window.addEventListener('hclaw:new-conversation', handleNew)
        return () => window.removeEventListener('hclaw:new-conversation', handleNew)
    }, [])

  return (
    <button
      onClick={handleNew}
      aria-label="新建对话"
      className="w-full flex items-center justify-center gap-2 py-2.5 bg-gray-900 dark:bg-white/5 border border-transparent dark:border-white/10 text-white dark:text-gray-300 rounded-[18px] text-[13px] font-medium hover:bg-gray-800 dark:hover:bg-white/10 dark:hover:text-gray-100 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.15)] dark:shadow-none transition-all active:scale-[0.98] group"
    >
        <svg className="w-4 h-4 text-gray-300 dark:text-gray-500 group-hover:text-white dark:group-hover:text-gray-200 transition-colors"
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
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500 group-focus-within:text-gray-600 dark:group-focus-within:text-gray-300 transition-colors"
             viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索对话..."
        aria-label="搜索对话"
        className="w-full pl-9 pr-4 py-2 bg-gray-100/60 dark:bg-white/5 rounded-[36px] text-[13px] text-gray-800 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:bg-white dark:focus:bg-[#1A1A1A] focus:ring-2 focus:ring-gray-200 dark:focus:ring-white/10 focus:border-transparent transition-all hover:bg-gray-100/80 dark:hover:bg-white/10"
      />
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

export function ConversationList() {
  const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const getFilteredConversations = useConversationStore((s) => s.getFilteredConversations)
    const workspaces = useConversationStore((s) => s.workspaces)
    const searchQuery = useConversationStore((s) => s.searchQuery)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
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

    const filtered = useMemo(() => {
        return getFilteredConversations()
    }, [getFilteredConversations, workspaces, currentWorkspacePath, searchQuery])

    // ★ 所有 useMemo/useEffect 必须在早期 return 之前定义，
    //   否则 React Hooks 规则会报 "Rendered more hooks than during the previous render"
    //   当 currentWorkspacePath 为 null 时首次渲染提前 return，hook 序列中断。
    const childrenMap = useMemo(() => {
        const map = new Map<string, typeof filtered[number][]>()
        for (const conv of filtered) {
            if (conv.parentConvId) {
                const siblings = map.get(conv.parentConvId) || []
                siblings.push(conv)
                map.set(conv.parentConvId, siblings)
            }
        }
        return map
    }, [filtered])

    // ★ 预计算 parentId → childIds 映射，避免 render 中重复 .map()
    const childIdsMap = useMemo(() => {
        const map = new Map<string, string[]>()
        for (const [parentId, children] of childrenMap) {
            map.set(parentId, children.map(c => c.id))
        }
        return map
    }, [childrenMap])

    // id → conversation 映射，供祖先链查找复用
    const convById = useMemo(() => new Map(filtered.map(c => [c.id, c])), [filtered])

    // ★ 新子会话自动展开父级：检测 childrenMap 变化，新出现的子会话 → 展开其父会话
    //   注意：prevChildrenRef 初始为 null，首次渲染跳过（避免启动时把所有父会话展开一轮，
    //   覆盖掉「激活会话展开」逻辑）；后续 childrenMap 变化时只展开真正新增的子会话的父级。
    //   同时沿 parentConvId 链向上展开所有祖先，确保二级子会话出现时其父（一级子会话）
    //   与其祖父（主会话）都处于展开态，侧栏才能完整显示嵌套树。
    const prevChildrenRef = useRef<Map<string, Set<string>> | null>(null)
    useEffect(() => {
        const current = new Map<string, Set<string>>()
        for (const [parentId, children] of childrenMap) {
            current.set(parentId, new Set(children.map(c => c.id)))
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
                            addSelfAndAncestors(new Set(prevSet), convById, parentId))
                        break
                    }
                }
            }
        }
        prevChildrenRef.current = current
    }, [childrenMap])

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
        const activeConv = filtered.find(c => c.id === activeConversationId)
        if (!activeConv) return

        setExpandedParentIds(prev => {
            // 需要保持展开的父级：active 的祖先链 + active 自身（若其有子会话）
            const keep = new Set<string>()
            if (activeConv.parentConvId) {
                addSelfAndAncestors(keep, convById, activeConv.parentConvId)
            }
            if (childrenMap.has(activeConv.id)) {
                keep.add(activeConv.id)
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

  if (!currentWorkspacePath) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center p-[var(--space-loose)] text-center">
            <div
                className="w-12 h-12 rounded-lg bg-[var(--surface-muted)] flex items-center justify-center mb-4 opacity-40">
                <svg className="w-6 h-6 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.5">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
        </div>
            <p className="text-xs text-[var(--text-muted)]">请先选择工作目录</p>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center p-[var(--space-loose)] text-center">
            <p className="text-xs text-[var(--text-muted)]">暂无会话</p>
      </div>
    )
  }

  // 按父子关系分组：子会话紧跟在父会话之后，带缩进层级
  function groupByParent(conversations: Array<typeof filtered[number]>): Array<(typeof filtered[number]) & { indentLevel: number; childCount: number }> {
      const result: Array<(typeof filtered[number]) & { indentLevel: number; childCount: number }> = []
      const placed = new Set<string>()
      // 祖先链查找复用组件级 convById memo

      // ★ 多级嵌套支持：子会话显示的前提是「其全部祖先」都已展开。
      //   仅判断直接父级展开不够——一级子会话本身展开了但其祖父（主会话）折叠时，
      //   一级子会话根本不会出现在列表中，二级子会话更不可能显示。
      function isAncestryExpanded(conv: typeof filtered[number]): boolean {
          let cur = conv.parentConvId || null
          while (cur) {
              if (!expandedParentIds.has(cur)) return false
              const parent = convById.get(cur)
              cur = parent?.parentConvId || null
          }
          return true
      }

      function addWithChildren(conv: typeof filtered[number], indentLevel: number) {
          if (placed.has(conv.id)) return
          placed.add(conv.id)
          const directChildren = childrenMap.get(conv.id)
          result.push({ ...conv, indentLevel, childCount: directChildren?.length || 0 })

          // 非展开的父会话跳过子会话（仅当该父会话及其全部祖先展开时才显示子级）
          if (expandedParentIds.has(conv.id)) {
              if (directChildren) {
                  directChildren.sort((a, b) => b.updatedAt - a.updatedAt)
                  for (const child of directChildren) {
                      // 递归前检查祖先链：若 child 的祖先链中某级未展开则跳过整棵子树
                      if (isAncestryExpanded(child)) {
                          addWithChildren(child, indentLevel + 1)
                      }
                  }
              }
          }
      }

      // 仅从根会话开始处理（无父级的独立会话 + 父级已删除的子会话）
      const parentIdSet = new Set(conversations.map(c => c.id))
      for (const conv of conversations) {
          if (!conv.parentConvId || !parentIdSet.has(conv.parentConvId)) {
              addWithChildren(conv, 0)
          }
      }

      return result
  }

  return (
      <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-[var(--space-relaxed)] space-y-[1px] py-[var(--space-tight)] scrollbar-thin relative"
      >
          {groupByParent(filtered).map(conv => (
              <ConversationItem
                  key={conv.id}
                  id={conv.id}
                  title={conv.title}
                  timestamp={conv.updatedAt}
                  preview={conv.preview}
                  pinned={conv.pinned}
                  channel={conv.channel}
                  status={conv.status}
                  indentLevel={conv.indentLevel}
                  childCount={conv.childCount}
                  childIds={childIdsMap.get(conv.id)}
                  onParentClick={conv.childCount > 0 ? handleParentClick : undefined}
                  isRenaming={renamingId === conv.id}
                  onStopRename={() => setRenamingId(null)}
                  onOpenMenu={(x, y) => setContextMenu({x, y, id: conv.id, title: conv.title, pinned: conv.pinned, parentConvId: conv.parentConvId})}
              />
          ))}

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
                  />
              )}
          </AnimatePresence>
      </div>
  )
}

// ── 右键菜单布局常量 ──
const CONTEXT_MENU_HEIGHT = 280 // 5 个按钮 + 分隔线
const CONTEXT_MENU_WIDTH = 180
// 菜单项通用样式；删除按钮叠加 error 变体
const MENU_ITEM_CLASS = 'w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors'

function GlobalContextMenu({x, y, id, title, pinned, parentConvId, onClose, onStartRename}: {
    x: number; y: number; id: string; title: string; pinned?: boolean; parentConvId?: string;
    onClose: () => void; onStartRename: (id: string) => void
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
        // 计算后代子会话数（含间接后代），用于删除确认文案
        const state = useConversationStore.getState()
        const wsPath = state.currentWorkspacePath
        const allConvs = wsPath ? state.workspaces[wsPath]?.conversations ?? [] : []
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
            >
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
            >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                重命名
            </button>

            <button
                onClick={handleUsageStatsClick}
                className={MENU_ITEM_CLASS}
            >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="20" x2="18" y2="10"/>
                    <line x1="12" y1="20" x2="12" y2="4"/>
                    <line x1="6" y1="20" x2="6" y2="14"/>
                </svg>
                用量统计
            </button>

            <div className="my-1.5 h-px bg-[var(--border-muted)] mx-2"/>
            <button
                onClick={handleDeleteClick}
                className={`${MENU_ITEM_CLASS} text-[var(--error)] hover:bg-[var(--error)]/10`}
            >
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
            const colorClass = isActive ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'
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
            const colorClass = isActive ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'
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

function ConversationItem({id, title, timestamp, isRenaming, onStopRename, onOpenMenu, pinned, channel, status, indentLevel, childCount, childIds, onParentClick}: {
    id: string; title: string; preview: string; timestamp: number;
    isRenaming: boolean; onStopRename: () => void;
    onOpenMenu: (x: number, y: number) => void;
    pinned?: boolean;
    channel?: string;
    status?: 'active' | 'running' | 'archived';
    indentLevel?: number;
    childCount?: number;
    childIds?: string[];
    onParentClick?: (convId: string, isActive: boolean, activeChildOfThisParent: boolean) => void;
}) {
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
    const updateConversationMeta = useConversationStore((s) => s.updateConversationMeta)
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
    const hasPending = hasPendingQuestion || hasPermissionConfirm

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
    const handleMouseEnter = useCallback(() => {
        clearTimeout(preloadTimerRef.current)
        preloadTimerRef.current = setTimeout(() =>
            useConversationStore.getState().preloadConversation(id), 300)
    }, [id])

    const handleMouseLeave = useCallback(() => {
        clearTimeout(preloadTimerRef.current)
    }, [])

    const hasChildren = (childCount || 0) > 0
    // ★ 当前激活的会话是否为此父会话的子会话（用于 handleParentClick 判断）
    const activeChildOfThisParent = hasChildren && !!childIds?.includes(activeConversationId || '')

    const handleClick = useCallback(() => {
        if (isRenaming) return
        if (hasChildren && onParentClick) {
            onParentClick(id, isActive, activeChildOfThisParent)
        }
        setActiveConversation(id)
    }, [isRenaming, hasChildren, onParentClick, id, isActive, activeChildOfThisParent, setActiveConversation])

    const containerClass = [
        'group relative flex items-center justify-between gap-3 px-4 py-2 rounded-[18px] transition-all cursor-pointer',
        isActive
            ? 'bg-green-50 dark:bg-green-500/10 border border-[var(--border)] shadow-sm'
            : 'bg-transparent border border-transparent hover:bg-gray-50 dark:hover:bg-white/5 active:bg-gray-100 dark:active:bg-white/10',
        hasPending && 'ring-1 ring-[var(--error)]/30',
    ].filter(Boolean).join(' ')

    const iconContainerClass = `relative flex items-center justify-center w-6 h-6 rounded-md shrink-0 transition-colors ${
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
        >
            <div className={iconContainerClass}>
                {showRunningPulse && (
                    <div
                        className="absolute inset-[-3px] rounded-[10px] border-2 border-[var(--info)] animate-running-pulse pointer-events-none"/>
                )}
                {childCount !== undefined && childCount > 0 && (
                    <span
                        className="absolute -left-1.5 -top-1.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-[var(--brand-primary)] text-white text-[9px] font-bold leading-none px-[3px] shadow-sm ring-1 ring-white dark:ring-gray-900 z-20 pointer-events-none"
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
                        className="flex-1 text-xs font-medium px-1.5 py-0.5 rounded border border-[var(--brand-primary)] bg-[var(--surface)] outline-none text-[var(--text-primary)]"
                    />
                ) : (
                    <div
                        title={title}
                        className={`truncate transition-colors text-[13px] ${isActive ? 'font-medium text-[var(--brand-primary)]' : 'text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100'}`}>
                        {title}
                    </div>
                )}
                {!isRenaming && (
                    <>
                        {hasPendingQuestion && <StatusBadge type="error">待确认</StatusBadge>}
                        {hasPermissionConfirm && !hasPendingQuestion &&
                            <StatusBadge type="warning">权限确认</StatusBadge>}
                        <div
                            className={`text-[11px] whitespace-nowrap shrink-0 transition-colors ${isActive ? 'font-medium text-[var(--brand-primary)] opacity-70' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400'}`}>
                            {getRelativeTime(timestamp)}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
