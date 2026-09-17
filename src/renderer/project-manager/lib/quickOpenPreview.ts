// QuickOpen 预览面板（浮层第三行）的**纯逻辑** + LRU-10 缓存（spec §预览 / 工单 04）。
//
// 拆成无状态纯函数（spec §Testing Decisions 第 3 条）：取数范围计算、缓存键、元信息行、
// 行切片、响应落地判定都能脱离 React 单测；React 侧只剩「防抖 + 调用 pm.readLines + 落地判定」
// 这层薄壳（hooks/useQuickOpenPreview.ts）。
//
// 三条硬约束（都来自 spec）：
// - 取数一律走按行读取（`pm.readLines`），**不准**用 `pm.readFile`（那是全量读）；
// - 陈旧响应丢弃时**不写缓存**（否则会把旧选中项的内容喂给下一次打开的同一个文件）；
// - 缓存键含工作区归属，切换工作区即整体清空。
import type {FileSliceResult} from '@shared/types/project-manager'
import type {LineToken} from './syntaxHighlight'
import type {QuickOpenMode} from './quickOpenKeymap'
import {type QuickOpenItem, formatDateTime} from './quickOpenResults'

/** File Search / Recent Files：预览文件头 20 行 */
export const PREVIEW_HEAD_LINES = 20
/** Find in Files：预览命中行上下 3 行 */
export const PREVIEW_CONTEXT_LINES = 3
/** 预览缓存容量（spec：LRU-10） */
export const PREVIEW_CACHE_LIMIT = 10
/** 选中项变化后的取数防抖（spec：120ms；与 File Search 同一时长） */
export const PREVIEW_DEBOUNCE_MS = 120

/** 请求的行范围（1-based，含首含尾） */
export interface PreviewRange {
    start: number
    end: number
}

/**
 * 选中项 → 取数范围。
 * Find in Files：命中行上下 3 行（行号已经过 1-based 夹紧）；其余模式：文件头 20 行。
 */
export function previewRangeFor(mode: QuickOpenMode, item: Pick<QuickOpenItem, 'line'>): PreviewRange {
    if (mode === 'find-in-files' && item.line !== undefined) {
        return {start: Math.max(1, item.line - PREVIEW_CONTEXT_LINES), end: item.line + PREVIEW_CONTEXT_LINES}
    }
    return {start: 1, end: PREVIEW_HEAD_LINES}
}

/**
 * 缓存键：**含工作区归属**（spec：缓存键含工作区归属，切工作区即清空）。
 * 行范围一并入键，因为同一文件在不同模式下请求的范围不同、内容也不同。
 */
export function previewCacheKey(workspacePath: string, path: string, start: number, end: number): string {
    return `${workspacePath}\u0000${path}\u0000${start}\u0000${end}`
}

/** 缓存条目：键（含 ws）→ 按行读取结果 */
export type PreviewCacheValue = FileSliceResult

/**
 * LRU 缓存（容量 10，按最近使用淘汰）。
 * `get` 命中即移到队尾（最近使用）；`set` 超容量时从队头（最久未用）淘汰。
 */
export class PreviewCache {
    private readonly map = new Map<string, PreviewCacheValue>()

    constructor(private readonly limit: number = PREVIEW_CACHE_LIMIT) {}

    get(key: string): PreviewCacheValue | undefined {
        const value = this.map.get(key)
        if (value === undefined) return undefined
        this.map.delete(key)
        this.map.set(key, value)   // 移到队尾 = 最近使用
        return value
    }

    set(key: string, value: PreviewCacheValue): void {
        if (this.map.has(key)) this.map.delete(key)
        this.map.set(key, value)
        while (this.map.size > this.limit) {
            const oldest = this.map.keys().next()
            if (oldest.done) break
            this.map.delete(oldest.value)
        }
    }

    has(key: string): boolean {
        return this.map.has(key)
    }

    size(): number {
        return this.map.size
    }

    entries(): Array<[string, PreviewCacheValue]> {
        return [...this.map.entries()]
    }

    clear(): void {
        this.map.clear()
    }
}

/**
 * 进程级单例：预览缓存跨「选中项变化」存活（这正是它存在的意义），
 * 但**不跨浮层关闭 / 工作区切换**——两处都会调用 `clearPreviewCache()`。
 */
export const previewCache = new PreviewCache()

export function clearPreviewCache(): void {
    previewCache.clear()
}

/** 当前缓存条目数（测试与内存水位观测用） */
export function previewCacheSize(): number {
    return previewCache.size()
}

/**
 * EOF 短路复用（spec / issue 04 第 4 条）：预览取数若已抵达文件尾且文件不超过阈值，
 * 主进程会一并带回 `fullContent` + `hash`。把它留在缓存里，**从列表打开该文件时直接
 * 用它建标签页**，省掉第二次全量读。
 *
 * 只在缓存里找（不发起新的读取）；命中任意一个带全文的条目即可——全文与请求的行范围无关。
 */
export function findCachedFullContent(workspacePath: string, path: string): FileSliceResult | null {
    const prefix = `${workspacePath}\u0000${path}\u0000`
    for (const [key, value] of previewCache.entries()) {
        if (!key.startsWith(prefix)) continue
        if (value.fullContent !== undefined && value.hash !== undefined) return value
    }
    return null
}

/**
 * 响应落地判定：请求序号与当前序号一致时才接受。
 * 陈旧响应（用户已划走 / 已关浮层 / 已换工作区）**既不写 state 也不写缓存**。
 */
export function acceptPreviewResponse(token: number, current: number): boolean {
    return token === current
}

