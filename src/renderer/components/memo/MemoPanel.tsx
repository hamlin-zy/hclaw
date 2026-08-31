/**
 * MemoPanel - 备忘录面板（Task 8，UI 修订轮 Task C 精简为纯列表）
 *
 * 挂载于右侧边栏容器（SidePanels）。挂载时 load 当前工作区备忘录并
 * subscribeMemoChanged（workspacePath 相等才刷新）。
 *
 * - 背景：半透明 surface 底色（--bg-surface-alpha-inner）+ blur（globals.css .memo-panel-card，
 *   对齐 left-sidebar-card）；内部项透明底 + hover 半透明，无实底卡片
 * - 列表条目：能力徽章（上）+ 标题（下）+ 附件角标（数量），圆角卡片项
 *   （rounded-[18px]，对齐会话列表 ConversationItem）；不展示正文、不内联编辑
 * - 点击条目 → openConfigWindow('memo-edit', ['--hclaw-memo-id=<id>'])
 * - 新增按钮 → openConfigWindow('memo-edit', ['--hclaw-memo-workspace=<path>'])
 * - 搜索：关键词过滤 title + content（大小写不敏感）
 * - 排序：active 在前（updatedAt desc），processed 沉底置灰
 * - 会话处理：active 项 ▶ 创建会话处理；processed 项跳转关联会话（不存在则禁用）
 * - 面板右缘按钮 tooltip：用 TipButton 局部实现（向左展开 + nowrap）。
 *   TooltipPortal 全局组件仅支持 above/below/right 且无右缘钳制，不改公共组件，
 *   故面板内易被右缘遮挡的按钮不用 title（避免被 TooltipPortal 接管）而走局部方案
 */
