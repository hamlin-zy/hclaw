/**
 * 定位高亮的**决策逻辑**（工单 06）——无状态纯函数，与 React / CodeMirror 无关。
 *
 * 为什么单独拎出来：定位的语义有一半是「判断」而不是「副作用」——
 * 这次要不要重新滚动、这次选区变化该不该清掉高亮、这个请求属不属于当前激活文件。
 * 判断放这里可以脱离 DOM 单测；副作用（dispatch 装饰、起计时器）留在 CodeEditor / EditorArea。
 */

/** 定位高亮点亮多久后**硬清除**（无渐隐） */
export const LOCATE_HIGHLIGHT_MS = 1500

/** 一次定位的落点：工作区相对路径 + 1-based 行号 */
export interface LocateTarget {
    path: string
    line: number
}

/** 一次定位的应用计划 */
export interface LocatePlan {
    /**
     * 是否需要重新滚动（并把光标移到目标行行首）。
     * 重复定位到**同一文件的同一行**时为 false —— 只重置计时，视线不跳。
     */
    scroll: boolean
}

/**
 * 规划一次定位：与上一次已点亮的落点比较。
 *
 * 判据是 `path` 与 `line` **同时**相同：换文件时哪怕行号一样也必须滚动
 * （编辑器视图已按新文件重建，不滚的话目标行可能落在视口之外）。
 */
export function planLocate(previous: LocateTarget | null, next: LocateTarget): LocatePlan {
    const sameSpot = previous !== null && previous.path === next.path && previous.line === next.line
    return {scroll: !sameSpot}
}

/** 行号夹紧到 `[1, totalLines]`（越界不报错，落到最近的有效行；非有限值落到第 1 行） */
export function clampLine(line: number, totalLines: number): number {
    const n = Math.floor(line)
    if (!Number.isFinite(n)) return 1
    return Math.min(Math.max(1, n), Math.max(1, Math.floor(totalLines)))
}

/** 选区变化的来源：`locate` = 定位自身造成（把光标移到目标行行首），`user` = 用户手动操作 */
export type SelectionChangeOrigin = 'locate' | 'user'

/**
 * 用户操作优先：只有**用户自己**发起的选区变化才清除定位高亮。
 * 定位本身会把光标移到目标行行首，那次变化必须被显式标记为 `locate` 来源，
 * 否则高亮刚点亮就被自己清掉（见 CodeEditor 的举旗标记）。
 */
export function shouldClearLocateOnSelectionChange(origin: SelectionChangeOrigin): boolean {
    return origin === 'user'
}

/** 定位请求是否属于当前激活文件（切 tab 时不得把上一个 tab 的请求应用到新 tab） */
export function isLocateTargetForActiveFile(
    targetPath: string,
    activeFilePath: string | null | undefined,
): boolean {
    return activeFilePath != null && targetPath === activeFilePath
}
