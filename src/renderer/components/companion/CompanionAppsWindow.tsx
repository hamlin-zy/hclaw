// 跟随启动配置窗口（companion-apps，Task 9）
// 列表行 + inline 编辑 + 应用选择器模态层；无自动化测试（与 MemoryManagerDialog 同口径），真机验证在 T11。
import {useState, useEffect, useCallback, useMemo, useRef} from 'react'
import {parseArgs} from '../../../shared/types/companion'
import {INPUT_FOCUS} from '../../lib/inputFocus'
import {Switch} from '../common/Switch'
import type {CompanionApp, EnumeratedApp} from '../../../shared/types/companion'

/** 32×32 图标占位框（语义变量，spec §4 图标占位） */
function AppIcon({dataUrl}: {dataUrl?: string}) {
    return (
        <div className="w-8 h-8 shrink-0 rounded bg-[var(--surface)] flex items-center justify-center overflow-hidden">
            {dataUrl
                ? <img src={dataUrl} alt="" className="w-8 h-8"/>
                : <div className="w-4 h-4 rounded-sm bg-[var(--border)]"/>}
        </div>
    )
}

function timingLabel(app: CompanionApp): string {
    let label = app.launchTiming === 'before' ? '启动前' : '启动后'
    if (app.launchTiming === 'before' && app.waitForReady) label += ' · 等待就绪'
    if (!app.enabled) label += ' · 已禁用'
    return label
}

/** EnumeratedApp → 新 CompanionApp（默认 after/不等待/启用，spec §4；渲染端不计算 id，主进程回传） */
function toNewApp(e: EnumeratedApp): CompanionApp {
    const exeName = e.exePath.split(/[\\/]/).pop() ?? ''
    return {
        id: '', name: e.name || exeName, exePath: e.exePath,
        args: parseArgs(e.args), processName: exeName,
        launchTiming: 'after', waitForReady: false, waitTimeoutMs: 10000, enabled: true,
    }
}

/** 图标懒加载（fetchedRef 防重复请求；cancelled 防卸载后 setState） */
function useLazyIcons(paths: string[]) {
    const [icons, setIcons] = useState<Record<string, string>>({})
    const fetchedRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        let cancelled = false
        for (const p of paths) {
            if (fetchedRef.current.has(p)) continue
            void window.electronAPI?.companion?.getIcon(p).then(result => {
                // cancelled / 失败时回滚登记，避免 paths 引用变化取消在飞请求后该图标永久丢失
                if (cancelled || !result) { if (!cancelled) fetchedRef.current.delete(p); return }
                fetchedRef.current.add(p)
                setIcons(prev => ({...prev, [p]: result.iconDataUrl}))
            })
        }
        return () => { cancelled = true }
    }, [paths])

    return icons
}

/** 应用选择器模态层（spec §4 添加流程） */
function AppPicker({onPick, onClose}: {onPick: (e: EnumeratedApp) => void; onClose: () => void}) {
    const [items, setItems] = useState<EnumeratedApp[]>([])
    const [loading, setLoading] = useState(true)
    const [failed, setFailed] = useState(false)
    const [query, setQuery] = useState('')

    useEffect(() => {
        let cancelled = false
        void window.electronAPI?.companion?.enumerate()
            .then(list => {
                if (cancelled) return
                setItems(list)
                setLoading(false)
                setFailed(false)
            })
            .catch(() => {
                if (!cancelled) { setItems([]); setLoading(false); setFailed(true) }
            })
        return () => { cancelled = true }
    }, [])

    // 图标懒加载（上限 80 条，防长列表一次请求过多）；useMemo 稳定依赖，防每次渲染重跑 effect 取消在飞请求
    const iconPaths = useMemo(() => items.slice(0, 80).map(i => i.exePath), [items])
    const icons = useLazyIcons(iconPaths)

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return items
        return items.filter(i => i.name.toLowerCase().includes(q) || i.exePath.toLowerCase().includes(q))
    }, [items, query])

    async function browse() {
        const picked = await window.electronAPI?.companion?.browse()
        if (!picked) return // 用户取消：静默关闭语义（裁决 1）
        onPick(picked)
    }

    return (
        <div className="absolute inset-0 z-20 bg-[var(--surface)] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <span className="text-sm font-medium text-[var(--text-primary)]">选择应用</span>
                <button aria-label="关闭" onClick={onClose}
                    className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2 py-1 rounded hover:bg-[var(--surface-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)]">✕</button>
            </div>
            <div className="px-4 py-2">
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="搜索应用名称..."
                    className={`${INPUT_FOCUS} w-full px-3 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]`}
                />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
                {loading && <div className="text-sm text-[var(--text-secondary)] py-8 text-center">加载中...</div>}
                {!loading && failed && (
                    <div className="text-sm text-[var(--text-secondary)] py-8 text-center">枚举失败，请使用浏览选择</div>
                )}
                {!loading && !failed && items.length === 0 && (
                    <div className="text-sm text-[var(--text-secondary)] py-8 text-center">未在开始菜单找到应用，可使用浏览选择</div>
                )}
                {filtered.map(item => (
                    <button
                        key={item.exePath + item.shortcutPath}
                        onClick={() => onPick(item)}
                        className="w-full flex items-center gap-3 px-2 py-2 rounded hover:bg-[var(--surface-muted)] text-left"
                    >
                        <AppIcon dataUrl={icons[item.exePath]}/>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm text-[var(--text-primary)] truncate">{item.name}</div>
                            <div className="text-xs text-[var(--text-secondary)] truncate">{item.exePath}</div>
                        </div>
                    </button>
                ))}
            </div>
            <div className="px-4 py-3 border-t border-[var(--border)]">
                <button
                    onClick={() => void browse()}
                    className="w-full px-3 py-1.5 text-sm rounded border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)]"
                >或 浏览选择...</button>
            </div>
        </div>
    )
}

