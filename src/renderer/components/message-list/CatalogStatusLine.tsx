/**
 * CatalogStatusLine — 能力目录状态行
 *
 * 纯 props 组件：数据完全由 MessageList 从 messages 派生后传入，
 * 组件内部仅持有"展开/收起"一个 useState，不创建任何
 * listener / observer / subscription / IPC 订阅（内存安全红线）。
 */
import {useState} from 'react'
import type {CatalogEntry} from '@shared/types/message'

interface CatalogStatusLineProps {
    entries: CatalogEntry[]
}

/**
 * 从 catalog 消息 content 的 <available_skills> 块解析条目（fallback 用）：
 * metadata.catalogEntries 为空时（新目录消息不再携带完整 entries），
 * 从消息正文恢复条目列表供状态行计数/展开展示。
 * 兼容 full 模式行 `- [type] \`name\`: desc | trigger` 与 names 模式逗号索引。
 */
export function parseCatalogEntriesFromContent(content: string): CatalogEntry[] {
    const block = content.split('<available_skills>')[1]?.split('</available_skills>')[0]
    if (!block) return []
    const entries: CatalogEntry[] = []
    for (const raw of block.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        const fullMatch = line.match(/^- \[(\w+)\] `([^`]+)`/)
        if (fullMatch) {
            const desc = line.slice(fullMatch[0].length).replace(/^[:\s]+/, '')
            entries.push({name: fullMatch[2], type: 'skill', description: desc})
            continue
        }
        for (const name of line.split(',')) {
            const n = name.trim()
            if (n) entries.push({name: n, type: 'skill', description: ''})
        }
    }
    return entries
}

export function CatalogStatusLine({entries}: CatalogStatusLineProps) {
    const [expanded, setExpanded] = useState(false)

    return (
        <div className="px-2 py-1">
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors cursor-pointer"
            >
                已加载能力目录（{entries.length} 项）
            </button>
            {expanded && (
                <ul className="mt-1 space-y-0.5 text-xs text-[var(--text-secondary)]">
                    {entries.map(e => (
                        <li key={`${e.type}:${e.name}`} className="truncate">
                            <span className="text-[var(--text-primary)]">{e.name}</span>
                            <span className="mx-1 text-[var(--text-muted)]">·</span>
                            {e.description}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
