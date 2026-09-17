// Find in Files 的纯逻辑（工单 05）：命中项映射、每文件折叠、触底 armed / re-arm 互斥。
//
// 只断言输入 → 输出（spec §Testing Decisions）；真实 rg 子进程行为由主进程侧测试覆盖，
// 这里不碰。
import {describe, it, expect} from 'vitest'
import type {FindInFilesMatch} from '../../../src/shared/types/project-manager'
import {
    FIND_PER_FILE_LIMIT,
    FIND_SCROLL_THRESHOLD,
    findMatchToItem,
    foldFindItems,
    foldRowText,
    isNearBottom,
    resolveScrollLoad,
} from '../../../src/renderer/project-manager/lib/findInFiles'

const match = (path: string, line: number, extra: Partial<FindInFilesMatch> = {}): FindInFilesMatch =>
    ({path, line, text: `line ${line}`, matchStart: 0, matchEnd: 4, ...extra})

describe('命中项 → 列表条目', () => {
    it('行号与行文本一并带出；区间是行内区间（不用于路径高亮）', () => {
        expect(findMatchToItem(match('src/a.ts', 12, {matchStart: 3, matchEnd: 6}))).toEqual({
            path: 'src/a.ts',
            matchStart: 3,
            matchEnd: 6,
            line: 12,
            matchText: 'line 12',
        })
    })
})

describe('每文件折叠（阈值 10）', () => {
    it('恰好 10 个命中不折叠', () => {
        const list = Array.from({length: FIND_PER_FILE_LIMIT}, (_, i) => match('a.ts', i + 1))
        const {items, folds} = foldFindItems(list)
        expect(items).toHaveLength(FIND_PER_FILE_LIMIT)
        expect(folds.size).toBe(0)
    })

    it('12 个命中：展开 10 个，其余折叠为「还有 2 处」', () => {
        const list = Array.from({length: 12}, (_, i) => match('a.ts', i + 1))
        const {items, folds} = foldFindItems(list)
        expect(items).toHaveLength(FIND_PER_FILE_LIMIT)
        expect(items.map(i => i.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        expect(folds.get('a.ts')).toBe(2)
        expect(foldRowText(folds.get('a.ts')!)).toBe('还有 2 处')
    })

    it('折叠按文件分别计算，且保留原有顺序', () => {
        const list = [
            match('a.ts', 1),
            match('b.ts', 2),
            ...Array.from({length: 11}, (_, i) => match('a.ts', i + 3)),
            match('b.ts', 99),
        ]
        const {items, folds} = foldFindItems(list)
        expect(folds.get('a.ts')).toBe(2)   // 12 个命中 → 藏 2 个
        expect(folds.get('b.ts')).toBeUndefined()   // 只有 2 个命中
        expect(items.map(i => `${i.path}:${i.line}`)).toEqual([
            'a.ts:1',
            'b.ts:2',
            ...Array.from({length: 9}, (_, i) => `a.ts:${i + 3}`),   // a.ts 累计 12 个 → 只展开 10 个
            'b.ts:99',
        ])
    })

    it('空命中项 → 空列表、无折叠', () => {
        expect(foldFindItems([])).toEqual({items: [], folds: new Map()})
    })
})

describe('触底判定与 armed / re-arm 互斥', () => {
    const near = {scrollTop: 900, scrollHeight: 1300, clientHeight: 400}   // 距底 0
    const away = {scrollTop: 0, scrollHeight: 1300, clientHeight: 400}     // 距底 900

    it('距底 ≤ 阈值算触底，离开阈值不算', () => {
        expect(isNearBottom(near)).toBe(true)
        expect(isNearBottom(away)).toBe(false)
        expect(isNearBottom({scrollTop: 1300 - 400 - FIND_SCROLL_THRESHOLD, scrollHeight: 1300, clientHeight: 400})).toBe(true)
        expect(isNearBottom({scrollTop: 1300 - 400 - FIND_SCROLL_THRESHOLD - 1, scrollHeight: 1300, clientHeight: 400})).toBe(false)
    })

    it('已武装 + 触底 + 可加载 → 加载一页并解除武装', () => {
        expect(resolveScrollLoad(true, true, true)).toEqual({armed: false, load: true})
    })

    it('解除武装后仍在底部：不再重复触发（滚动锚定不会连环翻页）', () => {
        expect(resolveScrollLoad(false, true, true)).toEqual({armed: false, load: false})
    })

    it('离开底部阈值区间即重新武装', () => {
        expect(resolveScrollLoad(false, false, true)).toEqual({armed: true, load: false})
    })

    it('不可加载（在途 / 已结束 / 已截断）时不消耗武装状态', () => {
        expect(resolveScrollLoad(true, true, false)).toEqual({armed: true, load: false})
    })

    it('「离开 → 回到底部」的完整序列：一次底部停留只加载一页', () => {
        let armed = true
        const calls: boolean[] = []
        for (const metrics of [near, near, away, near]) {
            const d = resolveScrollLoad(armed, isNearBottom(metrics), true)
            armed = d.armed
            calls.push(d.load)
        }
        expect(calls).toEqual([true, false, false, true])
    })
})
