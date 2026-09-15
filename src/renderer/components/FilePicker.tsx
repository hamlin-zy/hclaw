/**
 * FilePicker — 递进式 # 文件选择下拉
 * 交互：文字过滤 · Tab 选中/进入目录 · ← 返回 · Enter 确认 · Esc 关闭
 */

import {Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentType} from 'react'
import {motion} from 'framer-motion'
import {dropdown} from '../lib/motionPresets'
import {useConversationStore} from '../stores/conversationStore'
import {fuzzyMatch} from '../lib/search'
import {
    ImageFileIcon, CodeFileIcon, PaletteFileIcon, WebFileIcon, DataFileIcon, TextFileIcon,
    DocFileIcon, VideoFileIcon, AudioFileIcon, ArchiveFileIcon, ScriptFileIcon, ToolIcon,
    FolderIcon, AttachmentIcon, RemoveIcon,
} from './icons'
import type {IconProps} from './icons'

interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean
}

interface Props {
    query: string;
    currentNav: string
    onClose: () => void
    onNavigate: (subdir: string) => void
    onGoBack: () => void
    onConfirm: (badgeText: string) => void
}

const FILE_ICONS: Record<string, ComponentType<IconProps>> = {
    png: ImageFileIcon, jpg: ImageFileIcon, jpeg: ImageFileIcon, gif: ImageFileIcon, webp: ImageFileIcon, svg: ImageFileIcon,
    ts: CodeFileIcon, tsx: CodeFileIcon, js: CodeFileIcon, jsx: CodeFileIcon, py: CodeFileIcon, rs: CodeFileIcon, go: CodeFileIcon,
    css: PaletteFileIcon, html: WebFileIcon, json: DataFileIcon, yaml: DataFileIcon, md: TextFileIcon, txt: TextFileIcon,
    pdf: DocFileIcon, csv: DataFileIcon, xlsx: DataFileIcon,
    mp4: VideoFileIcon, mp3: AudioFileIcon, wav: AudioFileIcon,
    zip: ArchiveFileIcon, sh: ScriptFileIcon, exe: ToolIcon,
}

const fileIcon = (name: string): ComponentType<IconProps> =>
    FILE_ICONS[name.split('.').pop()?.toLowerCase() ?? ''] ?? TextFileIcon

