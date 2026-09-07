// @vitest-environment jsdom
/**
 * memoSort 纯函数测试：排序规则、历史分组、拖拽约束、重编号边界
 *
 * - 待办（active）：pinned 优先 → sortIndex desc → createdAt asc
 * - 历史（processed）：按创建日期层级分组（本月→日；本年→月→日；往年→年→月→日），
 *   组间倒序、组内 createdAt desc
 */
import {describe, it, expect} from 'vitest'
import {sortActiveMemos, groupProcessedByDate, reorderGroup, renumberGroup} from '@/renderer/components/memo/memoSort'
import type {ProcessedDateGroup} from '@/renderer/components/memo/memoSort'
import type {MemoItem} from '@/shared/types/memo'

const P = 'E:\\proj'
let seq = 0
const item = (over: Partial<MemoItem> = {}): MemoItem => ({
    id: `m${++seq}`,
    workspacePath: P,
    content: 'c',
    title: 't',
    createdAt: 1000,
    updatedAt: 1000,
    attachments: [],
    status: 'active',
    ...over,
})

/** 本地时间构造（避免 UTC 时区偏移干扰分组判定） */
const d = (y: number, mo: number, da: number, h = 12) => new Date(y, mo, da, h).getTime()
/** 测试基准「当前时间」：2026-08-25（本月 = 2026年8月） */
const NOW = new Date(2026, 7, 25).getTime()

/** 已办项构造 */
const processed = (createdAt: number, id?: string): MemoItem =>
    item({id, createdAt, status: 'processed'})

describe('sortActiveMemos 待办排序规则', () => {
    it('仅返回 active，过滤 processed', () => {
        const a = item({id: 'a'})
        const b = item({id: 'b', status: 'processed'})
        expect(sortActiveMemos([b, a]).map(m => m.id)).toEqual(['a'])
    })

    it('组内 pinned 优先', () => {
        const a = item({id: 'a', createdAt: 3})
        const b = item({id: 'b', createdAt: 1, pinned: true})
        const c = item({id: 'c', createdAt: 2})
        expect(sortActiveMemos([c, a, b]).map(m => m.id)).toEqual(['b', 'c', 'a'])
    })

    it('组内 sortIndex desc，相同按 createdAt asc', () => {
        const a = item({id: 'a', sortIndex: 5, createdAt: 9})
        const b = item({id: 'b', sortIndex: 5, createdAt: 1})
        const c = item({id: 'c', sortIndex: 1, createdAt: 2})
        expect(sortActiveMemos([c, b, a]).map(m => m.id)).toEqual(['b', 'a', 'c'])
    })

    it('pinned 相同、sortIndex 相同 → createdAt asc', () => {
        const a = item({id: 'a', createdAt: 2, pinned: true})
        const b = item({id: 'b', createdAt: 1, pinned: true})
        expect(sortActiveMemos([a, b]).map(m => m.id)).toEqual(['b', 'a'])
    })

    it('存量数据无 pinned/sortIndex（undefined）按默认值参与排序', () => {
        const a = item({id: 'a', createdAt: 1})
        const b = item({id: 'b', createdAt: 2}) as MemoItem
        delete (b as Partial<MemoItem>).sortIndex
        expect(sortActiveMemos([b, a]).map(m => m.id)).toEqual(['a', 'b'])
    })

    it('不修改原数组', () => {
        const src = [item({id: 'a', createdAt: 2}), item({id: 'b', createdAt: 1})]
        sortActiveMemos(src)
        expect(src.map(m => m.id)).toEqual(['a', 'b'])
    })
})

/** 前序遍历分组树，返回 [kind:label] 序列便于断言结构 */
function labels(groups: ProcessedDateGroup[]): string[] {
    const out: string[] = []
    const walk = (gs: ProcessedDateGroup[]) => {
        for (const g of gs) {
            out.push(`${g.kind}:${g.label}`)
            if (g.children.length) walk(g.children)
        }
    }
    walk(groups)
    return out
}

