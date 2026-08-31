/**
 * CapabilityPicker - 可用能力选择器（公共组件）
 *
 * 合并 Agent / Skill / 用户命令 / 插件命令（按名称去重，优先级排序），
 * 提供搜索 + 点选列表。供 ScheduleEditModal 与 MemoPanel 等共用。
 */

import React, {useCallback, useEffect, useMemo, useState} from 'react'
import {useUserCommandStore} from '../../stores/userCommandStore'
import {useAgentTemplateStore} from '../../stores/agentTemplateStore'
import {useSkillStore} from '../../stores/skillStore'
import {fuzzyFilterWithRank} from '../../lib/search'

interface CapabilityItem {
    id: string
    name: string
    description?: string
    sourceLabel: string
    sourceColor: string
}

export default function CapabilityPicker({selected, onSelect}: {
    selected: string
    onSelect: (name: string, type: string) => void
}) {
    const [search, setSearch] = useState('')
    const [allItems, setAllItems] = useState<CapabilityItem[]>([])
    const [loading, setLoading] = useState(true)

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

            const items: { item: CapabilityItem; rank: number }[] = []
            const seen = new Set<string>()

            // 从最新 store 读取
            const agents = useAgentTemplateStore.getState().templates
            const skillList = useSkillStore.getState().skills
            const cmdList = useUserCommandStore.getState().commands

            // Agent（优先级最高）
            for (const t of agents) {
                const key = t.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({
                        item: {id: t.name, name: t.name, description: t.description || t.userDescription || '', sourceLabel: 'Agent', sourceColor: 'bg-blue-500/10 text-blue-500'},
                        rank: 0,
                    })
                }
            }

            // Skill
            for (const s of skillList) {
                const key = s.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({
                        item: {id: s.name, name: s.name, description: (s as any).description || '', sourceLabel: 'Skill', sourceColor: 'bg-purple-500/10 text-purple-500'},
                        rank: 1,
                    })
                }
            }

            // 用户命令
            for (const c of cmdList) {
                const key = c.name.toLowerCase()
                if (!seen.has(key)) {
                    seen.add(key)
                    items.push({
                        item: {id: c.name, name: c.name, description: c.description || '', sourceLabel: '命令', sourceColor: 'bg-amber-500/10 text-amber-500'},
                        rank: 2,
                    })
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
                                items.push({
                                    item: {id: cmd.id, name: cmd.name, description: cmd.description || '', sourceLabel: '插件', sourceColor: 'bg-gray-500/10 text-gray-500'},
                                    rank: 3,
                                })
                            }
                        }
                    }
                }
            } catch {}

            setAllItems(items.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name)).map(x => x.item))
        } finally {
            setLoading(false)
        }
    }

    const displayItems = useMemo(() => {
        if (!search.trim()) return allItems
        return fuzzyFilterWithRank(allItems, search, ['name', 'description']).map(r => r.item)
    }, [allItems, search])

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
                    placeholder={selected ? '' : '搜索可用能力...'}
                    className="flex-1 min-w-0 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                    autoFocus
                data-name="capability-picker-input"/>
            </div>
            <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-[var(--border)]">
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
                                onSelect(cap.name, cap.sourceLabel === 'Agent' ? 'agent' : cap.sourceLabel === 'Skill' ? 'skill' : 'command')
                                setSearch('')
                            }}
                            className={`w-full text-left px-3 py-2 text-xs border-b border-[var(--border)] last:border-b-0 transition-colors ${
                                selected === cap.name
                                    ? 'bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400'
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
