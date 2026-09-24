/** 窗口截断豁免（spec §5.2.4 / V11 / F16） */
import {describe, it, expect} from 'vitest'
import {buildConversationSections} from '../../../src/renderer/lib/conversationSections'

const mk = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
    id, title: id, preview: '', createdAt, updatedAt: createdAt, status: 'active', pinned: false, ...extra,
})

describe('窗口截断豁免', () => {
    const convs = [mk('c1', 900), mk('c2', 800), mk('c3', 700)]
    const build = (activeConversationId?: string, list = convs, visibleCount = 2) => buildConversationSections({
        projects: [{projectPath: '/ws/a', projectName: 'a', gitBranch: null, conversations: list as never, visibleCount}],
        searchQuery: '', collapsedKeys: [], activeConversationId,
    })[0]

    it('被窗口截掉的激活会话仍渲染，且保持原排序位置', () => {
        expect(build().rows.map(r => r.id)).toEqual(['c1', 'c2'])
        expect(build('c3').rows.map(r => r.id)).toEqual(['c1', 'c2', 'c3'])
    })

    it('豁免不减少「还有更多」的判断基数', () => {
        expect(build('c3').hasMore).toBe(true)
    })

    it('激活的是子会话且父被截断时，父行与激活子行同时可见', () => {
        const withChild = [...convs, mk('k1', 600, {parentConvId: 'c3'})]
        expect(build('k1', withChild).rows.map(r => r.id)).toContain('c3')
    })

    it('搜索态下豁免不改变结果（搜索本就忽略窗口）', () => {
        const s = buildConversationSections({
            projects: [{projectPath: '/ws/a', projectName: 'a', gitBranch: null, conversations: convs as never, visibleCount: 2}],
            searchQuery: 'c', collapsedKeys: [], activeConversationId: 'c3',
        })[0]
        expect(s.rows.map(r => r.id)).toEqual(['c1', 'c2', 'c3'])
    })

    it('激活的子会话排在子窗口（3 条）之外时仍可见，且回到原排序位置', () => {
        const parent = mk('p1', 900)
        const kids = [
            mk('k1', 100, {parentConvId: 'p1'}), mk('k2', 200, {parentConvId: 'p1'}),
            mk('k3', 300, {parentConvId: 'p1'}), mk('k4', 400, {parentConvId: 'p1'}),
        ]
        const list = [parent, ...kids]
        const convIds = (id?: string) => build(id, list).rows.filter(r => r.kind === 'conv').map(r => r.id)
        expect(convIds()).toEqual(['p1', 'k4', 'k3', 'k2'])
        // 默认子窗口 3 条 → childShownCount = 3
        expect(build(undefined, list).rows[0]).toMatchObject({childShownCount: 3})
        expect(convIds('k1')).toEqual(['p1', 'k4', 'k3', 'k2', 'k1'])
        // 4 条子会话全部可见（豁免追加）→ childShownCount = 4
        expect(build('k1', list).rows[0]).toMatchObject({childShownCount: 4})
    })

    it('深度 ≥2：祖父被根窗口截断、中间层与孙分别被子窗口截断时，祖先链每一环与激活孙行仍可见', () => {
        // 根窗口 = 1 → g（根）被截；子窗口 = 3 → m 是 g 的第 4 个孩子（被截）、
        // s 是 m 的第 4 个孩子（被截）。无豁免时 g/m/s 全不可见（先自证截断成立）。
        const deep = [
            mk('r1', 900),
            mk('g', 800),
            mk('gx1', 790, {parentConvId: 'g'}), mk('gx2', 780, {parentConvId: 'g'}),
            mk('gx3', 770, {parentConvId: 'g'}), mk('m', 700, {parentConvId: 'g'}),
            mk('mx1', 690, {parentConvId: 'm'}), mk('mx2', 680, {parentConvId: 'm'}),
            mk('mx3', 670, {parentConvId: 'm'}), mk('s', 600, {parentConvId: 'm'}),
        ]
        const convIds = (id?: string, vc = 1) =>
            build(id, deep, vc).rows.filter(r => r.kind === 'conv').map(r => r.id)
        expect(convIds()).toEqual(['r1'])
        const rows = convIds('s')
        expect(rows).toContain('g')
        expect(rows).toContain('m')
        expect(rows).toContain('s')
        expect(rows.indexOf('g')).toBeLessThan(rows.indexOf('m'))
        expect(rows.indexOf('m')).toBeLessThan(rows.indexOf('s'))
    })

    it('V11 完整形态：父行被根窗口截断且中间层与激活子行被子窗口截断时同时渲染', () => {
        // 根窗口 = 2 → g（根）被截；g 有 4 个孩子 → m（激活孙的父）被子窗口截；
        // m 有 4 个孩子 → s（激活孙）被子窗口截。
        const list = [
            mk('r1', 950), mk('r2', 940), mk('g', 930),
            mk('gx1', 928, {parentConvId: 'g'}), mk('gx2', 927, {parentConvId: 'g'}),
            mk('gx3', 926, {parentConvId: 'g'}), mk('m', 920, {parentConvId: 'g'}),
            mk('mx1', 918, {parentConvId: 'm'}), mk('mx2', 917, {parentConvId: 'm'}),
            mk('mx3', 916, {parentConvId: 'm'}), mk('s', 910, {parentConvId: 'm'}),
        ]
        const rows = build('s', list, 2).rows.filter(r => r.kind === 'conv').map(r => r.id)
        expect(rows).toContain('g')
        expect(rows).toContain('m')
        expect(rows).toContain('s')
    })
})
