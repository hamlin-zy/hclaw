import type {JSX} from 'react'
import {useCallback, useEffect, useRef, useState} from 'react'
import {motion} from 'framer-motion'
import {useMenuBarStore} from '../stores/menuBarStore'
import {useThemeStore} from '../stores/themeStore'
import {useSidebarStore} from '../stores/sidebarStore'
import {useUpdaterStore} from '../stores/updaterStore'
import SchemeSelector from './SchemeSelector'
import PermissionModeSelector from './PermissionModeSelector'
import WorkModeSelector from './WorkModeSelector'
import MessageDisplayModeSelector from './MessageDisplayModeSelector'

/** 可翻转的箭头图标，避免重复 polyline */
function ChevronIcon({direction}: { direction: 'left' | 'right' }) {
    return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             aria-hidden="true"
             style={{transform: direction === 'right' ? 'scaleX(-1)' : undefined}}>
            <polyline points="15 18 9 12 15 6"/>
        </svg>
    )
}

/** 更多菜单图标 */
function MoreIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             aria-hidden="true">
            <circle cx="12" cy="12" r="1"/>
            <circle cx="19" cy="12" r="1"/>
            <circle cx="5" cy="12" r="1"/>
        </svg>
    )
}

const menuItems: { type: string | null; icon: JSX.Element; label: string }[] = [
    // ── 配置基础 ──
    {
        type: 'scheme-config',
        label: '方案',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M12 8v4M12 16h.01"/>
        </svg>
    },
    {
        type: 'llm-config',
        label: '模型',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
            <rect x="9" y="9" width="6" height="6"/>
            <line x1="9" y1="1" x2="9" y2="4"/>
            <line x1="15" y1="1" x2="15" y2="4"/>
            <line x1="9" y1="20" x2="9" y2="23"/>
            <line x1="15" y1="20" x2="15" y2="23"/>
            <line x1="20" y1="9" x2="23" y2="9"/>
            <line x1="20" y1="14" x2="23" y2="14"/>
            <line x1="1" y1="9" x2="4" y2="9"/>
            <line x1="1" y1="14" x2="4" y2="14"/>
        </svg>
    },
    {type: null, icon: <div className="w-px h-3.5 bg-[var(--border)]" aria-hidden="true"/>, label: ''},
    // ── 智能体 ──
    {
        type: 'agents',
        label: 'Agents',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
    },
    {
        type: 'skills',
        label: 'Skills',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
        </svg>
    },
    {
        type: 'commands',
        label: '命令',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
    },
    {type: null, icon: <div className="w-px h-3.5 bg-[var(--border)]" aria-hidden="true"/>, label: ''},
    // ── 集成扩展 ──
    {
        type: 'tools',
        label: '工具',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path
                d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
    },
    {
        type: 'mcp',
        label: 'MCP',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
    },
    {
        type: 'hooks',
        label: 'Hooks',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
    },
    {
        type: 'channels',
        label: '渠道',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.51.49"/>
            <path d="M4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9.6 4.6"/>
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>
        </svg>
    },
    {type: null, icon: <div className="w-px h-3.5 bg-[var(--border)]" aria-hidden="true"/>, label: ''},
    // ── 内容数据 ──
    {
        type: 'conversations',
        label: '会话',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
    },
    {
        type: 'prompt-config',
        label: '提示词',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
    },
    {
        type: 'plugins',
        label: '插件',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M20 7h-9"/>
            <path d="M14 17H5"/>
            <circle cx="17" cy="17" r="3"/>
            <circle cx="7" cy="7" r="3"/>
        </svg>
    },
    {type: null, icon: <div className="w-px h-3.5 bg-[var(--border)]" aria-hidden="true"/>, label: ''},
    // ── 运维管理 ──
    {
        type: 'schedules',
        label: '定时任务',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
        </svg>
    },
    {
        type: 'settings',
        label: '设置',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3"/>
            <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
    },
    {type: null, icon: <div className="w-px h-3.5 bg-[var(--border)]" aria-hidden="true"/>, label: ''},
    // ── 日志 ──
    {
        type: 'llm-call-logs',
        label: '日志',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
    },
    {type: null, icon: <div className="w-px h-3.5 bg-[var(--border)]" aria-hidden="true"/>, label: ''},
    {
        type: 'about',
        label: '关于',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
    },
]
export default function MenuBar() {
    const {openDialog} = useMenuBarStore()
    const {theme, toggleTheme} = useThemeStore()
    const {toggleLeft, toggleRight, leftCollapsed, rightCollapsed} = useSidebarStore()
    const hasUpdate = useUpdaterStore((s) => s.result?.status === 'update-available')
    const [collapsedItems, setCollapsedItems] = useState<string[]>([])
    const [showMoreMenu, setShowMoreMenu] = useState(false)
    const moreMenuRef = useRef<HTMLDivElement>(null)
    const visibleRef = useRef<HTMLDivElement>(null)
    const measureRef = useRef<HTMLDivElement>(null)

    // 计算「···」按钮的实际宽度（避免硬编码）
    const moreBtnWidthRef = useRef(0)
    // 对溢出隐藏容器的引用（用于给下拉菜单定位）
    const moreBtnRef = useRef<HTMLButtonElement>(null)

    // 测量溢出：用隐藏的测量容器获取所有项的总宽度（不随折叠改变），
    // 与可见可用宽度对比，精确计算哪些项需要折叠
    const calculateOverflow = useCallback(() => {
        const measure = measureRef.current
        const visible = visibleRef.current
        if (!measure || !visible) return

        const GAP = 2 // --space-tight = 2px（按钮之间间隔）

        // totalWidth = 隐藏测量容器始终渲染全部项 → 稳定不变
        const totalWidth = measure.scrollWidth
        // availableWidth = 可见容器实际可用空间
        const availableWidth = visible.clientWidth

        // 全部能放下，无需折叠
        if (totalWidth <= availableWidth) {
            setCollapsedItems([])
            return
        }

        // 需要折叠：逐项累加，只计数真正的菜单项（跳过分隔线 div）
        const children = Array.from(measure.children) as HTMLElement[]
        let usedWidth = 0
        let fitCount = 0

        for (let i = 0; i < children.length; i++) {
            if (i > 0) usedWidth += GAP
            usedWidth += children[i].offsetWidth

            // 为「···」按钮预留空间（第一次溢出时测量实际宽度）
            const moreBtnWidth = moreBtnWidthRef.current || 40
            if (usedWidth > availableWidth - moreBtnWidth) break

            // 只计数真正的菜单项（type !== null），跳过分隔线
            if (menuItems[i].type !== null) {
                fitCount++
            }
        }

        // 至少保留 1 项
        const totalActionable = menuItems.filter(item => item.type !== null).length
        const keepCount = Math.max(1, fitCount)

        if (keepCount >= totalActionable) {
            setCollapsedItems([])
        } else {
            const collapseCount = totalActionable - keepCount
            const actionableItems = menuItems.filter(item => item.type !== null)
            const toCollapse = actionableItems.slice(-collapseCount).map(item => item.type!)
            setCollapsedItems(toCollapse)
        }
    }, [])

    // 用 ResizeObserver 观测 nav 容器 — nav 宽度稳定不因折叠改变
    const navRef = useRef<HTMLElement>(null)
    useEffect(() => {
        const nav = navRef.current
        if (!nav) return

        // 初始测量（等待一帧确保 DOM 就绪）
        requestAnimationFrame(calculateOverflow)

        const observer = new ResizeObserver(calculateOverflow)
        observer.observe(nav)
        return () => observer.disconnect()
    }, [calculateOverflow])

    // 点击外部关闭更多菜单
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            // 点击了「···」按钮本身 → 由 handleMoreClick 处理切换
            if (moreBtnRef.current?.contains(target)) return
            // 点击了下拉菜单外部 → 关闭
            if (moreMenuRef.current && !moreMenuRef.current.contains(target)) {
                setShowMoreMenu(false)
            }
        }
        if (showMoreMenu) {
            document.addEventListener('mousedown', handleClickOutside)
            return () => document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [showMoreMenu])

  // 监听自定义事件：打开 LLM 配置
  useEffect(() => {
    const handleOpenLLMConfig = () => {
      openDialog('llm-config')
    }
    window.addEventListener('hclaw:open-llm-config', handleOpenLLMConfig)
    return () => {
      window.removeEventListener('hclaw:open-llm-config', handleOpenLLMConfig)
    }
  }, [openDialog])

    const handleItemClick = (type: string, e?: React.MouseEvent) => {
        if (type === 'llm-call-logs') {
            window.electronAPI?.openLlmLogsWindow?.()
        } else {
            // 捕获按钮位置用于弹窗锚点展开动画
            const rect = e?.currentTarget?.getBoundingClientRect()
            const origin = rect
                ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                : undefined
            openDialog(type as any, origin)
        }
        setShowMoreMenu(false)
    }

    const handleMoreClick = () => {
        setShowMoreMenu(prev => !prev)
    }

    // 测量「···」按钮实际宽度（供 calculateOverflow 使用，避免硬编码）
    useEffect(() => {
        if (collapsedItems.length > 0 && moreBtnRef.current) {
            moreBtnWidthRef.current = moreBtnRef.current.offsetWidth
        }
    }, [collapsedItems, showMoreMenu])

  return (
      <nav
          ref={navRef}
          className="h-[var(--menubar-height)] bg-[var(--surface)] border-t border-b border-[var(--border-muted)] flex items-center px-[var(--space-relaxed)] gap-[var(--space-tight)] select-none relative"
          role="navigation"
          aria-label="主菜单"
      >
          {/* 左侧边栏折叠按钮 */}
          <button
              onClick={toggleLeft}
              aria-label={leftCollapsed ? '展开左侧边栏' : '折叠左侧边栏'}
              className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
          >
              <ChevronIcon direction={leftCollapsed ? 'right' : 'left'}/>
          </button>

          {/* 分隔线 */}
          <div className="w-px h-4 bg-[var(--border)] mx-[var(--space-tight)]" aria-hidden="true"/>

          {/* 菜单项 - 可见部分（flex-1 占据全部可用空间，不随折叠收缩） */}
          <div ref={visibleRef} className="flex items-center gap-[var(--space-tight)] overflow-hidden min-w-0 flex-1">
              {menuItems.map((item, i) => {
                  // 分隔线：如果它后面的非空项全部被折叠则隐藏
                  if (item.type === null) {
                      const hasVisibleAfter = menuItems.slice(i + 1).some(
                          later => later.type !== null && !collapsedItems.includes(later.type!)
                      )
                      if (!hasVisibleAfter) return null
                      return <div key={`sep-${i}`} className="px-[var(--space-tight)] shrink-0">{item.icon}</div>
                  }
                  // 按钮项被折叠时隐藏
                  if (collapsedItems.includes(item.type!)) return null
                  const showUpdateDot = item.type === 'about' && hasUpdate
                  return (
                      <motion.button
                          key={item.type}
                          onClick={(e) => handleItemClick(item.type!, e)}
                          title={item.label}
                          data-tooltip={item.label}
                          aria-label={item.label}
                          whileTap={{ scale: 0.92 }}
                          className="relative flex items-center justify-center px-[12px] py-1 rounded text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"
                      >
                          <svg className="w-3.5 h-3.5" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              {item.icon.props.children}
                          </svg>
                          {showUpdateDot && (
                              <span
                                  className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-red-500"
                                  aria-label="有新版本"
                              />
                          )}
                      </motion.button>
                  )
              })}

              {/* 「···」更多按钮（放在 overflow:hidden 容器内用于视觉显示） */}
              {collapsedItems.length > 0 && (
                  <button
                      ref={moreBtnRef}
                      onClick={handleMoreClick}
                      title="更多"
                      aria-label="更多菜单"
                      aria-expanded={showMoreMenu}
                      className="flex items-center justify-center px-[var(--space-relaxed)] py-1 rounded text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors shrink-0"
                  >
                      <MoreIcon/>
                  </button>
              )}
          </div>

          {/* 下拉菜单 — 放在 overflow:hidden 容器之外，避免被裁剪 */}
          {showMoreMenu && (() => {
              const nav = navRef.current
              const btn = moreBtnRef.current
              if (!nav || !btn) return null
              const navRect = nav.getBoundingClientRect()
              const btnRect = btn.getBoundingClientRect()
              return (
                  <div
                      ref={moreMenuRef}
                      className="absolute py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md shadow-lg z-[var(--z-dropdown)] min-w-[140px]"
                      style={{
                          left: btnRect.left - navRect.left,
                          top: navRect.bottom - navRect.top,
                      }}
                      onClick={e => e.stopPropagation()}
                  >
                      {menuItems
                          .filter(item => item.type !== null && collapsedItems.includes(item.type!))
                          .map(item => (
                              <button
                                  key={item.type}
                                  onClick={() => handleItemClick(item.type!)}
                                  className="relative w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                              >
                                  <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                                      <svg className="w-3.5 h-3.5" {...item.icon.props}>
                                          {item.icon.props.children}
                                      </svg>
                                  </span>
                                  <span>{item.label}</span>
                                  {item.type === 'about' && hasUpdate && (
                                      <span
                                          className="ml-auto w-1.5 h-1.5 rounded-full bg-red-500"
                                          aria-label="有新版本"
                                      />
                                  )}
                              </button>
                          ))}
                  </div>
              )
          })()}

          {/* 测量容器 — 始终渲染所有菜单项，不占可见空间，用于精确计算溢出 */}
          <div
              ref={measureRef}
              aria-hidden="true"
              className="flex items-center gap-[var(--space-tight)] absolute top-0 left-0 pointer-events-none opacity-0"
              style={{zIndex: -1}}
          >
              {menuItems.map((item, i) =>
                  item.type === null ? (
                      <div key={`sep-${i}`} className="px-[var(--space-tight)] shrink-0">{item.icon}</div>
                  ) : (
                      <button
                          key={item.type}
                          className="flex items-center justify-center px-[12px] py-1 rounded text-xs shrink-0"
                      >
                          <svg className="w-3.5 h-3.5" {...item.icon.props}>
                              {item.icon.props.children}
                          </svg>
                      </button>
                  )
              )}
          </div>

          {/* 方案 / 权限 / 工作模式 / 消息显示模式选择器 — 靠右侧竖线 */}
          <SchemeSelector/>
          <PermissionModeSelector/>
          <WorkModeSelector/>
          <MessageDisplayModeSelector/>

          {/* 分隔线 */}
          <div className="w-px h-4 bg-[var(--border)] mx-[var(--space-tight)]" aria-hidden="true"/>

          {/* Theme toggle */}
          <button
              onClick={toggleTheme}
              aria-label={theme === 'yuanshandai' ? '切换到十样锦模式' : theme === 'shiyangjin' ? '切换到浅色模式' : theme === 'dark' ? '切换到远山黛模式' : '切换到深色模式'}
              className="flex items-center gap-[var(--space-tight)] px-[var(--space-relaxed)] py-1 rounded text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
          >
              {theme === 'shiyangjin' ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      {/* 十样锦图标 — 锦花 */}
                      <path d="M12 3L21 12l-9 9-9-9z" opacity="0.6"/>
                      <circle cx="12" cy="12" r="3"/>
                  </svg>
              ) : theme === 'yuanshandai' ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {/* 远山黛图标 — 双峰山 */}
                      <path d="M3 20L9 8l4 8 4-6 4 10h1"/>
                  </svg>
              ) : theme === 'dark' ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
              )}
          </button>

          {/* 右侧面板折叠按钮 */}
          <button
              onClick={toggleRight}
              aria-label={rightCollapsed ? '展开右侧面板' : '折叠右侧面板'}
              className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
          >
              <ChevronIcon direction={rightCollapsed ? 'left' : 'right'}/>
          </button>
      </nav>
  )
}