/** 失败文案占位（主进程未给出 error 时的兜底；正常路径用主进程的单行中文原因） */
export const PREVIEW_FAIL_FALLBACK = '预览读取失败'

/** 字节数 → 元信息行用的大小文案 */
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 时间戳 → 元信息行用的修改时间文案（YYYY-MM-DD HH:mm，本地时区） */
export function formatMtime(mtime: number): string {
    if (!Number.isFinite(mtime) || mtime <= 0) return ''
    return formatDateTime(mtime)
}

/**
 * 元信息行：**完整相对路径 · 大小 · 修改时间**。
 * 完整相对路径是刻意给出的（同名文件靠文件名分不出来）；取数失败时 size/mtime 缺失，
 * 此时至少保留路径，绝不留空白。
 */
export function previewMetaLine(item: Pick<QuickOpenItem, 'path'>, slice: FileSliceResult | null): string {
    const parts = [item.path]
    const size = slice?.size
    const mtime = slice?.mtime
    if (typeof size === 'number') {
        const text = formatFileSize(size)
        if (text !== '') parts.push(text)
    }
    if (typeof mtime === 'number') {
        const text = formatMtime(mtime)
        if (text !== '') parts.push(text)
    }
    return parts.join(' · ')
}

/** 预览行：自画行号 + 行文本 + 行内命中区间（null = 该行无命中高亮） */
export interface PreviewRow {
    lineNumber: number
    text: string
    hitStart: number | null
    hitEnd: number | null
}

/**
 * 按行切片 → 预览行。
 * 行号用主进程返回的 `startLine` 推导（1-based），命中区间只对 **Find in Files 的命中行** 生效
 * ——区间由主进程给出（`QuickOpenItem.matchStart/matchEnd` 在 find-in-files 下是**行内**区间），
 * renderer 不重算匹配。
 */
export function buildPreviewRows(slice: FileSliceResult, item: QuickOpenItem | null): PreviewRow[] {
    const hitLine = item?.line
    const hitStart = item?.matchStart ?? null
    const hitEnd = item?.matchEnd ?? null
    return slice.lines.map((text, i) => {
        const lineNumber = slice.startLine + i
        const isHit = hitLine !== undefined && lineNumber === hitLine
        return {
            lineNumber,
            text,
            hitStart: isHit ? hitStart : null,
            hitEnd: isHit ? hitEnd : null,
        }
    })
}

/** 预览行的一个渲染片段：着色类名（'' = 不着色）+ 是否落在命中区间内 */
export interface PreviewSegment {
    text: string
    cls: string
    hit: boolean
}

/**
 * 该行的着色片段（**防御性校验**）：拼回来必须逐字等于行文本，否则返回 null 走无着色渲染。
 * 与 DiffViewer 的 pickLineTokens 同一道闸——着色是可选增强，宁可不着色，不可错位或丢字。
 */
function pickLineTokens(tokens: LineToken[] | null, lineText: string): LineToken[] | null {
    if (!tokens) return null
    return tokens.map(tk => tk.text).join('') === lineText ? tokens : null
}

/**
 * 语法着色片段 × 行内命中区间（Find in Files）→ 可直接渲染的片段序列。
 *
 * 两侧都是**无损覆盖整行**的切分（tokens 的不变量见 lib/syntaxHighlight.ts），求交后仍无损；
 * 相邻同 (cls, hit) 的片段就地合并，避免把一行拆成大量碎片 span。
 */
export function mergePreviewSegments(
    lineText: string,
    tokens: LineToken[] | null,
    hitStart: number | null,
    hitEnd: number | null,
): PreviewSegment[] {
    const segments = pickLineTokens(tokens, lineText) ?? [{text: lineText, cls: ''}]
    const hitFrom = hitStart ?? 0
    const hitTo = hitEnd ?? 0
    const hasHit = hitTo > hitFrom
    const out: PreviewSegment[] = []
    const push = (text: string, cls: string, hit: boolean) => {
        if (text === '') return
        const last = out[out.length - 1]
        if (last && last.cls === cls && last.hit === hit) last.text += text
        else out.push({text, cls, hit})
    }
    let offset = 0
    for (const seg of segments) {
        const from = offset
        const to = offset + seg.text.length
        offset = to
        if (!hasHit || to <= hitFrom || from >= hitTo) {
            push(seg.text, seg.cls, false)
            continue
        }
        const cutFrom = Math.max(from, hitFrom) - from
        const cutTo = Math.min(to, hitTo) - from
        push(seg.text.slice(0, cutFrom), seg.cls, false)
        push(seg.text.slice(cutFrom, cutTo), seg.cls, true)
        push(seg.text.slice(cutTo), seg.cls, false)
    }
    return out
}

/** 预览面板的可渲染状态（hook 与组件之间的契约） */
export interface PreviewView {
    /** idle = 无选中项 / 无工作区（不取数）；loading = 防抖等待或请求在途；ready = 有行；error = 单行原因 */
    status: 'idle' | 'loading' | 'ready' | 'error'
    /** 元信息行（完整相对路径 · 大小 · 修改时间） */
    meta: string
    rows: PreviewRow[]
    /** 失败的单行原因（status === 'error' 时非空） */
    error: string | null
}

export const IDLE_PREVIEW: PreviewView = {status: 'idle', meta: '', rows: [], error: null}

/** 取数结果 → 可渲染状态（成功有行；失败走 error 分支，不显示空白） */
export function previewViewFromSlice(slice: FileSliceResult, item: QuickOpenItem): PreviewView {
    const meta = previewMetaLine(item, slice)
    if (slice.error) return {status: 'error', meta, rows: [], error: slice.error}
    return {status: 'ready', meta, rows: buildPreviewRows(slice, item), error: null}
}