export default function CompanionAppsWindow() {
    const [apps, setApps] = useState<CompanionApp[]>([])
    const [loading, setLoading] = useState(true)
    const [pickerOpen, setPickerOpen] = useState(false)
    const [expandedId, setExpandedId] = useState<string | null>(null)

    const reload = useCallback(async () => {
        const list = await window.electronAPI?.companion?.list() ?? []
        setApps(list)
        setLoading(false)
    }, [])

    useEffect(() => { void reload() }, [reload])

    // 列表图标懒加载；useMemo 稳定依赖（同上）
    const iconPaths = useMemo(() => apps.map(app => app.exePath), [apps])
    const icons = useLazyIcons(iconPaths)

    async function addFromPicker(e: EnumeratedApp) {
        setPickerOpen(false)
        await window.electronAPI?.companion?.save(toNewApp(e))
        await reload()
    }

    async function removeApp(id: string) {
        await window.electronAPI?.companion?.remove(id)
        if (expandedId === id) setExpandedId(null)
        await reload()
    }

    async function saveRow(app: CompanionApp) {
        await window.electronAPI?.companion?.save(app)
        await reload()
    }

    return (
        <div className="relative h-full flex flex-col">
            {/* 工具栏 */}
            <div className="px-4 py-3 border-b border-[var(--border)] shrink-0">
                <button
                    onClick={() => setPickerOpen(true)}
                    className="px-3 py-1.5 text-sm rounded bg-[var(--brand-primary)] text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_50%,transparent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)]"
                >+ 添加跟随启动项</button>
            </div>

            {/* 列表 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
                {loading && <div className="text-sm text-[var(--text-secondary)] py-8 text-center">加载中...</div>}
                {!loading && apps.length === 0 && (
                    <div className="text-sm text-[var(--text-secondary)] py-8 text-center">暂无跟随启动项，点击上方按钮添加</div>
                )}
                {apps.map(app => (
                    <div key={app.id}
                        className={`border border-[var(--border)] rounded mb-2 ${app.enabled ? '' : 'opacity-50'}`}>
                        {/* 行（列表行溢出口径：弹性项唯一 + 其余 shrink-0） */}
                        <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={expandedId === app.id}
                            className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-[var(--surface-muted)] rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]"
                            onClick={() => setExpandedId(expandedId === app.id ? null : app.id)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    setExpandedId(expandedId === app.id ? null : app.id)
                                }
                            }}
                        >
                            <AppIcon dataUrl={icons[app.exePath]}/>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm text-[var(--text-primary)] truncate">{app.name}</div>
                                <div className="text-xs text-[var(--text-secondary)] truncate">{app.processName}</div>
                            </div>
                            <span className="shrink-0 text-xs px-2 py-0.5 rounded bg-[var(--brand-muted)] text-[var(--text-brand)]">
                                {timingLabel(app)}
                            </span>
                            <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                                <Switch checked={app.enabled} ariaLabel={`启用 ${app.name}`}
                                    onChange={v => void saveRow({...app, enabled: v})}/>
                            </div>
                            <button
                                aria-label={`移除 ${app.name}`}
                                onClick={e => { e.stopPropagation(); void removeApp(app.id) }}
                                className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] rounded px-2 py-1"
                            >✕</button>
                        </div>
                        {/* inline 编辑面板（同一时间只展开一项，由 expandedId 保证） */}
                        {expandedId === app.id && (
                            <div className="px-4 py-3 border-t border-[var(--border)] grid grid-cols-2 gap-3 text-sm">
                                <label className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0 text-[var(--text-secondary)]">启动时机</span>
                                    <select
                                        value={app.launchTiming}
                                        onChange={e => void saveRow({...app, launchTiming: e.target.value as CompanionApp['launchTiming']})}
                                        className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]"
                                    >
                                        <option value="before">启动前（阻塞，最多等超时）</option>
                                        <option value="after">启动后（不阻塞）</option>
                                    </select>
                                </label>
                                <label className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0 text-[var(--text-secondary)]">等待就绪</span>
                                    <input type="checkbox" checked={app.waitForReady}
                                        onChange={e => void saveRow({...app, waitForReady: e.target.checked})}/>
                                </label>
                                <label className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0 text-[var(--text-secondary)]">超时(ms)</span>
                                    <input type="number" min={0} value={app.waitTimeoutMs ?? 10000}
                                        onChange={e => void saveRow({...app, waitTimeoutMs: Math.max(0, Number(e.target.value) || 0)})}
                                        className={`${INPUT_FOCUS} flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]`}/>
                                </label>
                                <label className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0 text-[var(--text-secondary)]">进程名</span>
                                    <input defaultValue={app.processName} onBlur={e => {
                                        const v = e.target.value.trim()
                                        if (v && v !== app.processName) void saveRow({...app, processName: v})
                                    }}
                                        className={`${INPUT_FOCUS} flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]`}/>
                                </label>
                                <label className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0 text-[var(--text-secondary)]">参数</span>
                                    <input defaultValue={app.args.join(' ')} onBlur={e => {
                                        const next = parseArgs(e.target.value)
                                        if (JSON.stringify(next) !== JSON.stringify(app.args)) void saveRow({...app, args: next})
                                    }}
                                        className={`${INPUT_FOCUS} flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]`}/>
                                </label>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {pickerOpen && (
                <AppPicker onPick={e => void addFromPicker(e)} onClose={() => setPickerOpen(false)}/>
            )}
        </div>
    )
}
