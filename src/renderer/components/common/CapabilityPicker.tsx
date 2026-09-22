/**
 * CapabilityPicker - 可用能力选择器（公共组件）
 *
 * 合并 Agent / Skill / 命令（插件命令单独标注，按名称去重、按来源优先级排序），
 * 提供搜索 + 点选列表。供 ScheduleEditModal 与 MemoEditDialog 等共用。
 *
 * 数据来源：CapabilityHub 投影（`capability:query`）——全应用唯一的「可用能力」来源，
 * 与命令管理页等能力页面同源。组件不再自行拼装多条旁路（三个渲染层 store +
 * 插件命令 IPC）并靠固定时长定时器赌 store 异步加载完成：
 *   - 取数收敛为**一次**跨进程往返，await 返回即就绪（确定性信号，不靠固定时长定时器等待）；
 *   - 启用态（`enabled`）与插件归属（`source`/`pluginName`）由 Hub 判定，
 *     本组件只消费，不重新解释（`enabled: true` 作为查询条件交给 Hub 过滤）；
 *   - 能力集合变更经 `capability:changed` 订阅自动反映到最新（useCapabilityRefresh）。
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {fuzzyFilter} from '../../lib/search'
import {useCapabilityRefresh} from '../../hooks/useCapabilityRefresh'
import type {CapabilityEntry} from '../../capabilityTypes'

interface CapabilityItem {
    id: string
    name: string
    description?: string
    sourceLabel: string
    type: 'skill' | 'agent' | 'command'
}

/**
 * 展平/去重优先级桶：与旧实现一致（用户与内置命令 → 插件命令 → 技能 → Agent）。
 * 同名能力保留先出现者；该顺序同时决定搜索同分时的稳定排序结果。
 */
function bucketOf(entry: CapabilityEntry): 0 | 1 | 2 | 3 {
    if (entry.type === 'command') return entry.source === 'plugin' ? 1 : 0
    return entry.type === 'skill' ? 2 : 3
}

/**
 * 每个桶的来源**文字标签**。
 *
 * ui-09 复核整改（C5 / C7 / H6）：原先用 Tailwind 原生调色板类名给来源着色
 * （`amber` / `gray` / `purple` / `blue` 一族）。四个主题块只重定义 CSS 变量、
 * 不重定义调色板，故那组类名等价于硬编码，主题切换时不跟随；且它们被用作
 * 9px 小字文字色，实测四主题仅 1.99~3.50:1。现改为中性文字级令牌（见 SOURCE_BADGE），
 * 来源信息由**文字标签**承载——色觉障碍与读屏用户拿到的是同一份信息。
 */
const BUCKET_LABEL: Record<0 | 1 | 2 | 3, string> = {
    0: '命令',
    1: '插件',
    2: 'Skill',
    3: 'Agent',
}

/**
 * 来源徽标的样式（ui-09 复核整改）。
 *
 * - 文字色 `--text-secondary`：落在 `scripts/audit-contrast.mjs` 的 14 个文字级令牌之内，
 *   四主题下对 `--surface` / `--surface-muted` / `--surface-elevated` 均 ≥4.5:1
 *   （`:root` 4.58 / `.dark` 5.72 / `.yuanshandai` 4.62 / `.shiyangjin` 4.73，最差一档对
 *   `--surface-muted`）。**不用** `--brand-primary` 一类填充色当 ≤14px 文字色（C7 母句），
 *   也不用 Tailwind 调色板类名（C5）。
 * - 徽标只描边、不设底色：选项行在「选中 / 键盘高亮 / 静息」三态下底色本就不同，
 *   带底色的徽标必有一态与行底撞色。
 */
const SOURCE_BADGE = 'border border-[var(--border)] text-[var(--text-secondary)]'

/** Hub 投影 → 选择器条目（排序 + 按名称去重） */
function toItems(entries: CapabilityEntry[]): CapabilityItem[] {
    const ordered = [...entries].sort((a, b) => bucketOf(a) - bucketOf(b))
    const items: CapabilityItem[] = []
    const seen = new Set<string>()
    for (const entry of ordered) {
        const key = entry.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const sourceLabel = BUCKET_LABEL[bucketOf(entry)]
        items.push({
            id: entry.id,
            name: entry.name,
            description: entry.description || '',
            sourceLabel,
            type: entry.type,
        })
    }
    return items
}

