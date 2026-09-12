/**
 * 「按显示顺序排列选中项」工具。
 *
 * 多选入口（文件树 / 变更列表 / commit 详情）在右键菜单里发「发送到会话」时，
 * 都需要把选中集合按**界面显示顺序**排列：显示顺序数组只含当前可见行，
 * 而选中集合可能含折叠目录 / 未加载行的成员 —— 故只能排序，不能 filter
 * （filter 会静默丢成员）。不可见项（无显示序号）统一排到末尾。
 */

/** 无显示序号的哨兵：大于任何真实序号 */
const NO_INDEX = Number.MAX_SAFE_INTEGER

/** 按 displayOrder 排列 items；不可见项排末尾（稳定排序保持其原有相对顺序） */
export function sortByVisibleOrder(items: Iterable<string>, displayOrder: readonly string[]): string[] {
  const index = new Map(displayOrder.map((item, i) => [item, i] as const))
  return [...items].sort((a, b) => (index.get(a) ?? NO_INDEX) - (index.get(b) ?? NO_INDEX))
}

/** 右键菜单「发送到会话」的路径列表：有选中集合时按显示顺序全发，否则只发右键命中项 */
export function menuSendPaths(selected: ReadonlySet<string>, displayOrder: readonly string[], fallback: string): string[] {
  return selected.size > 0 ? sortByVisibleOrder(selected, displayOrder) : [fallback]
}
