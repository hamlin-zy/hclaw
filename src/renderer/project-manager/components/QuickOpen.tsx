import {Fragment, useEffect, useRef} from 'react'
import {Loader2} from 'lucide-react'
import type {QuickOpenMode} from '../lib/quickOpenKeymap'
import {FIND_TRUNCATED_TEXT, foldRowText} from '../lib/findInFiles'
import type {ScrollMetrics} from '../lib/findInFiles'
import {
    FILE_SEARCH_LIMIT,
    formatOpenedAt,
    splitHighlight,
    splitRelPath,
    type HighlightSlice,
    type QuickOpenItem,
} from '../lib/quickOpenResults'
import type {QuickOpenKeyEvent} from '../hooks/useQuickOpen'
import {QuickOpenPreview} from './QuickOpenPreview'

/** 模式专属 placeholder（术语以 CONTEXT.md 为准；浮层只允许三行，故模式名挂在搜索框上） */
const MODE_PLACEHOLDER: Record<QuickOpenMode, string> = {
    'file-search': 'File Search — 输入文件路径名中的片段',
    'recent-files': 'Recent Files — 按打开时间倒序',
    'find-in-files': 'Find in Files — 输入要检索的内容',
}

/**
 * 空态 / 无结果 / 截断的文案（纯函数，便于断言）。
 * 加载中不在此列：那是列表顶部的一行状态指示（含动画），不是空态。
 */
export function quickOpenEmptyText(
    mode: QuickOpenMode,
    query: string,
    resultCount: number,
    error: string | null,
): string | null {
    if (error) return error
    if (mode === 'find-in-files') {
        if (query.trim() === '') return '输入要检索的内容'
        return resultCount === 0 ? '无匹配内容' : null
    }
    if (mode === 'recent-files') return resultCount === 0 ? '还没有打开过文件' : null
    if (query.trim() === '') return '输入文件名片段开始搜索'
    return resultCount === 0 ? '无匹配文件' : null
}

/** 命中区间的高亮渲染：区间来自主进程，这里只做机械切片（renderer 不重算匹配） */
function Highlighted({slice}: {slice: HighlightSlice}) {
    return (
        <>
            {slice.before}
            {slice.hit !== '' && <mark className="pm-quickopen-mark">{slice.hit}</mark>}
            {slice.after}
        </>
    )
}

export interface QuickOpenProps {
    mode: QuickOpenMode
    query: string
    onQueryChange: (value: string) => void
    /** 当前列表（三种模式共用一种条目形状；Find in Files 下折叠掉的不在其中） */
    results: QuickOpenItem[]
    /** 键盘选中项下标 */
    activeIndex: number
    /** 搜索中：列表顶部显示带动画的状态行 */
    loading: boolean
    /** 结果被单次上限截断（File Search 条数上限 / Find in Files 缓冲上限） */
    truncated: boolean
    /** 检索失败的单行原因 */
    error: string | null
    /** 打开失败的条目（就地标灰） */
    stalePaths: ReadonlySet<string>
    /** 点击列表项 = 回车：打开第 index 项 */
    onActivate: (index: number) => void
    /** Recent Files 的「清空记录」入口 */
    onClearRecent?: () => void
    /**
     * 浮层内键位语义（Esc / 上下键 / 回车），与 hook 共用同一实现。
     * 主路径是 hook 挂在 document capture 阶段的监听器（它命中即 stopPropagation，
     * 因此这里不会再被二次触发）；本 prop 是给「不带 hook 单独渲染浮层」的场景兜底。
     */
    onKeyDown?: (e: QuickOpenKeyEvent) => void
    /** 中文输入法：composition 期间不触发搜索 */
    onCompositionStart?: () => void
    onCompositionEnd?: () => void
    /** 工作区根：预览取数与缓存键的归属维度（工单 04） */
    workspacePath?: string | null
    /** Find in Files：每个文件被折叠掉的命中数（path → M），在文件末行后插折叠行 */
    findFolds?: ReadonlyMap<string, number>
    /** Find in Files：下一页在途（列表底部状态行） */
    loadingMore?: boolean
    /** Find in Files：列表滚动 → 触底加载下一页（互斥判定在 hook 内） */
    onListScroll?: (metrics: ScrollMetrics) => void
}

