/**
 * 备忘录列表排序 / 拖拽重排纯函数（MemoPanel 使用，独立导出便于测试）
 *
 * 排序规则（spec）：
 * 未处理在前（两级分组）→ 组内 pinned 优先 → sortIndex desc → createdAt asc
 */
import type {MemoItem} from '@shared/types/memo'

/** 组内比较器：pinned 优先 → sortIndex desc → createdAt asc */
export function compareWithinGroup(a: MemoItem, b: MemoItem): number {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if ((b.sortIndex ?? 0) !== (a.sortIndex ?? 0)) return (b.sortIndex ?? 0) - (a.sortIndex ?? 0)
    return a.createdAt - b.createdAt
}

/** 备忘录列表排序：未处理分组在前，各组内按 compareWithinGroup */
export function sortMemos(list: MemoItem[]): MemoItem[] {
    const active = list.filter(m => m.status === 'active').sort(compareWithinGroup)
    const processed = list.filter(m => m.status !== 'active').sort(compareWithinGroup)
    return [...active, ...processed]
}

/**
 * 组内拖拽重排（纯函数）：
 * - 从 items 中取出被拖拽项，插入到 targetIndex 位置，返回新数组
 * - 约束校验：重排后不允许出现「非置顶项排在置顶项之前」（未置顶不能上穿置顶区），
 *   违反时返回 null（调用方拒绝落库）
 */
export function reorderGroup(items: MemoItem[], dragId: string, targetIndex: number): MemoItem[] | null {
    if (targetIndex < 0 || targetIndex > items.length) return null
    const from = items.findIndex(m => m.id === dragId)
    if (from === -1) return null
    const next = [...items]
    const [dragged] = next.splice(from, 1)
    // 移除后索引左移修正：原位置在目标之前时目标索引 -1
    const insertAt = targetIndex > from ? targetIndex - 1 : targetIndex
    next.splice(insertAt, 0, dragged)
    // 约束：置顶项必须连续位于组首（等价于不存在「非置顶在置顶之前」）
    const firstUnpinned = next.findIndex(m => !m.pinned)
    if (firstUnpinned !== -1 && next.slice(firstUnpinned).some(m => m.pinned)) return null
    return next
}

/** 组内全量重编号：按数组顺序赋 sortIndex = n..1（倒序）。
 *  ★ 必须与比较器 sortIndex desc 同向：数组第 1 项拿最大值才能显示在最前。
 *  （此前正序 1..n 与 desc 比较器反向，拖拽到顶的项会显示在最底） */
export function renumberGroup(ordered: MemoItem[]): Array<{id: string; sortIndex: number}> {
    const n = ordered.length
    return ordered.map((m, i) => ({id: m.id, sortIndex: n - i}))
}
