/**
 * MemoPanel - 备忘录面板（待办/历史双 Tab + 日期分组 + Reorder 拖拽）
 *
 * 挂载于右侧边栏容器（SidePanels）。挂载时 load 当前工作区备忘录并
 * subscribeMemoChanged（workspacePath 相等才刷新）。
 *
 * 结构：标题+新建 → 搜索框 → Tab(待办|历史) → 列表
 * - 待办 Tab：active 项，sortActiveMemos 排序（pinned→sortIndex→createdAt），
 *   framer-motion Reorder 拖拽（FLIP 挤压动画），置顶约束保留
 * - 历史 Tab：processed 项，groupProcessedByDate 按创建日期层级分组
 *   （本月→日；本年→月→日；往年→年→月→日），组间倒序、组内 desc，
 *   各组默认折叠，点组头展开
 * - 搜索：只作用于当前 Tab，切 Tab 保留关键字
 *
 * 其余视觉对齐（胶囊圆角项等）见各组件内联注释。
 */
import React, {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Reorder} from 'framer-motion'
import {useMemoStore, subscribeMemoChanged, openMemoCreateWindow} from '../../stores/memoStore'
import {useConversationStore} from '../../stores/conversationStore'
import {useSidebarStore} from '../../stores/sidebarStore'
import {confirm} from '../ConfirmDialog'
import {PrioritySelect} from '../common/PrioritySelect'
import {formatShortcut, formatShortcutSpoken} from '../common/Kbd'
import {formatRelativeTime} from '../../lib/relativeTime'
import {useDayBoundaryTick} from '../../hooks/useDayBoundaryTick'
import {sortActiveMemos, groupProcessedByDate, renumberGroup, countGroupItems, collectGroupMemoIds} from './memoSort'
import type {ProcessedDateGroup} from './memoSort'
import type {MemoCapability, MemoItem} from '@shared/types/memo'

const PENDING_TAB = 'pending' as const
const HISTORY_TAB = 'history' as const
type MemoTab = typeof PENDING_TAB | typeof HISTORY_TAB

/** 面板内 hover 操作按钮共用的底样式，颜色类由调用处追加 */
const ACTION_BTN_BASE = 'p-1 rounded hover:bg-[var(--surface-muted)] transition-colors'
/** 底样式 + 默认灰字、hover 品牌色（新建/跳转等常规操作按钮） */
const ACTION_BTN_MUTED = `${ACTION_BTN_BASE} text-[var(--text-muted)] hover:text-[var(--brand-primary)]`