describe('groupProcessedByDate 历史分组', () => {
    it('仅处理 processed，过滤 active', () => {
        const groups = groupProcessedByDate([
            processed(d(2026, 7, 25), 'p1'),
            item({id: 'a1', createdAt: d(2026, 7, 24)}),
        ], NOW)
        expect(groups).toHaveLength(1)
        expect(groups[0].items.map(m => m.id)).toEqual(['p1'])
    })

    it('本月 → 顶层「日」组，组间按日期倒序、组内按 createdAt desc', () => {
        const groups = groupProcessedByDate([
            processed(d(2026, 7, 20, 8), 'early'),
            processed(d(2026, 7, 25, 9), 'latest'),
            processed(d(2026, 7, 25, 10), 'same-day-later'),
        ], NOW)
        expect(labels(groups)).toEqual(['day:8月25日', 'day:8月20日'])
        // 8月25日 组内按 createdAt desc：later 在前
        expect(groups[0].items.map(m => m.id)).toEqual(['same-day-later', 'latest'])
        expect(groups[1].items.map(m => m.id)).toEqual(['early'])
    })

    it('本年非本月 → 顶层「月」组 +「日」子组', () => {
        const groups = groupProcessedByDate([
            processed(d(2026, 6, 31), 'jul31'),
            processed(d(2026, 6, 29), 'jul29'),
            processed(d(2026, 5, 10), 'jun10'),
        ], NOW)
        expect(labels(groups)).toEqual([
            'month:7月', 'day:7月31日', 'day:7月29日',
            'month:6月', 'day:6月10日',
        ])
    })

    it('往年 → 顶层「年」组 +「月」子组 +「日」孙组', () => {
        const groups = groupProcessedByDate([
            processed(d(2025, 5, 20), 'jun20'),
            processed(d(2025, 4, 15), 'may15'),
        ], NOW)
        expect(labels(groups)).toEqual([
            'year:2025年',
            'month:6月', 'day:6月20日',
            'month:5月', 'day:5月15日',
        ])
    })

    it('完整示例：本月/本年/往年混合，层级与顺序正确（spec 样例）', () => {
        const groups = groupProcessedByDate([
            processed(d(2026, 7, 25), 'aug25'),
            processed(d(2026, 6, 31), 'jul31'),
            processed(d(2026, 6, 29), 'jul29'),
            processed(d(2026, 6, 10), 'jul10'),
            processed(d(2026, 5, 30), 'jun30'),
            processed(d(2026, 5, 29), 'jun29'),
            processed(d(2026, 5, 10), 'jun10'),
            processed(d(2025, 7, 15), 'y25-aug'),
            processed(d(2025, 5, 30), 'y25-jun30'),
            processed(d(2025, 5, 29), 'y25-jun29'),
            processed(d(2025, 5, 10), 'y25-jun10'),
            processed(d(2025, 4, 20), 'y25-may'),
        ], NOW)
        expect(labels(groups)).toEqual([
            'day:8月25日',
            'month:7月', 'day:7月31日', 'day:7月29日', 'day:7月10日',
            'month:6月', 'day:6月30日', 'day:6月29日', 'day:6月10日',
            'year:2025年',
            'month:8月', 'day:8月15日',
            'month:6月', 'day:6月30日', 'day:6月29日', 'day:6月10日',
            'month:5月', 'day:5月20日',
        ])
    })

    it('跨年月份排序：2025年 内月组倒序（8月 > 6月 > 5月）', () => {
        const groups = groupProcessedByDate([
            processed(d(2025, 4, 1), 'may'),
            processed(d(2025, 5, 1), 'jun'),
            processed(d(2025, 7, 1), 'aug'),
        ], NOW)
        const year = groups[0]
        expect(year.kind).toBe('year')
        expect(year.children.map(c => c.label)).toEqual(['8月', '6月', '5月'])
    })

    it('空列表 / 无 processed → 返回空数组', () => {
        expect(groupProcessedByDate([], NOW)).toEqual([])
        expect(groupProcessedByDate([item({id: 'a'})], NOW)).toEqual([])
    })

    it('now 注入生效：切换「本月」基准后，上月数据升为「日」组', () => {
        // 同一批数据（7月25日），在「当前=8月」时是「月→日」，在「当前=7月」时是「日」
        const data = [processed(d(2026, 6, 25), 'x')]
        const asAug = groupProcessedByDate(data, new Date(2026, 7, 1).getTime())
        const asJul = groupProcessedByDate(data, new Date(2026, 6, 20).getTime())
        expect(labels(asAug)).toEqual(['month:7月', 'day:7月25日'])
        expect(labels(asJul)).toEqual(['day:7月25日'])
    })
})

