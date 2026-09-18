import {useCallback, useEffect, useRef, useState} from 'react'
import type {FindInFilesMatch, FindInFilesPage} from '@shared/types/project-manager'
import {quickOpenBindings, resolveQuickOpenCommand, type QuickOpenMode} from '../lib/quickOpenKeymap'
import {IS_MAC} from '../../lib/platform'
import {readRecentFiles, recordRecentFile, removeRecentFile, clearRecentFiles} from '../lib/recentFiles'
import {
    FILE_SEARCH_DEBOUNCE_MS,
    FILE_SEARCH_LIMIT,
    clampActiveIndex,
    hitToItem,
    moveActiveIndex,
    recentToItems,
    type QuickOpenItem,
} from '../lib/quickOpenResults'
import {
    FIND_FIRST_PAGE_RETRY_MS,
    FIND_PAGE_SIZE,
    FIND_PER_FILE_LIMIT,
    foldFindItems,
    isNearBottom,
    resolveScrollLoad,
    type ScrollMetrics,
} from '../lib/findInFiles'
import {clearPreviewCache, findCachedFullContent} from '../lib/quickOpenPreview'
import {fileSliceToContentResult, toOpenFileTabInput} from '../utils/fileOpenGate'
import {requestLocate} from '../stores/locateRequestStore'
import {useEditorTabStore} from '../stores/editorTabStore'
import {basename} from '../lib/wsPath'

/**
 * 键位处理只依赖这几个成员：DOM `KeyboardEvent` 与 React 合成事件都满足
 * （React 的 KeyboardEvent 类型缺 `isComposing`，故这里声明为可选）。
 */
export interface QuickOpenKeyEvent {
    key: string
    /** composition 期间为 true；React 合成事件不带该字段 */
    isComposing?: boolean
    preventDefault(): void
    stopPropagation(): void
}

/**
 * QuickOpen 浮层的**状态与行为控制器**（在 ProjectManagerApp 挂**唯一**实例）。
 *
 * 键位接线：监听器挂在 document 的 **capture 阶段**——capture 先于 CodeMirror（含 vim 模式）
 * 在自身 DOM 上的监听器执行，命中即 `preventDefault` + `stopPropagation`，把事件从编辑器手里抢过来，
 * 因此不会出现「焦点在编辑器里快捷键就不灵」（ADR-0001 的有意取舍）。
 * 浮层未打开时 Esc / 上下键一律放行，编辑器行为不变。
 *
 * 数据来源：Recent Files 直接读 localStorage 的 MRU（无防抖、无 fs 调用）；File Search 走
 * `pm.searchFiles`；Find in Files 走主进程的长驻检索会话（`findInFilesStart/Page/Stop`），
 * 每页 20 个命中项、触底翻页（armed / re-arm 互斥）。匹配与排序一律在主进程做。
 * 陈旧响应用单调递增的请求序号（token）比对后丢弃；关闭浮层 / 切换工作区同样使序号前进，
 * 因此迟到的落地结果既不会写进列表，也不会跨工作区串味。
 */
export interface UseQuickOpenResult {
    /** 当前模式；null = 浮层关闭 */
    mode: QuickOpenMode | null
    query: string
    setQuery(value: string): void
    /** 当前列表（三种模式共用一个数组；Find in Files 下折叠掉的不在其中，仍可键盘导航） */
    results: QuickOpenItem[]
    /** 键盘选中项下标（恒在 [0, results.length-1]，空列表为 0） */
    activeIndex: number
    /** 搜索中（驱动「搜索中」动画；防抖等待期也算，避免输入后一片死寂） */
    loading: boolean
    /** 结果被单次上限截断（File Search 的条数上限 / Find in Files 的缓冲上限） */
    truncated: boolean
    /** 检索失败的单行原因（无错时为 null） */
    error: string | null
    /** 打开失败（已删除 / 改名 / 无权限）的条目：就地标灰，下次开浮层不再出现 */
    stalePaths: ReadonlySet<string>
    /** Find in Files：每个文件被折叠掉的命中数（path → M），列表在文件末行后插「还有 M 处」 */
    findFolds: ReadonlyMap<string, number>
    /** Find in Files：还有下一页可加载 */
    hasMore: boolean
    /** Find in Files：下一页在途（列表底部的加载状态行） */
    loadingMore: boolean
    /** 列表滚动：驱动触底加载（armed / re-arm 互斥在 hook 内，见 lib/findInFiles.ts） */
    onListScroll(metrics: ScrollMetrics): void
    /** 浮层内的键位语义（Esc 关 / 上下键移动 / 回车打开）。见文件头的 capture 说明 */
    onKeyDown(e: QuickOpenKeyEvent): void
    /** 中文输入法：composition 期间不触发搜索，结束后立即搜一次（不经防抖） */
    onCompositionStart(): void
    onCompositionEnd(): void
    /** 打开第 index 项（点击列表项与回车等价） */
    activateIndex(index: number): void
    /** Recent Files 的「清空记录」次要入口 */
    clearRecent(): void
    close(): void
}

