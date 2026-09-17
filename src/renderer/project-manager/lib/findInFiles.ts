// Find in Files 的**纯逻辑**（工单 05）：命中项映射、每文件折叠、分页与触底互斥判定、文案。
//
// 与 React / IPC 无关，故可单独测试（spec §Testing Decisions：renderer 纯逻辑落成无状态纯函数后测试）。
// 命中区间与行号一律来自主进程（`FindInFilesMatch`），renderer 不重算匹配。
import type {FindInFilesMatch} from '@shared/types/project-manager'
import type {QuickOpenItem} from './quickOpenResults'

/** 每页命中项数（spec：每页 20 个命中项，以命中项计不以文件计） */
export const FIND_PAGE_SIZE = 20
/** 同一文件最多展开的命中行数；其余折叠为一行「还有 M 处」（spec：阈值 10） */
export const FIND_PER_FILE_LIMIT = 10
/** 触底判定的提前量（px）。同 commit 列表先例：48px ≈ 2 行，避免亚像素 / 惯性滚动错过最后一帧 */
export const FIND_SCROLL_THRESHOLD = 48
/**
 * 首页轮询间隔：主进程的翻页接口是**拉取式**（无推送），rg 首屏命中要等它跑起来；
 * 首个页面为空且会话未结束时，隔一会儿再取一次，直到有命中或检索结束。
 */
export const FIND_FIRST_PAGE_RETRY_MS = 120
/** 缓冲达到上限被截断时的标注文案（spec：结果不完整，UI 必须标注） */
export const FIND_TRUNCATED_TEXT = '检索结果已达上限，仅显示已找到的部分'

/** 主进程命中项 → 列表条目（`matchStart/matchEnd` 在 find-in-files 下是**行内**区间） */
export function findMatchToItem(match: FindInFilesMatch): QuickOpenItem {
    return {
        path: match.path,
        matchStart: match.matchStart,
        matchEnd: match.matchEnd,
        line: match.line,
        matchText: match.text,
    }
}

/** 折叠结果：可导航的命中项行 + 每个文件被折叠掉的命中数（path → M） */
export interface FoldedFindList {
    items: QuickOpenItem[]
    folds: ReadonlyMap<string, number>
}

/**
 * 每文件最多展开 `limit` 个命中项，其余折叠为一行「还有 M 处」。
 * 返回的 `items` 是**可导航**的命中项（折叠掉的不在其中）；`folds` 只带折叠数量，
 * 由列表渲染在同一个文件的最后一行之后插入折叠行。
 */
export function foldFindItems(
    matches: readonly FindInFilesMatch[],
    limit: number = FIND_PER_FILE_LIMIT,
): FoldedFindList {
    const kept = new Map<string, number>()
    const total = new Map<string, number>()
    const items: QuickOpenItem[] = []
    for (const match of matches) {
        total.set(match.path, (total.get(match.path) ?? 0) + 1)
        const shown = kept.get(match.path) ?? 0
        if (shown >= limit) continue
        kept.set(match.path, shown + 1)
        items.push(findMatchToItem(match))
    }
    const folds = new Map<string, number>()
    for (const [path, count] of total) {
        const hidden = count - (kept.get(path) ?? 0)
        if (hidden > 0) folds.set(path, hidden)
    }
    return {items, folds}
}

/** 折叠行文案 */
export function foldRowText(hidden: number): string {
    return `还有 ${hidden} 处`
}

/** 滚动容器度量（触底判定的全部输入；不依赖 DOM 类型，便于单测直接构造） */
export interface ScrollMetrics {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
}

/** 距底 ≤ 阈值即视为触底 */
export function isNearBottom(metrics: ScrollMetrics, threshold: number = FIND_SCROLL_THRESHOLD): boolean {
    const distance = metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight)
    return distance <= threshold
}

/** armed / re-arm 决策结果 */
export interface ScrollLoadDecision {
    /** 下一次滚动时是否已武装 */
    armed: boolean
    /** 本次滚动是否应该加载下一页 */
    load: boolean
}

/**
 * 触底加载的 **armed / re-arm 互斥**（先例：commit 列表，见 GitDagGraph.onScroll）。
 *
 * 为什么必须有这层约束：追加新页后 Chromium 的滚动锚定会再派发一次 scroll，此时仍满足触底条件，
 * 不做 re-arm 就会连环翻页直到把缓冲抽干。因此：触发一页即解除武装，只有**离开底部阈值区间**
 * （用户真的滚开了）才重新武装。定时器节流只是把它变慢，用户仍会看到列表自己刷到底，故不采用。
 */
export function resolveScrollLoad(armed: boolean, nearBottom: boolean, canLoad: boolean): ScrollLoadDecision {
    if (!nearBottom) return {armed: true, load: false}
    if (!armed) return {armed: false, load: false}
    if (!canLoad) return {armed: true, load: false}
    return {armed: false, load: true}
}
