/** 最近会话区一行的高度（px）。锚点：ConversationItem 行高密度收敛后目标行高 ≈32px（ConversationSidebar.tsx iconContainerClass 注释） */
export const RECENT_ROW_HEIGHT = 32

/** 最近会话区高度约束（spec §5.6）：上限 = 主列表高度一半，下限 = 一行高度 */
export function clampRecentHeight(value: number, listHeight: number, rowHeight: number): number {
    const upper = Math.max(rowHeight, Math.floor(listHeight / 2))
    return Math.min(upper, Math.max(rowHeight, Math.round(value)))
}
