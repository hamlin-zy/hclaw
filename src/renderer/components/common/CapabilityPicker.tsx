/**
 * CapabilityPicker - 可用能力选择器（公共组件）
 *
 * 合并 Agent / Skill / 用户命令 / 插件命令（按名称去重，优先级排序），
 * 提供搜索 + 点选列表。供 ScheduleEditModal 与 MemoPanel 等共用。
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useUserCommandStore} from '../../stores/userCommandStore'
import {useAgentTemplateStore} from '../../stores/agentTemplateStore'
import {useSkillStore} from '../../stores/skillStore'
import {fuzzyFilter} from '../../lib/search'

interface CapabilityItem {
    id: string
    name: string
    description?: string
    sourceLabel: string
    sourceColor: string
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

export default function CapabilityPicker({selected, onSelect}: {
    selected: string
    onSelect: (name: string, type: string) => void
}) {
    const [search, setSearch] = useState('')
    const [allItems, setAllItems] = useState<CapabilityItem[]>([])
    const [loading, setLoading] = useState(true)
    // 键盘导航高亮索引（搜索结果列表中当前聚焦项）
    const [highlightIndex, setHighlightIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        loadCapabilities()
    }, [])

    const loadCapabilities = async () => {
        setLoading(true)
        try {
            // 加载数据源
            useUserCommandStore.getState().loadCommands()
            useAgentTemplateStore.getState().syncFromDisk()
            useSkillStore.getState().loadSkills()

            // 等待状态更新后读取 - 用 setTimeout 让 store 完成异步加载
            await new Promise(r => setTimeout(r, 200))

            const items: CapabilityItem[] = []
            const seen = new Set<string>()

            // 从最新 store 读取
            const agents = useAgentTemplateStore.getState().templates
            const skillList = useSkillStore.getState().skills
            const cmdList = useUserCommandStore.getState().commands

            // 展平顺序与 Ctrl+K 命令面板（CommandList）一致：用户命令 → 插件命令 → 技能 → Agent。
            // 该顺序决定搜索同分时的稳定排序结果；无搜索时统一按名称字母序展示。

            // 用户命令
            for (const c of cmdList) {
                const key = c.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({id: c.name, name: c.name, description: c.description || '', sourceLabel: '命令', sourceColor: 'bg-amber-500/10 text-amber-500'})
                }
            }

            // 插件命令
            try {
                const pluginCmds = await window.electronAPI?.plugin?.getCommands?.()
                if (pluginCmds) {
                    for (const [, cmds] of Object.entries<any[]>(pluginCmds)) {
                        for (const cmd of cmds) {
                            const key = cmd.name?.toLowerCase() || cmd.id?.toLowerCase()
                            if (key && !seen.has(key)) {
                                seen.add(key)
                                items.push({id: cmd.id, name: cmd.name, description: cmd.description || '', sourceLabel: '插件', sourceColor: 'bg-gray-500/10 text-gray-500'})
                            }
                        }
                    }
                }
            } catch {}

            // Skill
            for (const s of skillList) {
                const key = s.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({id: s.name, name: s.name, description: (s as any).description || '', sourceLabel: 'Skill', sourceColor: 'bg-purple-500/10 text-purple-500'})
                }
            }

            // Agent
            for (const t of agents) {
                const key = t.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({id: t.name, name: t.name, description: t.description || t.userDescription || '', sourceLabel: 'Agent', sourceColor: 'bg-blue-500/10 text-blue-500'})
                }
            }

            setAllItems(items)
        } finally {
            setLoading(false)
        }
    }

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
        onSelect(cap.name, cap.sourceLabel === 'Agent' ? 'agent' : cap.sourceLabel === 'Skill' ? 'skill' : 'command')
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
            <div
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--surface-muted)] rounded-md border border-[var(--border)] shadow-sm focus-within:border-[var(--border-emphasis)] focus-within:shadow-md transition-all">
                {selected && (
                    <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 shrink-0">
                        {selected}
                        <button
                            type="button"
                            onClick={handleClear}
                            className="hover:opacity-70"
                         data-name="capability-picker-button">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
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
                    className="flex-1 min-w-0 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                    autoFocus
                data-name="capability-picker-input"/>
            </div>
            <div ref={listRef} className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-[var(--border)]">
                {loading ? (
                    <div className="p-3 text-center text-[10px] text-[var(--text-muted)]">加载中...</div>
                ) : displayItems.length === 0 ? (
                    <div className="p-3 text-center text-[10px] text-[var(--text-muted)]">
                        {search ? '未找到匹配的能力' : '暂无可用能力'}
                    </div>
                ) : (
                    displayItems.map((cap, i) => (
                        <button
                            key={cap.id}
                            onClick={() => {
                                pickCapability(cap)
                            }}
                            className={`w-full text-left px-3 py-2 text-xs border-b border-[var(--border)] last:border-b-0 transition-colors ${
                                selected === cap.name
                                    ? 'bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400'
                                    : i === highlightIndex
                                        ? 'bg-[var(--surface-muted)] text-[var(--text-primary)]'
                                        : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                            }`}
                         data-name={`capability-picker-option-${i}`}>
                            <div className="flex items-center gap-1.5">
                                <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${cap.sourceColor}`}>
                                    {cap.sourceLabel}
                                </span>
                                <span className="font-medium">{cap.name}</span>
                            </div>
                            {cap.description && (
                                <div className="mt-0.5 text-[10px] text-[var(--text-muted)] truncate">{cap.description}</div>
                            )}
                        </button>
                    ))
                )}
            </div>
        </div>
    )
}