/**
 * QuickOpen 浮层（ADR-0002）：固定三行 —— 搜索框 / 匹配列表 / 选中项预览。
 *
 * 本组件是**纯展示 + 回调**，不持有数据：状态机在 `useQuickOpen`（浮层永远只有一个实例）。
 * 预览取数与缓存接在 `QuickOpenPreview.tsx`（工单 04），Find in Files 的列表复用同一套行
 * （条目形状复用 `line` / `matchText`，工单 05）。
 */
export function QuickOpen({
    mode, query, onQueryChange, results, activeIndex, loading, truncated, error, stalePaths,
    onActivate, onClearRecent, onKeyDown, onCompositionStart, onCompositionEnd,
    workspacePath = null, findFolds, loadingMore = false, onListScroll,
}: QuickOpenProps) {
    const activeRowRef = useRef<HTMLDivElement | null>(null)
    const listRef = useRef<HTMLDivElement | null>(null)

    // 键盘选中项滚动跟随（jsdom 没有 scrollIntoView，用可选调用兜住）
    useEffect(() => {
        activeRowRef.current?.scrollIntoView?.({block: 'nearest'})
    }, [activeIndex, results])

    const emptyText = quickOpenEmptyText(mode, query, results.length, error)
    const showEmpty = !loading && emptyText !== null
    // Find in Files：折叠行插在「同一文件的最后一个可见命中行」之后。
    // 结果可能非连续（foldFindItems 保留原顺序），故不能只看下一项的 path，须取该路径的最后下标。
    const lastFoldRowOfPath = new Map<string, number>()
    if (findFolds && findFolds.size > 0) {
        results.forEach((item, i) => {
            if (findFolds.has(item.path)) lastFoldRowOfPath.set(item.path, i)
        })
    }

    return (
        <div className="pm-quickopen-backdrop">
            <div
                className="pm-quickopen"
                role="dialog"
                aria-modal="true"
                aria-label="QuickOpen"
                data-testid="pm-quickopen"
                data-mode={mode}
                onKeyDown={onKeyDown}
            >
                <div className="pm-quickopen-head">
                    <input
                        // 无 INPUT_FOCUS：这是**整行铺满的隐形 inner input**，视觉外壳是 head
                        // 这一行本身（焦点经 .pm-quickopen-head:focus-within 表达）。外扩的
                        // ring 会在行尾留下缝隙、并在右端退化成直角，见 globals.css 同名注释。
                        // 例外登记：tests/renderer/inputFocusSeam.test.ts 的 EXEMPT。
                        className="pm-quickopen-input"
                        // 打开即聚焦搜索框：编辑器失去焦点不改变其选区与滚动位置
                        autoFocus
                        type="text"
                        value={query}
                        onChange={e => onQueryChange(e.target.value)}
                        onCompositionStart={onCompositionStart}
                        onCompositionEnd={onCompositionEnd}
                        placeholder={MODE_PLACEHOLDER[mode]}
                        aria-label="QuickOpen 搜索"
                        data-testid="pm-quickopen-input"
                    />
                    {/* Recent Files 的次要入口：清空当前工作区的记录 */}
                    {mode === 'recent-files' && results.length > 0 && (
                        <button
                            type="button"
                            className="pm-quickopen-clear"
                            aria-label="清空最近打开记录"
                            data-testid="pm-quickopen-clear-recent"
                            onClick={onClearRecent}
                        >
                            清空记录
                        </button>
                    )}
                </div>
                <div
                    className="pm-quickopen-list"
                    role="listbox"
                    aria-label="匹配列表"
                    data-testid="pm-quickopen-list"
                    ref={listRef}
                    onScroll={onListScroll
                        ? e => onListScroll(scrollMetrics(e.currentTarget))
                        : undefined}
                >
                    {loading && (
                        <div className="pm-quickopen-status" role="status" data-testid="pm-quickopen-loading">
                            <Loader2 className="pm-spin" size={12} aria-hidden="true" />
                            <span>搜索中…</span>
                        </div>
                    )}
                    {showEmpty && (
                        <div className="pm-quickopen-empty" data-testid="pm-quickopen-empty">{emptyText}</div>
                    )}
                    {results.map((item, i) => {
                        const {dir, name} = splitRelPath(item.path)
                        const stale = stalePaths.has(item.path)
                        const active = i === activeIndex
                        // Find in Files 的 `matchStart/matchEnd` 是**行内**区间（用于命中文本高亮与预览），
                        // 不参与路径高亮——路径上重算匹配会给出误导性的高亮位置。
                        const isFind = item.line !== undefined
                        const hidden = findFolds?.get(item.path)
                        return (
                            // Fragment：折叠行要与命中行并列成为 listbox 的直接子节点（不插中间容器，
                            // 否则 role=option 不再是 listbox 的直接子元素，辅助技术读不到）
                            <Fragment key={`${item.path}:${item.line ?? ''}:${i}`}>
                                <div
                                    role="option"
                                    aria-selected={active}
                                    data-testid="pm-quickopen-row"
                                    data-path={item.path}
                                    ref={active ? activeRowRef : undefined}
                                    className={`pm-quickopen-row${isFind ? ' pm-quickopen-row--find' : ''}${active ? ' is-active' : ''}${stale ? ' is-stale' : ''}`}
                                    onClick={() => onActivate(i)}
                                >
                                    <span className="pm-quickopen-row-name">
                                        <Highlighted slice={splitHighlight(name, dir.length, isFind ? null : item.matchStart, isFind ? null : item.matchEnd)} />
                                    </span>
                                    {isFind && <span className="pm-quickopen-row-line">:{item.line}</span>}
                                    {isFind && item.matchText !== undefined && (
                                        <span className="pm-quickopen-row-text">
                                            <Highlighted slice={splitHighlight(item.matchText, 0, item.matchStart, item.matchEnd)} />
                                        </span>
                                    )}
                                    {dir !== '' && (
                                        <span className="pm-quickopen-row-dir">
                                            <Highlighted slice={splitHighlight(dir, 0, isFind ? null : item.matchStart, isFind ? null : item.matchEnd)} />
                                        </span>
                                    )}
                                    {stale && <span className="pm-quickopen-row-flag">已失效</span>}
                                    {item.openedAt !== undefined && (
                                        <span className="pm-quickopen-row-time">{formatOpenedAt(item.openedAt)}</span>
                                    )}
                                </div>
                                {hidden !== undefined && hidden > 0 && lastFoldRowOfPath.get(item.path) === i && (
                                    <div className="pm-quickopen-fold" data-testid="pm-quickopen-fold">
                                        {foldRowText(hidden)}
                                    </div>
                                )}
                            </Fragment>
                        )
                    })}
                    {truncated && !loading && (
                        <div className="pm-quickopen-truncated" data-testid="pm-quickopen-truncated">
                            {mode === 'find-in-files'
                                ? FIND_TRUNCATED_TEXT
                                : `仅显示前 ${FILE_SEARCH_LIMIT} 条匹配，继续输入以缩小范围`}
                        </div>
                    )}
                    {loadingMore && (
                        <div className="pm-quickopen-status" role="status" data-testid="pm-quickopen-loading-more">
                            <Loader2 className="pm-spin" size={12} aria-hidden="true" />
                            <span>加载中…</span>
                        </div>
                    )}
                </div>
                <div className="pm-quickopen-preview" aria-label="选中项预览" data-testid="pm-quickopen-preview">
                    <QuickOpenPreview
                        mode={mode}
                        item={results[activeIndex] ?? null}
                        workspacePath={workspacePath}
                    />
                </div>
            </div>
        </div>
    )
}

/** 滚动容器度量（预览/触底判定只吃这三个数，故只取它们） */
function scrollMetrics(el: HTMLElement): ScrollMetrics {
    return {scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight}
}