export function FilePicker({query, currentNav, onClose, onNavigate, onGoBack, onConfirm}: Props) {
    const ws = useConversationStore(s => s.currentWorkspacePath)
    const [entries, setEntries] = useState<FileEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [sel, setSel] = useState(0)
    const [badges, setBadges] = useState<string[]>([])
    const listRef = useRef<HTMLDivElement>(null)
    // ★ 请求序号守卫：快速切换目录时旧响应可能晚于新响应返回，
    //   用递增序号标记「当前有效请求」，过期响应一律丢弃（不 setEntries/setLoading）
    const reqIdRef = useRef(0)

    const fullPath = currentNav ? `${ws}/${currentNav}` : ws ?? ''

    const loadDir = useCallback(async (dir: string) => {
        const id = ++reqIdRef.current
        if (!dir) {
            setEntries([]);
            setLoading(false);
            return
        }
        setLoading(true)
        try {
            const r = await window.electronAPI?.workspaceReadDir?.(dir)
            if (id !== reqIdRef.current) return // 代际守卫：已被更新的目录请求取代
            const list: FileEntry[] = Array.isArray(r) ? r : []
            list.sort((a, b) => a.isDirectory === b.isDirectory
                ? a.name.localeCompare(b.name)
                : a.isDirectory ? -1 : 1)
            setEntries(list)
        } catch {
            if (id !== reqIdRef.current) return
            setEntries([])
        } finally {
            if (id === reqIdRef.current) setLoading(false)
        }
    }, [])

    useEffect(() => {
        loadDir(fullPath)
    }, [fullPath, loadDir])

    const filtered = useMemo(() =>
            !query.trim() ? entries : entries.filter(e => fuzzyMatch(query, e.name)),
        [entries, query])

    useEffect(() => {
        setSel(0)
    }, [query])
    useEffect(() => {
        listRef.current?.querySelector(`[data-fi="${sel}"]`)?.scrollIntoView({block: 'nearest'})
    }, [sel])

    const toggleBadge = useCallback((name: string) =>
        setBadges(p => p.includes(name) ? p.filter(n => n !== name) : [...p, name]), [])

    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        const item = filtered[sel]
        // Tab / Enter 同一语义：目录进入、文件切换选中
        const activate = () => {
            if (!item) return
            if (item.isDirectory) {
                onNavigate(item.name)
                setBadges([])
            } else {
                toggleBadge(item.name)
            }
        }
        const keyMap: Record<string, () => void> = {
            ArrowDown: () => setSel(i => Math.min(i + 1, filtered.length - 1)),
            ArrowUp: () => setSel(i => Math.max(i - 1, 0)),
            Tab: activate,
            Enter: activate,
            ArrowLeft: () => currentNav && onGoBack(),
            Escape: () => onClose(),
        }
        if (keyMap[e.key]) {
            e.preventDefault();
            keyMap[e.key]()
        }
    }, [filtered, sel, currentNav, onNavigate, onGoBack, onClose, toggleBadge])

    // 无工作目录时显示提示
    if (!ws) return (
        <motion.div {...dropdown}
                    className="absolute left-0 top-full mt-1.5 w-[420px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl z-50 p-6 text-center">
            <p className="text-sm text-[var(--text-secondary)]">请先选择一个工作目录</p>
            <p className="text-xs text-[var(--text-secondary)] mt-1">左侧边栏可选择或新建</p>
        </motion.div>
    )

    const segments = currentNav.split('/').filter(Boolean)

    return (
        <motion.div {...dropdown}
                    transition={{duration: 0.12}}
                    className="absolute left-0 top-full mt-1.5 w-[420px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl z-50 overflow-hidden"
                    onKeyDown={onKeyDown}
        >
            {/* 头部 */}
            <div
                className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-muted)] bg-[var(--surface-muted)]">
                <span className="text-[var(--text-secondary)] font-mono text-sm font-bold">#</span>
                <span className="text-[var(--text-primary)] text-sm flex-1 truncate">
          {currentNav && <span className="text-[var(--text-muted)]">#{currentNav}/</span>}{query}
        </span>
                <span className="text-[10px] text-[var(--text-secondary)] truncate max-w-[120px]"
                      title={fullPath}>{fullPath}</span>
            </div>

            {/* 面包屑 */}
            {segments.length > 0 && (
                <div
                    className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border-muted)] text-[11px] text-[var(--text-secondary)]">
                    <button onClick={() => {
                        onNavigate('..');
                        setBadges([])
                    }} className="hover:text-[var(--brand-primary)] shrink-0" data-name="file-picker-button">← 根目录
                    </button>
                    {segments.map((s, i) => (
                        <Fragment key={s}>
                            <span className="text-[var(--border)]">/</span>
                            <button onClick={() => onNavigate(segments.slice(0, i + 1).join('/'))}
                                    className={`hover:text-[var(--brand-primary)] shrink-0 ${i === segments.length - 1 ? 'text-[var(--text-secondary)]' : ''}`} data-name={`file-picker-breadcrumb-${i}`}>{s}</button>
                        </Fragment>
                    ))}
                </div>
            )}

            {/* 已选徽章 */}
            {badges.length > 0 && (
                <div
                    className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-[var(--border-muted)] bg-[color-mix(in_srgb,var(--surface-muted)_50%,transparent)]">
                    {badges.map((n, i) => (
                        <span key={n}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] text-[var(--brand-primary)]">
              <AttachmentIcon className="w-3 h-3"/><span>{n}</span>
              <button onClick={() => setBadges(p => p.filter(x => x !== n))}
                      className="w-3.5 h-3.5 rounded-full bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] hover:bg-red-500/30 flex items-center justify-center text-[9px] transition-colors" data-name={`file-picker-badge-remove-${i}`}><RemoveIcon className="w-2.5 h-2.5"/></button>
            </span>
                    ))}
                    <button onClick={() => onConfirm(badges.map(n => `[${n}]`).join(' ') + ' ')}
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--brand-primary)] text-white hover:bg-[color-mix(in_srgb,var(--brand-primary)_85%,black)] transition-colors" data-name="file-picker-insert-badges-button">
                        确认 ({badges.length})
                    </button>
                </div>
            )}

            {/* 文件列表 */}
            <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
                {loading ? (
                    <div className="p-6 text-center">
                        <span
                            className="inline-block w-4 h-4 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="p-6 text-center text-sm text-[var(--text-secondary)]">
                        {query ? `未找到匹配 "${query}" 的文件` : '目录为空'}
                    </div>
                ) : filtered.map((e, i) => {
                    const FileGlyph = e.isDirectory ? FolderIcon : fileIcon(e.name)
                    return (
                    <div key={e.path} data-fi={i}
                         onClick={() => e.isDirectory ? (onNavigate(e.name), setBadges([])) : toggleBadge(e.name)}
                         className={`mx-1 px-2.5 py-2 rounded-lg cursor-pointer flex items-center gap-2.5 transition-colors
              ${i === sel ? 'bg-[color-mix(in_srgb,var(--brand-primary)_15%,transparent)] border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-[var(--surface-muted)]'}`}
                     data-name="file-picker-div">
                        <span className="text-base shrink-0"><FileGlyph className="w-4 h-4"/></span>
                        <span
                            className={`flex-1 text-sm font-medium truncate ${i === sel ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'}`}>{e.name}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
              {e.isDirectory &&
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#a855f7]/10 text-[#a855f7]">目录</span>}
                            {badges.includes(e.name) && <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)]">已选</span>}
                            {i === sel && <span
                                className="text-[10px] text-[var(--text-secondary)]">{e.isDirectory ? 'Tab 进入' : 'Tab 选中'}</span>}
            </span>
                    </div>
                    )
                })}
            </div>

            {/* 底部 */}
            <div
                className="px-3 py-2 border-t border-[var(--border-muted)] flex items-center gap-3 text-[10px] text-[var(--text-secondary)] flex-wrap">
                {[['↑↓', '导航'], ['Tab', '选中/进入'], ['←', '返回'], ['Esc', '关闭']].map(([k, l]) => (
                    <span key={k}><kbd
                        className="px-1 py-0.5 bg-[var(--surface-muted)] border border-[var(--border)] rounded font-mono">{k}</kbd> {l}</span>
                ))}
            </div>
        </motion.div>
    )
}

export default FilePicker