export default function CapabilityPicker({selected, onSelect, autoFocus = true}: {
    selected: string
    onSelect: (name: string, type: string) => void
    /** 打开即聚焦搜索框；宿主弹窗有自己的初始焦点字段时传 false，避免两个 autoFocus 抢焦点 */
    autoFocus?: boolean
}) {
    const [search, setSearch] = useState('')
    const [allItems, setAllItems] = useState<CapabilityItem[]>([])
    const [loading, setLoading] = useState(true)
    // 键盘导航高亮索引（搜索结果列表中当前聚焦项）
    const [highlightIndex, setHighlightIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    // 卸载守卫：挂载期发起的取数 resolve 后不再 setState
    const cancelledRef = useRef(false)

    /**
     * 单次跨进程取数：Hub 只读投影（列表出口默认不含正文）。
     * await 返回即为「就绪」，不依赖任何固定时长等待。
     */
    const loadCapabilities = useCallback(async () => {
        const entries = await window.electronAPI?.capability?.query?.({enabled: true})
        if (cancelledRef.current) return
        setAllItems(toItems(Array.isArray(entries) ? entries : []))
        setLoading(false)
    }, [])

    useEffect(() => {
        cancelledRef.current = false
        return () => { cancelledRef.current = true }
    }, [])

    // 挂载即取数 + 订阅 capability:changed（能力变更后自动反映到最新）
    useCapabilityRefresh(loadCapabilities)

    // 排序与 Ctrl+K 命令面板（CommandList.flatCommands）对齐：
    // 无搜索 → 全局名称字母序；有搜索 → 相关度降序（同分保持展平原序，稳定排序）。
    // rank 评分函数与 CommandList.rank 保持一致，勿单方面修改。
    const displayItems = useMemo(() => {
        if (!search.trim()) {
            return [...allItems].sort((a, b) => a.name.localeCompare(b.name))
        }
        const matched = fuzzyFilter(allItems, search, ['name', 'description'])
        const query = search.trim().toLowerCase()
        matched.sort((a, b) => searchRank(b, query) - searchRank(a, query))
        return matched
    }, [allItems, search])

    // 搜索词或结果集变化时重置高亮到首项
    useEffect(() => {
        setHighlightIndex(0)
    }, [search, allItems])

    // 高亮项滚动到可视区域
    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-name="capability-picker-option-${highlightIndex}"]`)
        // jsdom 无 scrollIntoView，可选调用兼容测试环境
        el?.scrollIntoView?.({block: 'nearest'})
    }, [highlightIndex, displayItems.length, loading])

    const pickCapability = useCallback((cap: CapabilityItem) => {
        onSelect(cap.name, cap.type)
        setSearch('')
    }, [onSelect])

    /** 输入框键盘导航：↑/↓ 移动高亮（循环），Enter 选中，Escape 清空搜索 */
    const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (loading || displayItems.length === 0) return
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightIndex(i => (i + 1) % displayItems.length)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightIndex(i => (i - 1 + displayItems.length) % displayItems.length)
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const cap = displayItems[highlightIndex]
            if (cap) pickCapability(cap)
        } else if (e.key === 'Escape') {
            setSearch('')
        }
    }, [loading, displayItems, highlightIndex, pickCapability])

    const handleClear = useCallback(() => {
        onSelect('', '')
        setSearch('')
    }, [onSelect])

    return (
        <div>
            {/* 视觉外壳（假输入框）：内层 input 无边框、radius=0，故焦点样式由本容器承担——
                与 AgentsDialog 的 TagInput、QuickOpen 的搜索框同一配方。若把 INPUT_FOCUS 套在内层
                input 上，ring 会跟随其 0 圆角退化成直角描边、贴在圆角容器内侧（2026-09-21 用户反馈
                「激活时的边框没有圆角」）。契约豁免见 tests/renderer/inputFocusSeam.test.ts。 */}
            <div
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md border border-[var(--border)] shadow-sm focus-within:border-[var(--border-emphasis)] focus-within:ring-1 focus-within:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] focus-within:shadow-md transition-all">
                {selected && (
                    // 已选能力徽标：品牌实底 + 白字（设计系统承白组合，与 FilePicker 徽标同款）。
                    // 曾试过「提亮底 + --brand-ink 深字」：四主题实测对比 2.08~3.45:1，
                    // 10px 小字要求 4.5:1，无解（2026-09-19 实测披露）。亮度不足是主题
                    // --brand-primary 取值问题（远山黛/石漾金偏低饱和），非徽标样式问题。
                    <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-[var(--brand-primary)] text-white shrink-0">
                        {selected}
                        <button
                            type="button"
                            onClick={handleClear}
                            aria-label={`清除已选能力 ${selected}`}
                            className="hover:opacity-70"
                         data-name="capability-picker-button">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2" aria-hidden="true">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </span>
                )}
                <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={selected ? '' : '搜索可用能力...'}
                    className="flex-1 min-w-0 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)]"
                    autoFocus={autoFocus}
                data-name="capability-picker-input"/>
            </div>
            <div ref={listRef} className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-[var(--border)]">
                {loading ? (
                    <div className="p-3 text-center text-2xs text-[var(--text-secondary)]">加载中...</div>
                ) : displayItems.length === 0 ? (
                    <div className="p-3 text-center text-2xs text-[var(--text-secondary)]">
                        {search ? '未找到匹配的能力' : '暂无可用能力'}
                    </div>
                ) : (
                    displayItems.map((cap, i) => (
                        <button
                            key={cap.id}
                            onClick={() => pickCapability(cap)}
                            className={`w-full text-left px-3 py-2 text-xs border-b border-[var(--border-muted)] last:border-b-0 transition-colors ${
                                selected === cap.name
                                    ? 'bg-[var(--surface-muted)] text-[var(--text-secondary)]'
                                    : i === highlightIndex
                                        ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
                                        : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                            }`}
                         data-name={`capability-picker-option-${i}`}>
                            <div className="flex items-center gap-1.5">
                                <span className={`px-1 py-0.5 rounded text-2xs font-medium ${SOURCE_BADGE}`}>
                                    {cap.sourceLabel}
                                </span>
                                <span className="font-medium">{cap.name}</span>
                            </div>
                            {cap.description && (
                                <div className="mt-0.5 text-2xs text-[var(--text-secondary)] truncate">{cap.description}</div>
                            )}
                        </button>
                    ))
                )}
            </div>
        </div>
    )
}

/** 相关度评分：与 CommandList.rank（Ctrl+K 命令面板）一致 */
function searchRank(item: CapabilityItem, query: string): number {
    if (!query) return 0
    const name = item.name.toLowerCase()
    const desc = (item.description || '').toLowerCase()
    const isSubsequence = (text: string): boolean => {
        let qi = 0
        for (let ti = 0; ti < text.length && qi < query.length; ti++) {
            if (text[ti] === query[qi]) qi++
        }
        return qi === query.length
    }
    return name.startsWith(query) ? 100
        : name.includes(query) ? 80
        : isSubsequence(name) ? 60
        : desc.startsWith(query) ? 50
        : desc.includes(query) ? 30
        : 10
}