describe('reorderGroup 拖拽约束', () => {
    it('置顶项之间拖动：顺序保持，置顶仍居前', () => {
        const a = item({id: 'a', pinned: true})
        const b = item({id: 'b', pinned: true})
        const c = item({id: 'c', pinned: true})
        const r = reorderGroup([a, b, c], 'c', 0)
        expect(r!.map(m => m.id)).toEqual(['c', 'a', 'b'])
    })

    it('未置顶项之间拖动：正常重排', () => {
        const a = item({id: 'a'})
        const b = item({id: 'b'})
        const c = item({id: 'c'})
        expect(reorderGroup([a, b, c], 'a', 3)!.map(m => m.id)).toEqual(['b', 'c', 'a'])
        expect(reorderGroup([a, b, c], 'c', 0)!.map(m => m.id)).toEqual(['c', 'a', 'b'])
    })

    it('未置顶项拖到置顶项上方（插入置顶区中间）→ 返回 null 拒绝', () => {
        const p1 = item({id: 'p1', pinned: true})
        const p2 = item({id: 'p2', pinned: true})
        const u = item({id: 'u'})
        expect(reorderGroup([p1, p2, u], 'u', 1)).toBeNull()
        expect(reorderGroup([p1, p2, u], 'u', 0)).toBeNull()
    })

    it('未置顶项拖到置顶项之后（未置顶区内）→ 允许', () => {
        const p1 = item({id: 'p1', pinned: true})
        const u1 = item({id: 'u1'})
        const u2 = item({id: 'u2'})
        expect(reorderGroup([p1, u1, u2], 'u2', 1)!.map(m => m.id)).toEqual(['p1', 'u2', 'u1'])
    })

    it('全未置顶组：任意重排允许', () => {
        const a = item({id: 'a'})
        const b = item({id: 'b'})
        expect(reorderGroup([a, b], 'b', 0)!.map(m => m.id)).toEqual(['b', 'a'])
    })

    it('非法输入：目标索引越界 / dragId 不存在 → null', () => {
        const a = item({id: 'a'})
        expect(reorderGroup([a], 'a', 5)).toBeNull()
        expect(reorderGroup([a], 'ghost', 0)).toBeNull()
        expect(reorderGroup([a], 'a', -1)).toBeNull()
    })

    it('重排不修改原数组', () => {
        const a = item({id: 'a'})
        const b = item({id: 'b'})
        reorderGroup([a, b], 'b', 0)
        expect([a.id, b.id]).toEqual(['a', 'b'])
    })
})

describe('renumberGroup 重编号', () => {
    it('按数组顺序倒序编号 n..1（第 1 项最大，与 sortIndex desc 比较器同向）', () => {
        const a = item({id: 'a', sortIndex: 99})
        const b = item({id: 'b', sortIndex: 0})
        expect(renumberGroup([a, b, item({id: 'c'})])).toEqual([
            {id: 'a', sortIndex: 3},
            {id: 'b', sortIndex: 2},
            {id: 'c', sortIndex: 1},
        ])
    })

    it('单元素组 → [{id, sortIndex: 1}]', () => {
        expect(renumberGroup([item({id: 'a'})])).toEqual([{id: 'a', sortIndex: 1}])
    })

    it('拖拽到首位后重编号 + 排序，显示顺序与拖拽结果一致（回归：此前反向导致拖顶沉底）', () => {
        const a = item({id: 'a'})
        const b = item({id: 'b'})
        const c = item({id: 'c'})
        const reordered = reorderGroup([a, b, c], 'b', 0)!
        const renumbered = renumberGroup(reordered)
        const map = new Map(renumbered.map(r => [r.id, r.sortIndex]))
        const sorted = sortActiveMemos(reordered).map(m => m.id)
        expect(sorted).toEqual(['b', 'a', 'c'])
        expect(map.get('b')).toBe(3)
    })
})
