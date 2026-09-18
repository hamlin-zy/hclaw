// @vitest-environment jsdom
import {afterEach, describe, expect, it} from 'vitest'
import {collectDropZones, isClickGesture, resolveDropTarget} from '../../../src/renderer/lib/pointerDrag'

describe('isClickGesture — 阈值 4px / 300ms', () => {
    // 说明：原简报该用例给的是 (3, 3, 200)，与下方 (3, 3, 10) 自相矛盾
    // （同一位移只差时长不可能得出相反结论）。按控制器裁定只改输入为 (2, 2, 200)，
    // 保留"小位移 + 短时长 = 点击"这一用例主旨，其余用例逐字不动。
    it('位移 2px 且 200ms → 点击', () => {
        expect(isClickGesture(2, 2, 200)).toBe(true) // √8 ≈ 2.83 < 4，200 < 300
    })
    it('位移 5px → 拖拽（即使很快）', () => {
        expect(isClickGesture(5, 0, 50)).toBe(false)
    })
    it('时长 350ms → 拖拽（即使没动）', () => {
        expect(isClickGesture(0, 0, 350)).toBe(false)
    })
    it('边界值 4px / 300ms 视为拖拽（开区间）', () => {
        expect(isClickGesture(4, 0, 10)).toBe(false)
        expect(isClickGesture(0, 0, 300)).toBe(false)
    })
    it('斜向位移按欧氏距离判定', () => {
        expect(isClickGesture(3, 3, 10)).toBe(false) // √18 ≈ 4.24
    })
})

describe('resolveDropTarget — 落点解析', () => {
    const zones = [
        {rect: {top: 0, bottom: 40, left: 0, right: 300}, target: {kind: 'group' as const, groupId: 'pg-a'}},
        {rect: {top: 40, bottom: 80, left: 0, right: 300}, target: {kind: 'top-level' as const, index: 0}},
    ]
    it('命中组头区域返回组落点', () => {
        expect(resolveDropTarget({x: 100, y: 20}, zones)).toEqual({kind: 'group', groupId: 'pg-a'})
    })
    it('命中顶层区返回插入 index', () => {
        expect(resolveDropTarget({x: 100, y: 60}, zones)).toEqual({kind: 'top-level', index: 0})
    })
    it('落在所有区域之外返回 null', () => {
        expect(resolveDropTarget({x: 100, y: 999}, zones)).toBeNull()
    })
})

/**
 * 兜底落点的启用条件（jsdom）。
 *
 * 必须显式造矩形：jsdom 无布局引擎，`getBoundingClientRect()` 全零，而兜底分支自带
 * `container.width/height > 0` 前置条件 —— 不造矩形的话用例会因"根本没走到兜底"而假通过
 * （这正是"面板根误入兜底"在 jsdom 里漏测的原因：面板根零宽，兜底被前置条件挡在门外）。
 * 几何用 `data-rect="top,bottom,left,right"` 就地声明，不依赖任何真实布局。
 */
describe('collectDropZones — 空态兜底的启用条件（根内要有组块）', () => {
    function rectOf(spec: string): DOMRect {
        const [top, bottom, left, right] = spec.split(',').map(Number)
        const box = {top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top}
        return {...box, toJSON: () => box} as unknown as DOMRect
    }

    /** 造一个根：`containerRect` 是根的矩形，`inner` 里每个元素自带 data-rect */
    function mount(containerRect: string, inner: string): HTMLElement {
        const root = document.createElement('div')
        root.setAttribute('data-rect', containerRect)
        root.innerHTML = inner
        for (const el of [root, ...root.querySelectorAll<HTMLElement>('[data-rect]')]) {
            el.getBoundingClientRect = () => rectOf(el.getAttribute('data-rect') as string)
        }
        document.body.appendChild(root)
        return root
    }

    afterEach(() => {
        document.body.innerHTML = ''
    })

    it('面板根（只有成员行、没有组块）不产生 top-level 兜底：拖到面板头行 = 无落点', () => {
        const root = mount('0,300,300,570', [
            '<div data-drag-row="member" data-group-id="pg-a" data-index="0" data-rect="40,80,300,570"></div>',
            '<div data-drag-row="member" data-group-id="pg-a" data-index="1" data-rect="80,120,300,570"></div>',
        ].join(''))
        const zones = collectDropZones(root)
        expect(zones).toHaveLength(4) // 2 行 × 上下半区：成员行确实采到了（不是空表导致的假通过）
        expect(zones.some((z) => z.target.kind === 'top-level')).toBe(false)
        // 面板头行（第一个成员行之上）曾是兜底落点 → 成员拖到那里会被 assign(path, null) 静默移出组
        expect(resolveDropTarget({x: 450, y: 20}, zones)).toBeNull()
        // 行落点本身不受影响
        expect(resolveDropTarget({x: 450, y: 60}, zones)).toEqual({kind: 'group-member', groupId: 'pg-a', index: 0})
    })

    it('根内有组块且无 top 行 → 兜底仍在（既有行为不回退）', () => {
        const root = mount('0,320,0,300', [
            '<div data-drag-group-block="pg-a" data-rect="0,40,0,300">',
            '<div data-drag-row="group" data-group-id="pg-a" data-rect="0,40,0,300"></div>',
            '</div>',
        ].join(''))
        const zones = collectDropZones(root)
        // 组块之下那片空白 = 空态下的顶层项目区（§6.3 第 3 行「组内项目 → 顶层区」的落点）
        expect(resolveDropTarget({x: 100, y: 200}, zones)).toEqual({kind: 'top-level', index: 0})
        // 组头自身仍是组落点（兜底不抢行落点）
        expect(resolveDropTarget({x: 100, y: 20}, zones)).toEqual({kind: 'group', groupId: 'pg-a'})
    })

    it('根内既无组块也无 top 行（空根）→ 不产生兜底', () => {
        expect(collectDropZones(mount('0,320,0,300', ''))).toEqual([])
    })
})
