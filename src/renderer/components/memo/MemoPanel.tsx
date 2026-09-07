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
 * 其余视觉对齐（胶囊圆角项、TipButton 等）见各组件内联注释。
 */
import React, {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Reorder} from 'framer-motion'
import {useMemoStore, subscribeMemoChanged, openMemoCreateWindow} from '../../stores/memoStore'
import {useConversationStore} from '../../stores/conversationStore'
import {useSidebarStore} from '../../stores/sidebarStore'
import {confirm} from '../ConfirmDialog'
import {formatRelativeTime} from '../../lib/relativeTime'
import {useDayBoundaryTick} from '../../hooks/useDayBoundaryTick'
import {sortActiveMemos, groupProcessedByDate, renumberGroup, countGroupItems} from './memoSort'
import type {ProcessedDateGroup} from './memoSort'
import type {MemoCapability, MemoItem} from '@shared/types/memo'

const PENDING_TAB = 'pending' as const
const HISTORY_TAB = 'history' as const
type MemoTab = typeof PENDING_TAB | typeof HISTORY_TAB

/** TipButton 共用样式：面板内所有 hover 操作按钮的底样式，颜色类由调用处追加 */
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
    // 拖拽：dragOrder 覆盖派生顺序，提供乐观更新驱动 FLIP 动画；onDragEnd 落库后清空回到派生顺序
    const [dragOrder, setDragOrder] = useState<string[] | null>(null)
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
                <TipButton
                    tip="新建备忘录 (Ctrl+Shift+N)"
                    label="新建备忘录 (Ctrl+Shift+N)"
                    onClick={openCreate}
                    className={ACTION_BTN_MUTED}
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                </TipButton>
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
                                        onDragEnd={() => void handleDragEnd()}
                                        // 拖拽提起视觉：轻微缩放 + 阴影，松手回弹
                                        whileDrag={{scale: 1.02, boxShadow: '0 4px 12px rgba(0,0,0,0.15)'}}
                                        className="list-none"
                                    >
                                        <MemoItemRow item={m} onOpen={() => openEdit(m.id)}/>
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
                        />
                    ))
                )}
            </div>

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
                    title="折叠右侧面板 (Ctrl+Shift+B)"
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
function GroupNode({group, parentKey, expandedKeys, onToggle, onOpen}: {
    group: ProcessedDateGroup
    parentKey: string
    expandedKeys: Set<string>
    onToggle: (key: string) => void
    onOpen: (id: string) => void
}) {
    const key = parentKey ? `${parentKey}/${group.label}` : group.label
    const expanded = expandedKeys.has(key)
    const depth = parentKey ? parentKey.split('/').length : 0
    const count = countGroupItems(group)

    return (
        <div data-testid="memo-group" data-group-key={key}>
            <button
                onClick={() => onToggle(key)}
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
                            />
                        ))
                    }
                </div>
            )}
        </div>
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

/**
 * 面板右缘按钮的局部 tooltip：向左展开（右缘对齐按钮右缘）+ 不换行。
 * 不使用 title 属性——TooltipPortal 会全局接管 [title] 且仅支持
 * above/below/right 放置（无左向/右缘钳制），故走局部 Portal 方案。
 */
function TipButton({tip, label, onClick, className, disabled, children}: {
    tip: string
    label: string
    onClick?: (e: React.MouseEvent) => void
    className: string
    disabled?: boolean
    children: React.ReactNode
}) {
    const [anchor, setAnchor] = useState<{top: number; right: number} | null>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    // 列表 reorder（remove+insert）会替换按钮 DOM 节点，Chrome 不补发 mouseleave，
    // 仅靠元素级 onMouseLeave 会滞留 anchor 导致 tip 永不关闭。
    // 故在 tip 显示期间挂 document 级监听：指针不在按钮上即关闭（对节点替换免疫）。
    useEffect(() => {
        if (!anchor) return
        const onMove = (e: MouseEvent) => {
            if (!btnRef.current?.contains(e.target as Node)) setAnchor(null)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('pointerover', onMove)
        return () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('pointerover', onMove)
        }
    }, [anchor])
    return (
        <>
            <button
                ref={btnRef}
                aria-label={label}
                onClick={onClick}
                disabled={disabled}
                onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setAnchor({top: r.bottom, right: r.right})
                }}
                onMouseLeave={() => setAnchor(null)}
                className={className}
             data-name="memo-panel-trigger-button">
                {children}
            </button>
            {anchor && createPortal(
                <div
                    data-testid="memo-tip"
                    style={{
                        position: 'fixed',
                        top: anchor.top + 6,
                        left: anchor.right,
                        transform: 'translateX(-100%)',
                        whiteSpace: 'nowrap',
                        padding: '4px 8px',
                        background: 'var(--surface-elevated)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        boxShadow: 'var(--shadow-overlay)',
                        fontSize: '11px',
                        borderRadius: '4px',
                        pointerEvents: 'none',
                        zIndex: 2147483647,
                    }}
                >
                    {tip}
                </div>,
                document.body,
            )}
        </>
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
            className={`group relative p-2.5 rounded-[18px] border border-transparent cursor-pointer transition-all hover:bg-gray-50 dark:hover:bg-white/5 active:bg-gray-100 dark:active:bg-white/10 ${processed ? 'opacity-50' : ''}`}
         data-name="memo-panel-div">
            {/* 能力徽章/标题/时间等文字内容占满整行；操作按钮绝对定位覆盖，不预留宽度 */}
            <div className="min-w-0">
                {/* 能力徽章在标题上方（纵向排列） */}
                {item.capability && <CapabilityBadge capability={item.capability}/>}
                <div className="text-xs font-medium break-words">{item.title || '（无标题）'}</div>
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
            {/* hover 操作区：绝对定位覆盖右侧，bg-inherit 盖住下方文字保证可读性 */}
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-full bg-inherit opacity-0 group-hover:opacity-100 transition-opacity">
                {!processed && (
                    <TipButton
                        tip={item.pinned ? '取消置顶' : '置顶'}
                        label={item.pinned ? '取消置顶' : '置顶'}
                        onClick={togglePin}
                        className={`${ACTION_BTN_BASE} ${item.pinned ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--brand-primary)]'}`}
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={item.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                            <path d={PIN_PATH}/>
                        </svg>
                    </TipButton>
                )}
                {processed ? (
                    item.relatedConvId && (
                        <TipButton
                            tip="跳转到关联会话"
                            label="跳转到关联会话"
                            disabled={!convExists}
                            onClick={(e) => {
                                e.stopPropagation()
                                useConversationStore.getState().setActiveConversation(item.relatedConvId!)
                            }}
                            className={`${ACTION_BTN_MUTED} disabled:opacity-30 disabled:cursor-not-allowed`}
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 12h14M12 5l7 7-7 7"/>
                            </svg>
                        </TipButton>
                    )
                ) : (
                    <TipButton
                        tip="创建会话处理"
                        label="创建会话处理"
                        onClick={(e) => {
                            e.stopPropagation()
                            void handleCreateSession()
                        }}
                        className={ACTION_BTN_MUTED}
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M5 3l14 9-14 9V3z"/>
                        </svg>
                    </TipButton>
                )}
                <TipButton
                    tip="删除"
                    label="删除"
                    onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete()
                    }}
                    className={`${ACTION_BTN_BASE} text-[var(--text-muted)] hover:text-red-500`}
                >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
                    </svg>
                </TipButton>
            </div>
        </div>
    )
}
