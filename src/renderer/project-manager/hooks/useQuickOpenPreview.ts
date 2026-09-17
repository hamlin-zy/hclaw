// 预览取数的 React 薄壳（工单 04）：防抖 → pm.readLines → token 校验 → 落地 / 写缓存。
//
// 纯逻辑（范围、缓存、元信息行、行切片、落地判定）全在 lib/quickOpenPreview.ts，
// 这里只做三件有副作用的事：计时器、IPC、把结果放进 React state。
// 缓存是**进程级单例**，因此本 hook 的三条生命周期钩子必须守住边界：
// - 卸载（= 浮层关闭）→ 序号前进 + 清空缓存（spec：浮层关掉就把占的内存还回去）；
// - 切换工作区 → 清空缓存（spec：切工作区即清空缓存，不跨工作区串味）；
// - 选中项变化 → 序号前进（陈旧响应既不覆盖新选中项，也不污染缓存）。
import {useEffect, useRef, useState} from 'react'
import type {QuickOpenMode} from '../lib/quickOpenKeymap'
import type {QuickOpenItem} from '../lib/quickOpenResults'
import {highlightLines, type LineToken} from '../lib/syntaxHighlight'
import {
    IDLE_PREVIEW,
    PREVIEW_DEBOUNCE_MS,
    PREVIEW_FAIL_FALLBACK,
    acceptPreviewResponse,
    clearPreviewCache,
    previewCache,
    previewCacheKey,
    previewMetaLine,
    previewRangeFor,
    previewViewFromSlice,
    type PreviewView,
} from '../lib/quickOpenPreview'

/** 取数失败（IPC 层抛错）时的占位视图：保留路径，不留空白 */
function failedView(item: QuickOpenItem, error: string): PreviewView {
    return {status: 'error', meta: previewMetaLine(item, null), rows: [], error}
}

/** 预览面板的完整可渲染状态：视图 + 与之逐行对齐的语法着色 */
export interface QuickOpenPreviewState {
    view: PreviewView
    /** 语法着色：与 `view.rows` 同序同长；null = 不着色（语言不支持 / 未取到数 / 尚未就绪） */
    tokens: LineToken[][] | null
}

/**
 * 预览取数。`workspacePath` 为空（无工作区 / 单测直渲浮层）时不取数，只给元信息行。
 */
export function useQuickOpenPreview(
    workspacePath: string | null,
    mode: QuickOpenMode,
    item: QuickOpenItem | null,
): QuickOpenPreviewState {
    const [view, setView] = useState<PreviewView>(IDLE_PREVIEW)
    const [tokens, setTokens] = useState<LineToken[][] | null>(null)
    /** 单调请求序号：选中项 / 工作区 / 浮层关闭都会让它前进，迟到的响应据此丢弃 */
    const seqRef = useRef(0)
    /**
     * 最近一次渲染传入的选中项。取数 effect **只按原始值（path / line）重跑**，对象身份不进依赖：
     * 否则调用方每帧新建 `{path, ...}` 字面量时，effect → setView → 重渲染 → effect 会无界循环
     * （实测能把 worker 撑到 4GB OOM）。effect 内取最新对象一律读这个 ref。
     */
    const itemRef = useRef(item)
    itemRef.current = item
    const itemPath = item?.path ?? null
    const itemLine = item?.line ?? null

    // 卸载 = 浮层关闭：在途响应作废，缓存整体释放
    useEffect(() => () => {
        seqRef.current++
        clearPreviewCache()
    }, [])

    // 切换工作区：缓存键换了域，旧仓库的条目一律不留
    useEffect(() => {
        clearPreviewCache()
    }, [workspacePath])

    useEffect(() => {
        const seq = ++seqRef.current
        const current = itemRef.current
        if (!current || !workspacePath) {
            setView(IDLE_PREVIEW)
            return
        }
        const range = previewRangeFor(mode, current)
        const key = previewCacheKey(workspacePath, current.path, range.start, range.end)

        // 缓存命中：立即出内容，不再防抖（防抖只为省掉「划过去」的无效读取）
        const cached = previewCache.get(key)
        if (cached) {
            setView(previewViewFromSlice(cached, current))
            return
        }

        const pm = window.electronAPI?.projectManager
        const readLines = pm?.readLines
        if (typeof readLines !== 'function') {
            setView(failedView(current, '预览能力不可用'))
            return
        }
        setView({status: 'loading', meta: previewMetaLine(current, null), rows: [], error: null})
        // 先用当前选中项渲染 loading 视图（元信息行含路径），再起防抖计时器
        const timer = setTimeout(() => {
            void Promise.resolve(readLines.call(pm, workspacePath, current.path, range.start, range.end))
                .then(slice => {
                    if (!acceptPreviewResponse(seq, seqRef.current)) return   // 陈旧：不写 state、不写缓存
                    previewCache.set(key, slice)
                    setView(previewViewFromSlice(slice, current))
                })
                .catch(() => {
                    if (!acceptPreviewResponse(seq, seqRef.current)) return   // 同上：失败的陈旧响应也不落地
                    setView(failedView(current, PREVIEW_FAIL_FALLBACK))
                })
        }, PREVIEW_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [workspacePath, mode, itemPath, itemLine])

    // 语法着色：复用 lib/syntaxHighlight.ts —— 与 CodeEditor / DiffViewer 同源，
    // 于是同一份代码在编辑器、diff、预览三处必然同色（改令牌即可三处同时生效）。
    // 只解析**预览窗口内的那几行**（不为预览多读全文）：跨窗口的语法上下文（如自上一行
    // 开始的块注释）会退化，这是预览这一档可接受的代价。着色是可选增强，失败就退回无色。
    useEffect(() => {
        if (view.status !== 'ready' || itemPath === null) {
            setTokens(null)
            return
        }
        let cancelled = false
        const content = view.rows.map(r => r.text).join('\n')
        void highlightLines(content, itemPath)
            .then(next => { if (!cancelled) setTokens(next) })
            .catch(() => { if (!cancelled) setTokens(null) })
        return () => { cancelled = true }
    }, [view, itemPath])

    return {view, tokens}
}
