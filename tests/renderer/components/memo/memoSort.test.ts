// @vitest-environment jsdom
/**
 * memoSort 纯函数测试：排序规则、拖拽约束、重编号边界
 *
 * 排序规则（spec）：未处理分组在前 → 组内 pinned 优先 → sortIndex desc → createdAt asc
 */
import {describe, it, expect} from 'vitest'
import {sortMemos, reorderGroup, renumberGroup} from '@/renderer/components/memo/memoSort'
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

describe('sortMemos 排序规则', () => {
    it('未处理分组在前，组内 pinned 优先', () => {
        const a = item({id: 'a', createdAt: 3})
        const b = item({id: 'b', createdAt: 1, pinned: true})
        const c = item({id: 'c', createdAt: 2, status: 'processed', pinned: true})
        expect(sortMemos([c, a, b]).map(m => m.id)).toEqual(['b', 'a', 'c'])
    })

    it('组内 sortIndex desc，相同按 createdAt asc', () => {
        const a = item({id: 'a', sortIndex: 5, createdAt: 9})
        const b = item({id: 'b', sortIndex: 5, createdAt: 1})
        const c = item({id: 'c', sortIndex: 1, createdAt: 2})
        expect(sortMemos([c, b, a]).map(m => m.id)).toEqual(['b', 'a', 'c'])
    })

    it('pinned 相同、sortIndex 相同 → createdAt asc', () => {
        const a = item({id: 'a', createdAt: 2, pinned: true})
        const b = item({id: 'b', createdAt: 1, pinned: true})
        expect(sortMemos([a, b]).map(m => m.id)).toEqual(['b', 'a'])
    })

    it('存量数据无 pinned/sortIndex（undefined）按默认值参与排序', () => {
        const a = item({id: 'a', createdAt: 1})
        const b = item({id: 'b', createdAt: 2}) as MemoItem
        delete (b as Partial<MemoItem>).sortIndex
        expect(sortMemos([b, a]).map(m => m.id)).toEqual(['a', 'b'])
    })

    it('processed 组内 pinned 项也排在 processed 未置顶前（组间不跨）', () => {
        const p1 = item({id: 'p1', status: 'processed', pinned: true, createdAt: 9})
        const p2 = item({id: 'p2', status: 'processed', createdAt: 1})
        expect(sortMemos([p2, p1]).map(m => m.id)).toEqual(['p1', 'p2'])
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
        // 插入两个置顶项之间
        expect(reorderGroup([p1, p2, u], 'u', 1)).toBeNull()
        // 插到置顶区最前
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
        // 拖第二项 b 到首位
        const reordered = reorderGroup([a, b, c], 'b', 0)!
        const renumbered = renumberGroup(reordered)
        const map = new Map(renumbered.map(r => [r.id, r.sortIndex]))
        const sorted = sortMemos(reordered).map(m => m.id)
        expect(sorted).toEqual(['b', 'a', 'c'])
        expect(map.get('b')).toBe(3) // 首位拿最大 sortIndex
    })
})
