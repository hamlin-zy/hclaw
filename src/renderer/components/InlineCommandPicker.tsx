/**
 * InlineCommandPicker — 浮动式 / 命令补全下拉
 * 交互：↑↓ 导航 · Tab/Enter 补全 · Esc 关闭
 */

import {motion} from 'framer-motion'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

interface CommandItem {
    id: string;
    name: string;
    description?: string
    hasArgs: boolean;
    source: 'plugin' | 'user' | 'skill' | 'agent'
}

interface Props {
    query: string
    onClose: () => void
    onComplete: (text: string) => void
}

// 源配置：{背景色, 文字色, 标签, 图标}
const SRC = {
    skill: {c: 'bg-[#8b5cf6]/10', t: 'text-[#8b5cf6]', l: '技能', i: '🧠'},
    agent: {c: 'bg-[#0ea5e9]/10', t: 'text-[#0ea5e9]', l: '代理', i: '🤖'},
    user: {c: 'bg-[#f97316]/10', t: 'text-[#f97316]', l: '用户', i: '⚡'},
    plugin: {c: 'bg-[#6b7280]/10', t: 'text-[#6b7280]', l: '插件', i: '⚡'},
} as const

const api = () => window.electronAPI

async function loadGroups() {
    const [skill, agent, userRaw] = await Promise.all([
        api()?.command?.getSkillCommands?.() ?? [],
        api()?.command?.getAgentCommands?.() ?? [],
        api()?.command?.getUserCommands?.() ?? [],
    ])
    const user = (Array.isArray(userRaw) ? userRaw : userRaw?.data ?? []).filter((c: any) => c.enabled)
    return [
        skill.length && {
            label: '技能',
            source: 'skill',
            items: skill.map((c: any) => ({...c, hasArgs: false, source: 'skill'}))
        },
        agent.length && {
            label: '代理',
            source: 'agent',
            items: agent.map((c: any) => ({...c, hasArgs: false, source: 'agent'}))
        },
        user.length && {
            label: '自定义命令',
            source: 'user',
            items: user.map((c: any) => ({...c, hasArgs: (c.args?.length ?? 0) > 0, source: 'user'}))
        },
    ].filter(Boolean) as { label: string; source: string; items: CommandItem[] }[]
}

export function InlineCommandPicker({query, onClose, onComplete}: Props) {
    const [groups, setGroups] = useState<{ label: string; source: string; items: CommandItem[] }[]>([])
    const [loading, setLoading] = useState(true)
    const [sel, setSel] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        let cancelled = false
        loadGroups().then(r => !cancelled && setGroups(r)).finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
        }
    }, [])

    // 过滤 + 扁平
    const flat = useMemo(() => {
        if (!query.trim()) return groups.flatMap(g => g.items)
        const q = query.toLowerCase()
        return groups.flatMap(g => g.items).filter(i =>
            i.name.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q))
    }, [groups, query])

    useEffect(() => {
        setSel(0)
    }, [query])
    useEffect(() => {
        listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({block: 'nearest'})
    }, [sel])

    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        const keyMap: Record<string, () => void> = {
            ArrowDown: () => setSel(i => Math.min(i + 1, flat.length - 1)),
            ArrowUp: () => setSel(i => Math.max(i - 1, 0)),
            Tab: () => flat[sel] && onComplete(`/${flat[sel].name} `),
            Enter: () => flat[sel] && onComplete(`/${flat[sel].name} `),
            Escape: () => { e.nativeEvent.stopPropagation(); onClose() },
        }
        if (keyMap[e.key]) {
            e.preventDefault();
            keyMap[e.key]()
        }
    }, [flat, sel, onComplete, onClose])

    return (
        <motion.div
            initial={{opacity: 0, y: -6}} animate={{opacity: 1, y: 0}} exit={{opacity: 0, y: -6}}
            transition={{duration: 0.12}}
            className="absolute left-0 top-full mt-1.5 w-[380px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl z-50 overflow-hidden"
            onKeyDown={onKeyDown}
        >
            {/* 头部 */}
            <div
                className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                <span className="text-[var(--text-muted)] font-mono text-sm font-bold">/</span>
                <span className="text-[var(--text-primary)] text-sm flex-1 truncate">{query}</span>
                <kbd
                    className="px-1.5 py-0.5 text-[10px] bg-[var(--surface)] border border-[var(--border)] rounded text-[var(--text-muted)] font-mono">Tab
                    补全</kbd>
            </div>

            {/* 列表 */}
            <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
                {loading ? (
                    <div className="p-6 text-center">
                        <span
                            className="inline-block w-4 h-4 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    </div>
                ) : flat.length === 0 ? (
                    <div className="p-6 text-center text-sm text-[var(--text-muted)]">
                        {query ? `未找到匹配 "${query}" 的命令` : '暂无可用命令'}
                    </div>
                ) : groups.map(g => {
                    const cfg = SRC[g.source as keyof typeof SRC] ?? SRC.plugin
                    const items = flat.filter(i => i.source === g.source)
                    if (!items.length) return null
                    return (
                        <div key={g.source}>
                            <div
                                className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider ${cfg.t} opacity-60`}>{g.label}</div>
                            {items.map((item, idx) => {
                                const realIdx = flat.indexOf(item)
                                return (
                                    <div key={item.id} data-idx={realIdx} onClick={() => onComplete(`/${item.name} `)}
                                         className={`mx-1 px-2 py-2 rounded-lg cursor-pointer flex items-center gap-2.5 transition-colors
                      ${realIdx === sel ? 'bg-[var(--brand-primary)]/15 border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-[var(--surface-muted)]'}`}>
                                        <span
                                            className={`w-7 h-7 rounded-md flex items-center justify-center text-sm ${cfg.c}`}>{cfg.i}</span>
                                        <div className="flex-1 min-w-0">
                                            <div
                                                className={`text-sm font-medium truncate ${realIdx === sel ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'}`}>{item.name}</div>
                                            {item.description && <div
                                                className="text-[11px] text-[var(--text-muted)] truncate">{item.description}</div>}
                                        </div>
                                        <span
                                            className={`text-[10px] px-1.5 py-0.5 rounded ${cfg.c} ${cfg.t}`}>{cfg.l}</span>
                                    </div>
                                )
                            })}
                        </div>
                    )
                })}
            </div>

            {/* 底部快捷键 */}
            <div className="px-3 py-2 border-t border-[var(--border)] flex gap-4 text-[10px] text-[var(--text-muted)]">
                {[['↑↓', '导航'], ['Tab', '补全'], ['Esc', '关闭']].map(([k, l]) => (
                    <span key={k}><kbd
                        className="px-1 py-0.5 bg-[var(--surface-muted)] border border-[var(--border)] rounded font-mono">{k}</kbd> {l}</span>
                ))}
            </div>
        </motion.div>
    )
}

export default InlineCommandPicker