import React, {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {useMemoStore, subscribeMemoChanged} from '../../stores/memoStore'
import {useConversationStore} from '../../stores/conversationStore'
import {useSidebarStore} from '../../stores/sidebarStore'
import {confirm} from '../ConfirmDialog'
import {formatRelativeTime} from '../../lib/relativeTime'
import {sortMemos, reorderGroup, renumberGroup} from './memoSort'
import type {MemoCapability, MemoItem} from '@shared/types/memo'

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

    useEffect(() => {
        if (!wsPath) return
        void load(wsPath)
        return subscribeMemoChanged(() => useConversationStore.getState().currentWorkspacePath ?? '')
    }, [wsPath, load])

    const sorted = useMemo(() => {
        const kw = keyword.trim().toLowerCase()
        const list = kw
            ? memos.filter((m) =>
                m.title.toLowerCase().includes(kw) || m.content.toLowerCase().includes(kw))
            : [...memos]
        // 排序规则：未处理分组在前 → 组内 pinned 优先 → sortIndex desc → createdAt asc
        return sortMemos(list)
    }, [memos, keyword])

    const updateItem = useMemoStore((s) => s.updateItem)
    // 拖拽排序：记录被拖拽项 id，落到目标行后组内重排 + 全量重编号落库
    const [dragId, setDragId] = useState<string | null>(null)

    const handleDrop = async (targetId: string) => {
        const fromId = dragId
        setDragId(null)
        if (!fromId || fromId === targetId) return
        // 仅 active 组可拖拽（processed 不可拖、不可作为落点）
        const group = sorted.filter((m) => m.status === 'active')
        const from = group.findIndex((m) => m.id === fromId)
        const target = group.findIndex((m) => m.id === targetId)
        if (from === -1 || target === -1) return
        const reordered = reorderGroup(group, fromId, target)
        if (!reordered) return // 违反约束（未置顶上穿置顶区）→ 拒绝
        for (const {id, sortIndex} of renumberGroup(reordered)) {
            await updateItem(id, {sortIndex})
        }
    }

    // workspacePath/id 经 encodeURIComponent 编码后传参（路径含空格/`=` 时不会被 argv 切断，preload 侧解码）
    const openEdit = (id: string) => {
        void window.electronAPI?.openConfigWindow?.('memo-edit', [`--hclaw-memo-id=${encodeURIComponent(id)}`])
    }
    const openCreate = () => {
        if (!wsPath) return
        void window.electronAPI?.openConfigWindow?.('memo-edit', [`--hclaw-memo-workspace=${encodeURIComponent(wsPath)}`])
    }

    const activeCount = memos.filter((m) => m.status === 'active').length

    return (
        <div className="memo-panel-card flex flex-col h-full text-[var(--text-primary)]">
            {/* 顶部：标题 + 新建 */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
                <span className="text-xs font-medium text-[var(--text-muted)]">备忘录</span>
                <TipButton
                    tip="新建备忘录"
                    label="新建备忘录"
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
                    // 对齐会话列表 SearchInput：胶囊圆角 + 半透明底 + focus ring
                    // 注：文字/占位符有意用 --text-primary/--text-muted token 而非会话列表的 gray-800/gray-200（token 化偏差，非不一致）
                    className="w-full px-4 py-2 bg-gray-100/60 dark:bg-white/5 rounded-[36px] text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:bg-white dark:focus:bg-[#1A1A1A] focus:ring-2 focus:ring-gray-200 dark:focus:ring-white/10 focus:border-transparent transition-all hover:bg-gray-100/80 dark:hover:bg-white/10"
                data-name="memo-panel-input"/>
            </div>

            {/* 列表（胶囊圆角项 + hover 半透明，对齐会话列表 ConversationItem） */}
            <div className="flex-1 overflow-y-auto px-[var(--space-relaxed)] py-[var(--space-tight)] space-y-[1px]">
                {loading && sorted.length === 0 && (
                    <div className="p-4 text-center text-xs text-[var(--text-muted)]">加载中...</div>
                )}
                {!loading && sorted.length === 0 && (
                    <div className="p-4 text-center text-xs text-[var(--text-muted)]">
                        {keyword ? '无匹配的备忘录' : '暂无备忘录'}
                    </div>
                )}
                {sorted.map((m) => (
                    <MemoItemRow
                        key={m.id}
                        item={m}
                        onOpen={() => openEdit(m.id)}
                        dragging={dragId === m.id}
                        onDragStart={() => setDragId(m.id)}
                        onDragEnd={() => setDragId(null)}
                        onDrop={() => void handleDrop(m.id)}
                    />
                ))}
            </div>

            {/* 底部统计 + 折叠按钮：布局对齐会话列表 footer 的 status-row（按钮在统计旁） */}
            <div className="shrink-0 px-3 py-2 border-t border-[var(--border)] flex items-center justify-between gap-2">
                <div
                    data-testid="memo-stats"
                    className="text-2xs text-[var(--text-muted)]"
                >
                    待处理 {activeCount} · 已处理 {memos.length - activeCount}
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

/** 单条备忘录行：能力徽章 + 标题 + 附件角标 + 创建时间；active 项可置顶/拖拽，点击打开独立编辑窗口 */
function MemoItemRow({item, onOpen, dragging, onDragStart, onDragEnd, onDrop}: {
    item: MemoItem
    onOpen: () => void
    dragging: boolean
    onDragStart: () => void
    onDragEnd: () => void
    onDrop: () => void
}) {
    const createSession = useMemoStore((s) => s.createSession)
    const remove = useMemoStore((s) => s.remove)
    const updateItem = useMemoStore((s) => s.updateItem)
    const processed = item.status !== 'active'
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
            // 拖拽：仅 active 项可拖；processed 不可拖、不响应 drop
            draggable={!processed}
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', item.id)
                onDragStart()
            }}
            onDragEnd={onDragEnd}
            onDragOver={(e) => {
                if (!processed) e.preventDefault()
            }}
            onDrop={(e) => {
                if (processed) return
                e.preventDefault()
                onDrop()
            }}
            // 对齐 ConversationItem：透明底 + 胶囊圆角 + hover/active 半透明，无实底卡片
            className={`group relative p-2.5 rounded-[18px] border border-transparent cursor-pointer transition-all hover:bg-gray-50 dark:hover:bg-white/5 active:bg-gray-100 dark:active:bg-white/10 ${processed ? 'opacity-50' : ''} ${dragging ? 'opacity-30' : ''}`}
         data-name="memo-panel-div">
            {/* 能力徽章/标题/时间等文字内容占满整行；操作按钮绝对定位覆盖，不预留宽度（opacity-0 仅视觉隐藏仍占布局，会把文字列挤窄导致提前截断） */}
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
