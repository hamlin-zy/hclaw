import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useConversationStore} from '../stores/conversationStore'
import {useSidebarStore} from '../stores/sidebarStore'
import {getBasename, getRelativeTime} from '../lib/format'
import {useLLMStore} from '../stores/llmStore'
import {useModelSchemeStore} from '../stores/modelSchemeStore'
import {useAgentStore} from '../stores/agentStore'
import {fuzzyFilter} from '../lib/search'
import {confirm} from './ConfirmDialog'

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

export default function ConversationSidebar() {
    const {leftCollapsed, setLeftCollapsed} = useSidebarStore()
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)

  return (
      <div className="relative h-full flex shrink-0">
          {/* 侧边栏主体 */}
          <motion.div
              initial={false}
              animate={{width: leftCollapsed ? 'var(--sidebar-collapsed-width, 52px)' : 'var(--sidebar-width)'}}
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

                      {/* Footer */}
                      <footer
                          className="px-[var(--space-relaxed)] py-[var(--space-snug)] border-t border-[var(--border)] mt-auto">
                          <SystemStatusIndicator/>
            </footer>
                  </>
              )}

              {/* 折叠状态显示工作区图标 */}
              {leftCollapsed && (
                  <div className="flex flex-col items-center pt-[var(--space-relaxed)] gap-[var(--space-snug)]">
                      <WorkspaceIcon/>
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

function WorkspaceSelector() {
  const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
  const setWorkspace = useConversationStore((s) => s.setWorkspace)
  const workspaces = useConversationStore((s) => s.workspaces)
  const removeWorkspace = useConversationStore((s) => s.removeWorkspace)
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [tooltipPath, setTooltipPath] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const tooltipTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      if (tooltipTimer.current !== undefined) clearTimeout(tooltipTimer.current)
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

  const displayName = currentWorkspacePath ? getBasename(currentWorkspacePath) : '选择工作目录'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
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
              className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/>
          </svg>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{duration: 0.15}}
            className="absolute left-0 right-0 top-full mt-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-dropdown z-dropdown overflow-hidden"
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
              <div className="max-h-56 overflow-y-auto p-[var(--space-tight)]">
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
                  onMouseEnter={(e) => {
                    // 检查路径文本是否被截断
                    const pathEl = e.currentTarget.querySelector<HTMLElement>('.flex-1.min-w-0 > div:last-child')
                    const isTruncated = pathEl && pathEl.scrollWidth > pathEl.clientWidth
                    if (!isTruncated) return

                    const rect = e.currentTarget.getBoundingClientRect()
                    tooltipTimer.current = setTimeout(() => {
                      setTooltipPos({ x: rect.left, y: rect.top })
                      setTooltipPath(entry.path)
                    }, 1000)
                  }}
                  onMouseLeave={() => {
                    if (tooltipTimer.current !== undefined) {
                      clearTimeout(tooltipTimer.current)
                      tooltipTimer.current = undefined
                    }
                    setTooltipPath(null)
                  }}
                >
                    <svg className="w-3.5 h-3.5 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                      <div className="text-2xs font-medium truncate">{getBasename(entry.path)}</div>
                      <div className="text-2xs text-[var(--text-muted)] truncate">{entry.path}</div>
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
            {/* 路径气泡提示 */}
            {tooltipPath && (
              <div
                className="fixed z-[var(--z-tooltip)] px-2 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-2xs rounded shadow-lg max-w-80 break-all whitespace-pre-wrap pointer-events-none"
                style={{ left: tooltipPos.x, top: tooltipPos.y - 10, transform: 'translateY(-100%)' }}
              >
                {tooltipPath}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function WorkspaceIcon() {
  const { currentWorkspacePath, setWorkspace } = useConversationStore()
  return (
    <button
      onClick={async () => {
        const result = await window.electronAPI?.openFolderDialog?.()
        if (result) setWorkspace(result)
      }}
      aria-label={currentWorkspacePath || '选择工作目录'}
      title={currentWorkspacePath || '选择工作目录'}
      className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-elevated)] transition-colors"
    >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             aria-hidden="true">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    </button>
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

function ConversationList() {
  const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const getFilteredConversations = useConversationStore((s) => s.getFilteredConversations)
    const workspaces = useConversationStore((s) => s.workspaces)
    const searchQuery = useConversationStore((s) => s.searchQuery)
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        id: string;
        title: string;
        pinned?: boolean
    } | null>(null)
    const [renamingId, setRenamingId] = useState<string | null>(null)
    const listRef = useRef<HTMLDivElement>(null)

    // 监听全局点击以关闭菜单
    useEffect(() => {
        if (!contextMenu) return
        const close = () => setContextMenu(null)
        window.addEventListener('click', close)
        window.addEventListener('contextmenu', close)
        window.addEventListener('scroll', close, true)
        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('contextmenu', close)
            window.removeEventListener('scroll', close, true)
    }
    }, [contextMenu])

    const filtered = useMemo(() => {
        return getFilteredConversations()
    }, [getFilteredConversations, workspaces, currentWorkspacePath, searchQuery])

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

  return (
      <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-[var(--space-relaxed)] space-y-[1px] py-[var(--space-tight)] scrollbar-thin relative"
      >
          {filtered.map((conv) => (
              <ConversationItem
                  key={conv.id}
                  id={conv.id}
                  title={conv.title}
                  timestamp={conv.updatedAt}
                  preview={conv.preview}
                  pinned={conv.pinned}
                  channel={conv.channel}
                  status={conv.status}
                  isRenaming={renamingId === conv.id}
                  onStopRename={() => setRenamingId(null)}
                  onOpenMenu={(x, y) => setContextMenu({x, y, id: conv.id, title: conv.title, pinned: conv.pinned})}
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

function GlobalContextMenu({x, y, id, title, pinned, onClose, onStartRename}: {
    x: number; y: number; id: string; title: string; pinned?: boolean;
    onClose: () => void; onStartRename: (id: string) => void
}) {
    const deleteConversation = useConversationStore((s) => s.deleteConversation)
    const togglePinConversation = useConversationStore((s) => s.togglePinConversation)
    // 菜单高度约 240px（4个按钮 + 分隔线）
    const MENU_HEIGHT = 240
    const MENU_WIDTH = 180

    // 边界检测：确保菜单在视口内
    const adjustedX = Math.min(x, window.innerWidth - MENU_WIDTH - 10)
    const adjustedY = y + MENU_HEIGHT > window.innerHeight
        ? Math.max(10, window.innerHeight - MENU_HEIGHT - 10)
        : y

    const handleDeleteClick = async (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        // ★ 先关闭上下文菜单，避免其全局点击/滚动监听器干扰确认弹窗
        onClose()
        // 使用 App 级别的 ConfirmDialog（在 App.tsx 顶层渲染），
        // 完全隔离于侧边栏的 AnimatePresence 和流式重渲染影响
        await confirm({
            title: '删除会话',
            message: `确定要删除"${title}"吗？此操作不可撤销。`,
            confirmText: '确认删除',
            confirmVariant: 'danger',
            onConfirm: async () => {
                await deleteConversation(id)
            },
        })
    }

    return (
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
            <button
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    togglePinConversation(id)
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'}
                     stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                </svg>
                {pinned ? '取消置顶' : '置顶会话'}
            </button>

            <button
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onStartRename(id)
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                重命名
            </button>

            <div className="my-1.5 h-px bg-[var(--border-muted)] mx-2"/>
            <button
                onClick={handleDeleteClick}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
            >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
                删除会话
            </button>
        </motion.div>
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

function ConversationItem({id, title, timestamp, isRenaming, onStopRename, onOpenMenu, pinned, channel, status}: {
    id: string; title: string; preview: string; timestamp: number;
    isRenaming: boolean; onStopRename: () => void;
    onOpenMenu: (x: number, y: number) => void;
    pinned?: boolean;
    channel?: string
    status?: 'active' | 'running' | 'archived'
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
    const isRunning = !isActive && (agentStatus === 'running' || agentStatus === 'thinking')
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
            onClick={() => {
                if (!isRenaming) setActiveConversation(id)
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenMenu(e.clientX, e.clientY)
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className={containerClass}
        >
            <div className={iconContainerClass}>
                {showRunningPulse && (
                    <div
                        className="absolute inset-[-3px] rounded-[10px] border-2 border-[var(--info)] animate-running-pulse pointer-events-none"/>
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
