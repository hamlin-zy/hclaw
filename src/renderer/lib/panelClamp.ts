/**
 * 面板右缘钳制 — 共享给 ModelSelector / SchemeSelector 等固定定位浮层。
 *
 * 浮层右缘贴按钮向左展开（`right = innerWidth - rect.right`）。
 * 当按钮靠近窗口左缘时，按面板实测宽度钳制 `right`，保证面板左缘 ≥ margin 留白。
 *
 * 与内联逻辑等价：
 * ```ts
 * let right = window.innerWidth - rect.right
 * const w = ref.current?.offsetWidth
 * if (w) {
 *     const maxRight = window.innerWidth - w - margin
 *     if (right > maxRight) right = Math.max(margin, maxRight)
 * }
 * ```
 */
export const PANEL_EDGE_MARGIN = 8

export function clampPanelRight(
    buttonRight: number,
    panelWidth: number | undefined,
    windowInnerWidth: number,
    margin = PANEL_EDGE_MARGIN,
): number {
    // 与 `if (w)` 守卫等价：0/undefined 时原值不变
    if (!panelWidth) return buttonRight
    const maxRight = windowInnerWidth - panelWidth - margin
    if (buttonRight > maxRight) return Math.max(margin, maxRight)
    return buttonRight
}