/** 打开浮层时先清空的瞬时状态（避免上一次的残留闪一帧） */
const IDLE = {
    results: [] as QuickOpenItem[],
    truncated: false,
    error: null as string | null,
}

const NO_FOLDS: ReadonlyMap<string, number> = new Map()

export function useQuickOpen(workspacePath: string | null = null): UseQuickOpenResult {
    const [mode, setMode] = useState<QuickOpenMode | null>(null)
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<QuickOpenItem[]>(IDLE.results)
    const [activeIndex, setActiveIndex] = useState(0)
    const [loading, setLoading] = useState(false)
    const [truncated, setTruncated] = useState(IDLE.truncated)
    const [error, setError] = useState<string | null>(IDLE.error)
    const [stalePaths, setStalePaths] = useState<ReadonlySet<string>>(() => new Set())
    // Find in Files（工单 05）：折叠表 + 会话是否已结束 + 下一页在途
    const [findFolds, setFindFolds] = useState<ReadonlyMap<string, number>>(NO_FOLDS)
    const [findDone, setFindDone] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    // 记录被清空 / 变化时自增，驱动 Recent Files 的列表 effect 重读
    const [recentVersion, setRecentVersion] = useState(0)
    // composition 结束的「立即搜一次」信号：同样是自增计数，避免额外的布尔状态
    const [compositionTick, setCompositionTick] = useState(0)

    /** 请求序号：任何会使在途结果失效的事件都让它前进 */
    const seqRef = useRef(0)
    /** 浮层是否打开（同步可见，供 promise 回调判断；state 在同一 tick 里读不到新值） */
    const openRef = useRef(false)
    const wsRef = useRef(workspacePath)
    wsRef.current = workspacePath
    const composingRef = useRef(false)
    /** 下一次搜索是否跳过防抖（compositionend 后立即搜） */
    const immediateRef = useRef(false)
    // 键位监听器与列表渲染都读这两个 ref，避免把结果数组塞进 effect 依赖
    const resultsRef = useRef<QuickOpenItem[]>(results)
    resultsRef.current = results
    const activeIndexRef = useRef(activeIndex)
    activeIndexRef.current = activeIndex

    // ── Find in Files 的会话与分页状态（ref：异步回调里要读到最新值，且不进 effect 依赖）──
    /** 当前检索会话 id；null = 无会话 */
    const sessionRef = useRef<string | null>(null)
    /** 已累计的命中项（**原始缓冲**，分页 offset 与折叠都基于它；renderer 侧不再截断） */
    const findRawRef = useRef<FindInFilesMatch[]>([])
    const findDoneRef = useRef(false)
    const findTruncatedRef = useRef(false)
    /** 有一页在途：避免同一时刻并发取同一页 */
    const pageLoadingRef = useRef(false)
    /** 首页轮询计时器（rg 首屏命中未就绪时重试） */
    const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    /** 触底是否「已武装」（见 lib/findInFiles.resolveScrollLoad） */
    const armedRef = useRef(true)

    /**
     * 终止当前检索会话并释放缓冲（spec：新查询立即终止上一次检索；关闭浮层立即终止并释放缓冲）。
     * 主进程收到 stop 会 kill 掉 rg 子进程并删除会话，renderer 侧同时丢掉累计的命中项。
     */
    const stopFindSession = useCallback(() => {
        if (retryRef.current !== null) {
            clearTimeout(retryRef.current)
            retryRef.current = null
        }
        const sessionId = sessionRef.current
        sessionRef.current = null
        findRawRef.current = []
        findDoneRef.current = false
        findTruncatedRef.current = false
        pageLoadingRef.current = false
        armedRef.current = true
        if (!sessionId) return
        const pm = window.electronAPI?.projectManager
        const stop = pm?.findInFilesStop
        if (typeof stop !== 'function') return
        // 终止失败不影响 UI（会话随窗口关闭由主进程回收）
        try {
            void Promise.resolve(stop.call(pm, sessionId)).catch(() => {})
        } catch {
            /* 忽略 */
        }
    }, [])

    /** 瞬时状态复位（close / openMode / 切工作区三处共用；纯 setter，身份稳定） */
    const resetTransient = useCallback(() => {
        setActiveIndex(0)
        setLoading(false)
        setTruncated(false)
        setError(null)
        setStalePaths(new Set())
        setFindFolds(NO_FOLDS)
        setFindDone(false)
        setLoadingMore(false)
    }, [])

    /** Find 会话的列表复位（两处分支共用；不含 setLoading，由调用方按分支给出） */
    const resetFindList = useCallback(() => {
        stopFindSession()
        setResults([])
        setFindFolds(NO_FOLDS)
        setActiveIndex(0)
        setLoadingMore(false)
        setTruncated(false)
        setFindDone(false)
        setError(null)
    }, [stopFindSession])

    const close = useCallback(() => {
        openRef.current = false
        seqRef.current++   // 在途请求的结果一律丢弃
        composingRef.current = false
        stopFindSession()  // 关闭浮层立即终止检索并释放缓冲
        clearPreviewCache()   // 预览缓存与内容一并释放（spec：浮层关掉就把占的内存还回去）
        setMode(null)
        setQuery('')
        // 关闭即释放：列表、错误、标灰集合都不留引用（spec：浮层关掉就把占的内存还回去）
        setResults([])
        resetTransient()
    }, [stopFindSession, resetTransient])

    /** 打开选中项：读文件 → 过大/二进制走既有 gate 占位 → 打开 tab → 记入 Recent Files → 关浮层 */
    const openItem = useCallback(async (item: QuickOpenItem) => {
        const reqWs = wsRef.current
        const pm = window.electronAPI?.projectManager
        if (!reqWs || !pm) return
        const seq = seqRef.current
        const alive = () => seq === seqRef.current && openRef.current && wsRef.current === reqWs
        let r
        // EOF 短路复用（工单 04 第 4 条）：预览取数已带回全文时直接建标签页，省掉第二次全量读
        const cached = findCachedFullContent(reqWs, item.path)
        if (cached) {
            r = fileSliceToContentResult(cached)
        } else {
            try {
                r = await pm.readFile(reqWs, item.path)
            } catch {
                // 已删除 / 改名 / 无权限：不就地处错误，只标灰 + 从记录剔除（下次开浮层即消失）
                if (!alive()) return
                setStalePaths(prev => new Set(prev).add(item.path))
                removeRecentFile(reqWs, item.path)
                return
            }
        }
        if (!alive()) return   // 期间关了浮层 / 切了工作区 / 又搜了一轮 → 丢弃
        useEditorTabStore.getState().openFileTab(toOpenFileTabInput(item.path, basename(item.path), r))
        recordRecentFile(reqWs, item.path)
        // Find in Files：请求编辑器侧定位到命中行（工单 06 的接缝；同路径重复请求也会让 seq 前进）
        if (item.line !== undefined) requestLocate(item.path, item.line)
        setRecentVersion(v => v + 1)
        close()
    }, [close])

    /** 呼出：重置查询与瞬时状态；结果由下方按模式分派的 effect 产出 */
    const openMode = useCallback((m: QuickOpenMode) => {
        openRef.current = true
        seqRef.current++
        composingRef.current = false
        setQuery('')
        resetTransient()
        setMode(m)
    }, [resetTransient])

    /** 浮层内的键位语义（Esc / 上下键 / 回车）。回车只用于打开选中项，不触发搜索 */
    const onKeyDown = useCallback((e: QuickOpenKeyEvent) => {
        // composition 期间把键盘还给输入法（回车用于确认候选，不能拿来开文件）
        if (!openRef.current || e.isComposing) return
        if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
            return
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            e.stopPropagation()
            const delta = e.key === 'ArrowDown' ? 1 : -1
            setActiveIndex(i => moveActiveIndex(i, delta, resultsRef.current.length))
            return
        }
        if (e.key === 'Enter') {
            const item = resultsRef.current[activeIndexRef.current]
            if (!item) return
            e.preventDefault()
            e.stopPropagation()
            void openItem(item)
        }
    }, [close, openItem])

    // 快捷键呼出 + 浮层内键位：同一条 capture 监听器
    useEffect(() => {
        const bindings = quickOpenBindings(IS_MAC)
        const listener = (e: KeyboardEvent) => {
            const cmd = resolveQuickOpenCommand(e, bindings, IS_MAC, mode !== null)
            if (!cmd) {
                onKeyDown(e)
                return
            }
            // 中文输入法 composition 期间把 Esc / 上下键还给输入法（它们用于选候选词）；
            // 呼出类快捷键不受影响（此时并无候选框交互）
            if (e.isComposing && cmd.kind !== 'open') return
            e.preventDefault()
            e.stopPropagation()
            if (cmd.kind === 'close') {
                close()
                return
            }
            if (cmd.kind === 'move') {
                if (!openRef.current) return
                setActiveIndex(i => moveActiveIndex(i, cmd.delta, resultsRef.current.length))
                return
            }
            // 呼出：重置查询，按模式装载数据源
            openMode(cmd.mode)
        }
        document.addEventListener('keydown', listener, true)
        return () => document.removeEventListener('keydown', listener, true)
    }, [mode, close, onKeyDown, openMode])

    /** 当前序号 + 工作区是否仍然有效（在途响应落地的唯一判据） */
    const isAlive = useCallback((seq: number, reqWs: string | null) => (
        seq === seqRef.current && openRef.current && wsRef.current === reqWs
    ), [])

    // ① Recent Files：打开浮层直接读 MRU（无防抖、无 fs 调用）
    useEffect(() => {
        if (mode !== 'recent-files') return
        seqRef.current++   // 使上一模式的在途请求失效
        setResults(workspacePath ? recentToItems(readRecentFiles(workspacePath)) : [])
        setLoading(false)
        setTruncated(false)
        setError(null)
        setActiveIndex(0)
    }, [mode, workspacePath, recentVersion])

    // ② File Search：空查询不发请求；有输入则 120ms 防抖；新查询立即让旧请求失效
    useEffect(() => {
        if (mode !== 'file-search') return
        const q = query.trim()
        if (!workspacePath || q === '') {
            seqRef.current++
            immediateRef.current = false   // 空查询用不上「立即搜」信号，别留给下一次输入
            setResults([])
            setActiveIndex(0)
            setLoading(false)
            setTruncated(false)
            setError(null)
            return
        }
        if (composingRef.current) {
            // composition 期间不触发搜索：清了 loading，等 compositionend 的 tick 再一次性搜
            setLoading(false)
            return
        }
        const seq = ++seqRef.current
        const delay = immediateRef.current ? 0 : FILE_SEARCH_DEBOUNCE_MS
        immediateRef.current = false
        setLoading(true)
        const timer = setTimeout(() => {
            const pm = window.electronAPI?.projectManager
            const search = pm?.searchFiles
            if (typeof search !== 'function') {
                setLoading(false)
                setError('检索能力不可用')
                return
            }
            void Promise.resolve(search.call(pm, workspacePath, q, FILE_SEARCH_LIMIT))
                .then(hits => {
                    if (!isAlive(seq, workspacePath)) return   // 陈旧响应丢弃
                    const list = (hits ?? []).map(hitToItem)
                    setResults(list)
                    setTruncated(list.length >= FILE_SEARCH_LIMIT)
                    setActiveIndex(0)
                    setLoading(false)
                    setError(null)
                })
                .catch(() => {
                    if (!isAlive(seq, workspacePath)) return
                    setResults([])
                    setActiveIndex(0)
                    setLoading(false)
                    setError('检索失败')
                })
        }, delay)
        return () => clearTimeout(timer)
    }, [mode, query, workspacePath, compositionTick, isAlive])

    /**
     * 取一页命中项。
     * `first`：首页（可能 rg 尚未产出命中 → 隔一会儿重试，直到有命中或检索结束）。
     * 落地前校验 token 与工作区；陈旧页直接丢弃（既不合并进列表，也不推进 offset）。
     */
    const loadFindPage = useCallback(async (seq: number, offset: number, first: boolean) => {
        const sessionId = sessionRef.current
        const pm = window.electronAPI?.projectManager
        const reqWs = wsRef.current
        const page = pm?.findInFilesPage
        if (!sessionId || !pm || typeof page !== 'function') return
        pageLoadingRef.current = true
        let result: FindInFilesPage
        try {
            result = await page.call(pm, sessionId, offset, FIND_PAGE_SIZE)
        } catch {
            pageLoadingRef.current = false
            if (!isAlive(seq, reqWs)) return
            setLoading(false)
            setLoadingMore(false)
            setError('检索失败')
            return
        }
        pageLoadingRef.current = false
        // 会话已被换掉（新查询 / 关浮层）或响应过期：丢弃
        if (!isAlive(seq, reqWs) || sessionRef.current !== sessionId) return

        findDoneRef.current = result.done
        findTruncatedRef.current = result.truncated
        setFindDone(result.done)
        setTruncated(result.truncated)

        // 检索根本没跑起来（ripgrep 缺失 / 进程异常退出）：显示原因，绝不伪装成「无匹配」。
        // 打包产物漏掉 rg.exe 时就是这条路径——当时只返回 0 个命中项，看起来像搜索逻辑坏了。
        if (result.error) {
            findRawRef.current = []
            setResults([])
            setLoading(false)
            setLoadingMore(false)
            setError(result.error)
            return
        }

        const matches = result.matches ?? []
        if (first && matches.length === 0 && !result.done) {
            // 首页还没等到 rg 的命中：保持 loading，隔一会儿再取（拉取式接口，无推送）
            retryRef.current = setTimeout(() => {
                retryRef.current = null
                if (!isAlive(seq, reqWs) || sessionRef.current !== sessionId) return
                void loadFindPage(seq, offset, first)
            }, FIND_FIRST_PAGE_RETRY_MS)
            return
        }
        const merged = offset === 0 ? matches : [...findRawRef.current, ...matches]
        findRawRef.current = merged
        const folded = foldFindItems(merged, FIND_PER_FILE_LIMIT)
        setResults(folded.items)
        setFindFolds(folded.folds)
        if (offset === 0) setActiveIndex(0)
        setLoading(false)
        setLoadingMore(false)
        setError(null)
    }, [isAlive])

    /** 开一次检索会话并取首页（新查询走这里） */
    const startFindSearch = useCallback(async (seq: number, q: string) => {
        const pm = window.electronAPI?.projectManager
        const reqWs = wsRef.current
        const start = pm?.findInFilesStart
        if (!pm || !reqWs) return
        if (typeof start !== 'function') {
            setLoading(false)
            setError('检索能力不可用')
            return
        }
        let sessionId: string
        try {
            ({sessionId} = await start.call(pm, reqWs, q))
        } catch {
            if (!isAlive(seq, reqWs)) return
            setLoading(false)
            setError('检索失败')
            return
        }
        if (!isAlive(seq, reqWs)) {
            // 会话已作废（又搜了一轮 / 关了浮层）：立刻终止刚开起来的检索进程，不留后台工作
            const stop = pm.findInFilesStop
            if (typeof stop === 'function') void Promise.resolve(stop.call(pm, sessionId)).catch(() => {})
            return
        }
        sessionRef.current = sessionId
        await loadFindPage(seq, 0, true)
    }, [isAlive, loadFindPage])

    // ③ Find in Files：空查询不搜；120ms 防抖；新查询立即终止旧会话；compositionend 立即搜一次
    useEffect(() => {
        if (mode !== 'find-in-files') {
            // 离开该模式：终止可能还活着的会话（缓冲随之释放）
            if (sessionRef.current) stopFindSession()
            return
        }
        const q = query.trim()
        if (!workspacePath || q === '') {
            seqRef.current++
            immediateRef.current = false
            resetFindList()
            setLoading(false)
            return
        }
        if (composingRef.current) {
            // composition 期间不触发搜索：清了 loading，等 compositionend 的 tick 再一次性搜
            setLoading(false)
            return
        }
        const seq = ++seqRef.current
        const delay = immediateRef.current ? 0 : FILE_SEARCH_DEBOUNCE_MS
        immediateRef.current = false
        // 新查询立即终止上一次检索（不等防抖结束），旧缓冲同时释放
        resetFindList()
        setLoading(true)
        const timer = setTimeout(() => { void startFindSearch(seq, q) }, delay)
        return () => clearTimeout(timer)
    }, [mode, query, workspacePath, compositionTick, startFindSearch, stopFindSession, resetFindList])

    /** 列表滚动 → 触底翻页（armed / re-arm 互斥；不使用 IntersectionObserver） */
    const onListScroll = useCallback((metrics: ScrollMetrics) => {
        if (!openRef.current || mode !== 'find-in-files') return
        const canLoad = !findDoneRef.current && !findTruncatedRef.current && !pageLoadingRef.current
        const decision = resolveScrollLoad(armedRef.current, isNearBottom(metrics), canLoad)
        armedRef.current = decision.armed
        if (!decision.load) return
        setLoadingMore(true)
        void loadFindPage(seqRef.current, findRawRef.current.length, false)
    }, [mode, loadFindPage])

    // 卸载：终止检索会话（PM 窗口关闭 / 热更新时不把 rg 子进程留在后台）
    useEffect(() => () => { stopFindSession() }, [stopFindSession])

    // 切换工作区：结果整体失效，不跨工作区串味（在途请求由序号前进挡住）；
    // 预览缓存含工作区归属，也必须整体清空
    const prevWsRef = useRef(workspacePath)
    useEffect(() => {
        if (prevWsRef.current === workspacePath) return   // 首次挂载不算切换
        prevWsRef.current = workspacePath
        seqRef.current++
        composingRef.current = false
        stopFindSession()
        clearPreviewCache()
        setResults([])
        resetTransient()
    }, [workspacePath, stopFindSession, resetTransient])

    // 结果集变化后把选中项夹回合法范围（快速划过时不会指向不存在的项）
    useEffect(() => {
        setActiveIndex(i => clampActiveIndex(i, results.length))
    }, [results.length])

    const onCompositionStart = useCallback(() => { composingRef.current = true }, [])
    const onCompositionEnd = useCallback(() => {
        composingRef.current = false
        immediateRef.current = true
        setCompositionTick(t => t + 1)   // 立即搜一次（不走 120ms 防抖）
    }, [])

    const activateIndex = useCallback((index: number) => {
        const item = resultsRef.current[index]
        if (item) void openItem(item)
    }, [openItem])

    const clearRecent = useCallback(() => {
        const reqWs = wsRef.current
        if (!reqWs) return
        clearRecentFiles(reqWs)
        setRecentVersion(v => v + 1)
    }, [])

    return {
        mode, query, setQuery, results, activeIndex, loading, truncated, error, stalePaths,
        findFolds, hasMore: mode === 'find-in-files' && !findDone && !truncated, loadingMore, onListScroll,
        onKeyDown, onCompositionStart, onCompositionEnd, activateIndex, clearRecent, close,
    }
}
