/**
 * 备忘录列表排序 / 拖拽重排纯函数（MemoPanel 使用，独立导出便于测试）
 *
 * 排序规则（spec）：
 * - 待办（active）：pinned 优先 → sortIndex desc → createdAt asc（compareWithinGroup）
 * - 历史（processed）：按创建日期层级分组（本月→日；本年→月→日；往年→年→月→日），
 *   组间倒序（最近在上）、组内 createdAt desc（最新在上）
 */
import type {MemoItem} from '@shared/types/memo'

/** 组内比较器（待办用）：pinned 优先 → sortIndex desc → createdAt asc */
export function compareWithinGroup(a: MemoItem, b: MemoItem): number {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if ((b.sortIndex ?? 0) !== (a.sortIndex ?? 0)) return (b.sortIndex ?? 0) - (a.sortIndex ?? 0)
    return a.createdAt - b.createdAt
}

/** 待办列表排序：过滤 active + compareWithinGroup */
export function sortActiveMemos(list: MemoItem[]): MemoItem[] {
    return list.filter(m => m.status === 'active').sort(compareWithinGroup)
}

/** 通用日期分组节点：year/month 含 children，day 含 items（组内已按 createdAt desc 排序） */
export interface DateGroup<T = unknown> {
    kind: 'year' | 'month' | 'day'
    label: string
    items: T[]
    children: DateGroup<T>[]
}

/** 备忘录历史分组节点（向后兼容别名） */
export type ProcessedDateGroup = DateGroup<MemoItem>

/** 递归统计分组节点下的条目总数（组头角标用） */
export function countGroupItems<T>(g: DateGroup<T>): number {
    if (g.kind === 'day') return g.items.length
    return g.children.reduce((n, c) => n + countGroupItems(c), 0)
}

/**
 * 通用日期层级分组（备忘录历史 / 会话列表共用）：
 * - 本月（now 所在年月）→ 顶层「日」组
 * - 本年其他月 → 顶层「月」组 +「日」子组
 * - 往年 → 顶层「年」组 +「月」子组 +「日」孙组
 *
 * 组间倒序（最近的日期在上），组内（日组 items）按 createdAt desc（最新在上）。
 * now 参数可注入以稳定测试（默认 Date.now()）。
 */
export function groupByDateHierarchy<T extends {createdAt: number}>(items: T[], now = Date.now()): DateGroup<T>[] {
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt)
    const nowDate = new Date(now)
    const nowYear = nowDate.getFullYear()
    const nowMonth0 = nowDate.getMonth()

    // year -> month -> day 三级索引（顺序遍历 sorted 保证组内 desc）
    const yearMap = new Map<number, Map<number, Map<number, T[]>>>()
    for (const m of sorted) {
        const d = new Date(m.createdAt)
        const y = d.getFullYear()
        const mo = d.getMonth()
        const da = d.getDate()
        let monthMap = yearMap.get(y)
        if (!monthMap) { monthMap = new Map(); yearMap.set(y, monthMap) }
        let dayMap = monthMap.get(mo)
        if (!dayMap) { dayMap = new Map(); monthMap.set(mo, dayMap) }
        let arr = dayMap.get(da)
        if (!arr) { arr = []; dayMap.set(da, arr) }
        arr.push(m)
    }

    const result: DateGroup<T>[] = []
    const years = [...yearMap.keys()].sort((a, b) => b - a)
    for (const y of years) {
        const monthMap = yearMap.get(y)!
        if (y === nowYear) {
            // 本年：不产生「年」节点，月直接挂顶层（本月再精简为「日」）
            appendMonthGroups(result, monthMap, nowYear, nowMonth0, y)
        } else {
            const yearGroup: DateGroup<T> = {kind: 'year', label: `${y}年`, items: [], children: []}
            appendMonthGroups(yearGroup.children, monthMap, nowYear, nowMonth0, y)
            result.push(yearGroup)
        }
    }
    return result
}

/** 备忘录历史分组：过滤 processed 后调用通用分组 */
export function groupProcessedByDate(list: MemoItem[], now = Date.now()): DateGroup<MemoItem>[] {
    const processed = list.filter(m => m.status !== 'active')
    return groupByDateHierarchy(processed, now)
}

/** 月层级：本月直接铺「日」组到 target，其余月产生「月」节点（倒序） */
function appendMonthGroups<T>(
    target: DateGroup<T>[],
    monthMap: Map<number, Map<number, T[]>>,
    nowYear: number,
    nowMonth0: number,
    year: number,
): void {
    const months = [...monthMap.keys()].sort((a, b) => b - a)
    for (const month0 of months) {
        const dayMap = monthMap.get(month0)!
        if (year === nowYear && month0 === nowMonth0) {
            appendDayGroups(target, dayMap, month0)
        } else {
            const monthGroup: DateGroup<T> = {kind: 'month', label: `${month0 + 1}月`, items: [], children: []}
            appendDayGroups(monthGroup.children, dayMap, month0)
            target.push(monthGroup)
        }
    }
}

/** 日层级：按日倒序产生「日」组（items 已按 desc） */
function appendDayGroups<T>(target: DateGroup<T>[], dayMap: Map<number, T[]>, month0: number): void {
    const days = [...dayMap.keys()].sort((a, b) => b - a)
    for (const day of days) {
        target.push({kind: 'day', label: `${month0 + 1}月${day}日`, items: dayMap.get(day)!, children: []})
    }
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