export default function MemoPanel() {
    const memos = useMemoStore((s) => s.memos)
    const loading = useMemoStore((s) => s.loading)
    const load = useMemoStore((s) => s.load)
    const wsPath = useConversationStore((s) => s.currentWorkspacePath) ?? ''
    const setRightCollapsed = useSidebarStore((s) => s.setRightCollapsed)

    const [keyword, setKeyword] = useState('')
    const [tab, setTab] = useState<MemoTab>(PENDING_TAB)

    useEffect(() => {
        if (!wsPath) return
        void load(wsPath)
        return subscribeMemoChanged(() => useConversationStore.getState().currentWorkspacePath ?? '')
    }, [wsPath, load])

    const kw = keyword.trim().toLowerCase()
    const match = (m: MemoItem) => m.title.toLowerCase().includes(kw) || m.content.toLowerCase().includes(kw)

    // 待办列表（搜索过滤后排序）
    const activeList = useMemo(() => {
        const list = sortActiveMemos(memos)
        return kw ? list.filter(match) : list
    }, [memos, kw]) // eslint-disable-line react-hooks/exhaustive-deps

    // 历史列表分组（搜索过滤后分组）；dayTick：跨天时强制重算分组
    const dayTick = useDayBoundaryTick()
    const historyGroups = useMemo(() => {
        const processed = memos.filter((m) => m.status !== 'active')
        return groupProcessedByDate(kw ? processed.filter(match) : processed)
    }, [memos, kw, dayTick]) // eslint-disable-line react-hooks/exhaustive-deps

    const updateItem = useMemoStore((s) => s.updateItem)
    const removeMany = useMemoStore((s) => s.removeMany)
    // 拖拽：dragOrder 覆盖派生顺序，提供乐观更新驱动 FLIP 动画；onDragEnd 落库后清空回到派生顺序
    const [dragOrder, setDragOrder] = useState<string[] | null>(null)
    // 拖拽期间抑制条目 click（Reorder 松开鼠标时 pointerup 仍会派发 click，误开编辑窗口）
    const dragActiveRef = useRef(false)
    const renderOrder = dragOrder ?? activeList.map((m) => m.id)
    const idsToMemos = (ids: string[]): MemoItem[] =>
        ids.map((id) => memos.find((m) => m.id === id)).filter(Boolean) as MemoItem[]

    const handleReorder = (newOrder: string[]) => {
        // 置顶约束：非置顶项不得上穿置顶区（等价于置顶连续居前）
        const items = idsToMemos(newOrder)
        const firstUnpinned = items.findIndex((m) => !m.pinned)
        if (firstUnpinned !== -1 && items.slice(firstUnpinned).some((m) => m.pinned)) return // 拒绝→回弹
        setDragOrder(newOrder)
    }

    const handleDragEnd = async () => {
        const items = idsToMemos(dragOrder ?? renderOrder)
        for (const {id, sortIndex} of renumberGroup(items)) {
            await updateItem(id, {sortIndex})
        }
        setDragOrder(null) // 落库后回到派生顺序（sortIndex 已更新，顺序一致）
    }

    // 历史分组折叠状态（默认全部折叠，点组头 toggle）
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
    const toggleGroup = (key: string) => {
        setExpandedKeys((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    // ── 历史组头右键菜单（删除组内备忘录）──
    // ids 为右键时该组渲染集合的条目 id：非搜索 = 组内全部；搜索 = 当前命中的条目
    const [groupMenu, setGroupMenu] = useState<{x: number; y: number; label: string; ids: string[]} | null>(null)
    const groupMenuDeletingRef = useRef(false)

    const openGroupMenu = (e: React.MouseEvent, group: ProcessedDateGroup) => {
        e.preventDefault()
        e.stopPropagation()
        const ids = collectGroupMemoIds(group)
        if (ids.length === 0) return
        setGroupMenu({x: e.clientX, y: e.clientY, label: group.label, ids})
    }

    const handleDeleteGroup = async () => {
        const menu = groupMenu
        if (!menu || groupMenuDeletingRef.current) return
        setGroupMenu(null) // confirm 前先关菜单，与 ConversationSidebar 删除交互一致
        groupMenuDeletingRef.current = true
        try {
            const ok = await confirm({
                title: '删除组内备忘录',
                message: `确定删除「${menu.label}」中的 ${menu.ids.length} 条备忘录吗？\n此操作不可撤销。`,
                confirmText: '删除',
                confirmVariant: 'danger',
            })
            if (ok) await removeMany(menu.ids)
        } finally {
            groupMenuDeletingRef.current = false
        }
    }

    // 菜单关闭：全局 contextmenu（右键别处/另一组头时旧菜单关闭并重新定位）+ 点击其他区域
    useEffect(() => {
        if (!groupMenu) return
        const close = () => setGroupMenu(null)
        window.addEventListener('contextmenu', close)
        window.addEventListener('click', close)
        window.addEventListener('scroll', close, true)
        return () => {
            window.removeEventListener('contextmenu', close)
            window.removeEventListener('click', close)
            window.removeEventListener('scroll', close, true)
        }
    }, [groupMenu])

    // workspacePath/id 经 encodeURIComponent 编码后传参（路径含空格/`=` 时不会被 argv 切断，preload 侧解码）
    const openEdit = (id: string) => {
        void window.electronAPI?.openConfigWindow?.('memo-edit', [`--hclaw-memo-id=${encodeURIComponent(id)}`])
    }
    const openCreate = () => {
        if (!wsPath) return
        openMemoCreateWindow(wsPath)
    }

    const activeCount = memos.filter((m) => m.status === 'active').length
    const processedCount = memos.length - activeCount
    const searching = kw.length > 0

    return (
        <div className="memo-panel-card flex flex-col h-full text-[var(--text-primary)]">
            {/* 顶部：标题 + 新建 */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
                <span className="text-xs font-medium text-[var(--text-muted)]">备忘录</span>
                <button
                    // 走全局 TooltipPortal：data-tooltip-placement="left" 使 tooltip
                    // 向左展开（按钮贴面板右缘，向右展开会溢出屏幕）
                    title={`新建备忘录 (${formatShortcut('Ctrl+Shift+N')})`}
                    aria-label={`新建备忘录 (${formatShortcutSpoken('Ctrl+Shift+N')})`}
                    onClick={openCreate}
                    data-tooltip-placement="left"
                    className={ACTION_BTN_MUTED}
                 data-name="memo-delete-button">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                </button>
            </div>

            {/* 搜索框 */}
            <div className="px-3 py-2 shrink-0">
                <input
                    type="text"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="搜索备忘录..."
                    className="w-full px-4 py-2 bg-gray-100/60 dark:bg-white/5 rounded-[36px] text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:bg-white dark:focus:bg-[#1A1A1A] focus:ring-2 focus:ring-gray-200 dark:focus:ring-white/10 focus:border-transparent transition-all hover:bg-gray-100/80 dark:hover:bg-white/10"
                data-name="memo-panel-input"/>
            </div>

            {/* Tab：待办 | 历史 */}
            <div className="flex shrink-0 border-b border-[var(--border)]" data-name="memo-panel-tabs">
                <TabButton active={tab === PENDING_TAB} onClick={() => setTab(PENDING_TAB)}>
                    待办
                </TabButton>
                <TabButton active={tab === HISTORY_TAB} onClick={() => setTab(HISTORY_TAB)}>
                    历史
                </TabButton>
            </div>

            {/* 列表区 */}
            <div className="flex-1 overflow-y-auto px-[var(--space-relaxed)] py-[var(--space-tight)] space-y-[1px]">
                {loading && memos.length === 0 && (
                    <div className="p-4 text-center text-xs text-[var(--text-muted)]">加载中...</div>
                )}
                {!loading && tab === PENDING_TAB && activeList.length === 0 && (
                    <div className="p-4 text-center text-xs text-[var(--text-muted)]">
                        {searching ? '无匹配的备忘录' : '暂无备忘录'}
                    </div>
                )}
                {!loading && tab === HISTORY_TAB && historyGroups.length === 0 && (
                    <div className="p-4 text-center text-xs text-[var(--text-muted)]">
                        {searching ? '无匹配的历史' : '暂无历史'}
                    </div>
                )}

                {tab === PENDING_TAB && (
                    searching ? (
                        // 搜索时不启用拖拽（避免在过滤子集上重排破坏全局 sortIndex）
                        activeList.map((m) => (
                            <MemoItemRow key={m.id} item={m} onOpen={() => openEdit(m.id)}/>
                        ))
                    ) : (
                        <Reorder.Group axis="y" values={renderOrder} onReorder={handleReorder} className="space-y-[1px]">
                            {renderOrder.map((id) => {
                                const m = memos.find((x) => x.id === id)
                                if (!m) return null
                                return (
                                    <Reorder.Item
                                        key={id}
                                        value={id}
                                        onDragStart={() => { dragActiveRef.current = true }}
                                        onDragEnd={() => {
                                            void handleDragEnd()
                                            // click 在 pointerup 后同步派发，下一帧才解除抑制，避免松手误触编辑
                                            setTimeout(() => { dragActiveRef.current = false }, 0)
                                        }}
                                        // 拖拽提起视觉：轻微缩放 + 阴影，松手回弹
                                        whileDrag={{scale: 1.02, boxShadow: '0 4px 12px rgba(0,0,0,0.15)'}}
                                        className="list-none"
                                    >
                                        <MemoItemRow item={m} onOpen={() => {
                                            if (dragActiveRef.current) return
                                            openEdit(m.id)
                                        }}/>
                                    </Reorder.Item>
                                )
                            })}
                        </Reorder.Group>
                    )
                )}

                {tab === HISTORY_TAB && (
                    historyGroups.map((g, i) => (
                        <GroupNode
                            key={g.label + i}
                            group={g}
                            parentKey=""
                            expandedKeys={expandedKeys}
                            onToggle={toggleGroup}
                            onOpen={openEdit}
                            onGroupMenu={openGroupMenu}
                        />
                    ))
                )}
            </div>

            {/* 历史组头右键菜单（portal 到 body，脱离面板 overflow 裁剪） */}
            {groupMenu && (
                <GroupContextMenu
                    x={groupMenu.x}
                    y={groupMenu.y}
                    label={groupMenu.label}
                    count={groupMenu.ids.length}
                    searching={searching}
                    onDelete={() => void handleDeleteGroup()}
                    onClose={() => setGroupMenu(null)}
                />
            )}

            {/* 底部统计 + 折叠按钮 */}
            <div className="shrink-0 px-3 py-2 border-t border-[var(--border)] flex items-center justify-between gap-2">
                <div data-testid="memo-stats" className="text-2xs text-[var(--text-muted)]">
                    <span className={tab === PENDING_TAB ? 'text-[var(--brand-primary)] font-medium' : ''}>
                        待处理 {activeCount}
                    </span>
                    {' · '}
                    <span className={tab === HISTORY_TAB ? 'text-[var(--brand-primary)] font-medium' : ''}>
                        已处理 {processedCount}
                    </span>
                </div>
                <button
                    onClick={() => setRightCollapsed(true)}
                    aria-label="折叠右侧面板"
                    title={`折叠右侧面板 (${formatShortcut('Ctrl+Shift+B')})`}
                    className="mini-toggle flex items-center justify-center w-[30px] h-[30px] rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                 data-name="memo-panel-button">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </button>
            </div>
        </div>
    )
}

/** Tab 按钮 */
function TabButton({active, onClick, children}: {active: boolean; onClick: () => void; children: React.ReactNode}) {
    return (
        <button
            onClick={onClick}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${active ? 'text-[var(--brand-primary)] border-b-2 border-[var(--brand-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
        >
            {children}
        </button>
    )
}

/** 历史分组节点：递归渲染 year→month→day，day 叶子渲染条目 */
function GroupNode({group, parentKey, expandedKeys, onToggle, onOpen, onGroupMenu}: {
    group: ProcessedDateGroup
    parentKey: string
    expandedKeys: Set<string>
    onToggle: (key: string) => void
    onOpen: (id: string) => void
    onGroupMenu: (e: React.MouseEvent, group: ProcessedDateGroup) => void
}) {
    const key = parentKey ? `${parentKey}/${group.label}` : group.label
    const expanded = expandedKeys.has(key)
    const depth = parentKey ? parentKey.split('/').length : 0
    const count = countGroupItems(group)

    return (
        <div data-testid="memo-group" data-group-key={key}>
            <button
                onClick={() => onToggle(key)}
                onContextMenu={(e) => onGroupMenu(e, group)}
                aria-label={`${expanded ? '折叠' : '展开'} ${group.label}`}
                aria-expanded={expanded}
                className="flex items-center gap-1 w-full py-1.5 hover:bg-gray-50 dark:hover:bg-white/5 rounded transition-colors"
                style={{paddingLeft: `${depth * 16 + 4}px`}}
            >
                <svg
                    className={`w-3 h-3 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                >
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
                <span className="text-xs font-medium text-[var(--text-secondary)]">{group.label}</span>
                <span className="text-[10px] text-[var(--text-muted)]">· {count}</span>
            </button>
            {expanded && (
                <div style={{paddingLeft: `${depth * 16 + 4}px`}}>
                    {group.kind === 'day'
                        ? group.items.map((m) => (
                            <MemoItemRow key={m.id} item={m} onOpen={() => onOpen(m.id)} processed/>
                        ))
                        : group.children.map((c, i) => (
                            <GroupNode
                                key={c.label + i}
                                group={c}
                                parentKey={key}
                                expandedKeys={expandedKeys}
                                onToggle={onToggle}
                                onOpen={onOpen}
                                onGroupMenu={onGroupMenu}
                            />
                        ))
                    }
                </div>
            )}
        </div>
    )
}

/** 组头右键菜单菜单项通用样式（与 ConversationSidebar.GlobalContextMenu 同源） */
const GROUP_MENU_ITEM_CLASS = 'w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors'

/**
 * 历史组头右键菜单（删除组内备忘录）。
 * 样式对齐会话列表 GlobalContextMenu：surface 面板 + border-emphasis + shadow-elevated，
 * 删除项 error 红色变体；定位做视口边界收敛。
 */
function GroupContextMenu({x, y, label, count, searching, onDelete, onClose}: {
    x: number
    y: number
    label: string
    count: number
    searching: boolean
    onDelete: () => void
    onClose: () => void
}) {
    const MENU_W = 180
    const MENU_H = 48
    const adjustedX = Math.min(x, window.innerWidth - MENU_W - 10)
    const adjustedY = y + MENU_H > window.innerHeight
        ? Math.max(10, window.innerHeight - MENU_H - 10)
        : y
    const menuText = searching ? `删除组内匹配项 (${count})` : `删除组内备忘录 (${count})`
    return createPortal(
        <div
            role="menu"
            data-testid="memo-group-context-menu"
            style={{position: 'fixed', left: adjustedX, top: adjustedY, zIndex: 9999}}
            className="bg-[var(--surface)] border border-[var(--border-emphasis)] rounded-xl shadow-elevated py-1.5 min-w-[160px] ring-1 ring-black/5"
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <button
                role="menuitem"
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onClose()
                    onDelete()
                }}
                className={`${GROUP_MENU_ITEM_CLASS} text-[var(--error)] hover:bg-[var(--error)]/10`}
                data-name="memo-group-menu-delete-button"
            >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
                </svg>
                {menuText}
            </button>
        </div>,
        document.body,
    )
}

/**
 * 能力徽章类型样式：与 MessageList 用户消息 `/{能力}` 渲染（UserCommandBubble
 * TYPE_STYLE）同构——图标 chip + 能力名着色 + 类型标签，配色保持一致
 */
export const CAP_STYLE: Record<MemoCapability['type'], {icon: string; color: string; bg: string; label: string}> = {
    skill: {icon: '🛠️', color: 'text-[#8b5cf6]', bg: 'bg-[#8b5cf6]/10', label: '技能'},
    agent: {icon: '🤖', color: 'text-[#0ea5e9]', bg: 'bg-[#0ea5e9]/10', label: '代理'},
    command: {icon: '⚡', color: 'text-[#f97316]', bg: 'bg-[#f97316]/10', label: '命令'},
}

/** 能力徽章行（标题上方）：图标 + 名称 + 类型标签，样式复用 UserCommandBubble 惯例 */
function CapabilityBadge({capability}: {capability: MemoCapability}) {
    const style = CAP_STYLE[capability.type]
    return (
        <div className="flex items-center gap-1.5 mb-1" data-testid="memo-capability-badge">
            <span className={`flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-xs ${style.bg}`}>
                {style.icon}
            </span>
            <span className={`text-xs font-medium truncate ${style.color}`}>
                {capability.name}
            </span>
            <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded ${style.bg} ${style.color}`}>
                {style.label}
            </span>
        </div>
    )
}

/** 置顶图标 path（徽标与操作按钮共用） */
const PIN_PATH = 'M16 3v5.06c0 .53.21 1.04.59 1.41L19 12v2h-6v6l-1 1-1-1v-6H5v-2l2.41-2.53c.38-.37.59-.88.59-1.41V3h8z'

/** 单条备忘录行：能力徽章 + 标题 + 附件角标 + 创建时间；active 项可置顶，点击打开独立编辑窗口 */
function MemoItemRow({item, onOpen, processed: processedProp}: {
    item: MemoItem
    onOpen: () => void
    /** 显式标记为已办（历史列表）；省略时按 item.status 推断 */
    processed?: boolean
}) {
    const createSession = useMemoStore((s) => s.createSession)
    const remove = useMemoStore((s) => s.remove)
    const updateItem = useMemoStore((s) => s.updateItem)
    const processed = processedProp ?? item.status !== 'active'
    const conversations = useConversationStore((s) => s.workspaces[s.currentWorkspacePath ?? '']?.conversations ?? [])
    const convExists = item.relatedConvId ? conversations.some((c: {id: string}) => c.id === item.relatedConvId) : false

    const handleDelete = async () => {
        const ok = await confirm({
            title: '删除备忘录',
            message: `确定删除该备忘录吗？\n${item.title}`,
            confirmText: '删除',
            confirmVariant: 'danger',
        })
        if (ok) await remove(item.id)
    }

    const handleCreateSession = async () => {
        const res = await createSession(item.id)
        if (res) {
            useConversationStore.getState().setActiveConversation(res.convId)
        }
    }

    const togglePin = (e: React.MouseEvent) => {
        e.stopPropagation()
        void updateItem(item.id, {pinned: !item.pinned})
    }

    return (
        <div
            data-testid="memo-item"
            data-memo-id={item.id}
            onClick={onOpen}
            className={`group relative p-2.5 rounded-[18px] border border-[var(--border)] bg-[var(--surface-muted)]/60 cursor-pointer transition-all hover:bg-[var(--surface-muted)] active:bg-[var(--surface-muted)] ${processed ? 'opacity-50' : ''}`}
         data-name="memo-panel-div">
            {/* 能力徽章/标题/时间等文字内容占满整行；操作按钮绝对定位覆盖，不预留宽度 */}
            <div className="min-w-0">
                {/* 能力徽章在标题上方（纵向排列） */}
                {item.capability && <CapabilityBadge capability={item.capability}/>}
                {/* 标题行：标题左侧截断，右侧优先级下拉固定不被挤压（仅 active 项显示） */}
                <div className="flex items-center gap-1.5 w-full min-w-0">
                    <div className="text-xs font-medium truncate flex-1" title={item.title || '（无标题）'}>{item.title || '（无标题）'}</div>
                    {!processed && (
                        <PrioritySelect
                            value={item.priority}
                            onChange={(p) => {
                                void updateItem(item.id, {priority: p})
                            }}
                        />
                    )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                    {item.pinned && !processed && (
                        <span title="已置顶" aria-label="已置顶">
                            <svg className="w-3 h-3 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="currentColor">
                                <path d={PIN_PATH}/>
                            </svg>
                        </span>
                    )}
                    <span title={`创建于 ${new Date(item.createdAt).toLocaleString()}`}>{formatRelativeTime(item.createdAt)}</span>
                    {item.attachments.length > 0 && (
                        <span title={`${item.attachments.length} 个附件`}>📎 {item.attachments.length}</span>
                    )}
                    {processed && <span>已处理</span>}
                </div>
            </div>
            {/* hover 操作区：绝对定位覆盖时间行（bottom 锚定），与标题行的优先级下拉垂直错开，不遮挡 */}
            <div className="absolute right-2.5 bottom-1.5 flex items-center gap-1 rounded-full bg-inherit opacity-0 group-hover:opacity-100 transition-opacity">
                {!processed && (
                    <button
                        title={item.pinned ? '取消置顶' : '置顶'}
                        aria-label={item.pinned ? '取消置顶' : '置顶'}
                        onClick={togglePin}
                        data-tooltip-placement="left"
                        className={`${ACTION_BTN_BASE} ${item.pinned ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--brand-primary)]'}`}
                     data-name="memo-pin-button">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={item.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                            <path d={PIN_PATH}/>
                        </svg>
                    </button>
                )}
                {processed ? (
                    item.relatedConvId && (
                        <button
                            title="跳转到关联会话"
                            aria-label="跳转到关联会话"
                            disabled={!convExists}
                            data-tooltip-placement="left"
                            onClick={(e) => {
                                e.stopPropagation()
                                useConversationStore.getState().setActiveConversation(item.relatedConvId!)
                            }}
                            className={`${ACTION_BTN_MUTED} disabled:opacity-30 disabled:cursor-not-allowed`}
                         data-name="memo-open-conv-button">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 12h14M12 5l7 7-7 7"/>
                            </svg>
                        </button>
                    )
                ) : (
                    <button
                        title="创建会话处理"
                        aria-label="创建会话处理"
                        data-tooltip-placement="left"
                        onClick={(e) => {
                            e.stopPropagation()
                            void handleCreateSession()
                        }}
                        className={ACTION_BTN_MUTED}
                     data-name="memo-create-session-button">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M5 3l14 9-14 9V3z"/>
                        </svg>
                    </button>
                )}
                <button
                    title="删除"
                    aria-label="删除"
                    data-tooltip-placement="left"
                    onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete()
                    }}
                    className={`${ACTION_BTN_BASE} text-[var(--text-muted)] hover:text-red-500`}
                 data-name="memo-panel-trigger-button">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
                    </svg>
                </button>
            </div>
        </div>
    )
}
