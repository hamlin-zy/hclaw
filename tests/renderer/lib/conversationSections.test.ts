import {describe, expect, it} from 'vitest'
import {buildConversationSections} from '../../../src/renderer/lib/conversationSections'

/** 造根会话（createdAt 递增：c-00 最旧） */
function conv(n: number, extra: Partial<any> = {}) {
    return {
        id: `c-${String(n).padStart(2, '0')}`,
        title: `会话 ${n}`,
        preview: '',
        createdAt: 1000 + n,
        updatedAt: 5000 + n,
        ...extra,
    }
}

function project(overrides: Partial<any> = {}) {
    return {
        projectPath: '/ws/a',
        projectName: 'a',
        gitBranch: 'main',
        conversations: [conv(0), conv(1), conv(2)],
        ...overrides,
    }
}

const base = {searchQuery: '', collapsedKeys: [], }

describe('buildConversationSections — 排序与窗口', () => {
    it('置顶优先，其余按 createdAt desc（不是 updatedAt）', () => {
        const pinnedOld = conv(0, {pinned: true, updatedAt: 1})           // createdAt 最旧但置顶
        const newest = conv(1, {updatedAt: 9_999_999})                     // updatedAt 最大但 createdAt 较旧
        const sections = buildConversationSections({
            ...base,
            projects: [project({
                projectPath: '/ws/a', projectName: 'a', gitBranch: null,
                conversations: [conv(2), pinnedOld, newest],
            })],
        })
        expect(sections[0].rows.map(r => r.id)).toEqual(['c-00', 'c-02', 'c-01'])
    })

    it('非置顶超过窗口（默认 10）时被截断，且 hasMore = true', () => {
        const conversations = Array.from({length: 12}, (_, i) => conv(i))
        const sections = buildConversationSections({...base, projects: [project({conversations})]})
        expect(sections[0].rows).toHaveLength(10)
        expect(sections[0].hasMore).toBe(true)
        // 最新 10 条 = c-11 … c-02
        expect(sections[0].rows.map(r => r.id)).toEqual([
            'c-11', 'c-10', 'c-09', 'c-08', 'c-07', 'c-06', 'c-05', 'c-04', 'c-03', 'c-02',
        ])
    })

    it('visibleCount = 20 时「···」再放 10 条（+10 的即时展开语义）', () => {
        const conversations = Array.from({length: 25}, (_, i) => conv(i))
        const sections = buildConversationSections({
            ...base,
            projects: [project({conversations, visibleCount: 20})],
        })
        expect(sections[0].rows).toHaveLength(20)
        expect(sections[0].hasMore).toBe(true)
    })

    it('置顶不参与截断：12 条非置顶 + 3 条置顶 → 13 行，hasMore = true', () => {
        const conversations = [
            conv(0, {pinned: true}), conv(1, {pinned: true}), conv(2, {pinned: true}),
            ...Array.from({length: 12}, (_, i) => conv(10 + i)),
        ]
        const sections = buildConversationSections({...base, projects: [project({conversations})]})
        expect(sections[0].rows).toHaveLength(13)
        expect(sections[0].rows.slice(0, 3).map(r => r.id)).toEqual(['c-02', 'c-01', 'c-00'])
        expect(sections[0].hasMore).toBe(true)
    })

    it('12 条非置顶全置顶时 hasMore = false（一条都不缺）', () => {
        const conversations = Array.from({length: 12}, (_, i) => conv(i, {pinned: true}))
        const sections = buildConversationSections({...base, projects: [project({conversations})]})
        expect(sections[0].rows).toHaveLength(12)
        expect(sections[0].hasMore).toBe(false)
    })
})

describe('buildConversationSections — 父子关系', () => {
    it('子会话紧跟父；父被窗口截断时子一并隐藏', () => {
        const parent = conv(0, {id: 'p-1', createdAt: 1})                  // 最旧 → 会被截断
        const child = conv(1, {id: 'k-1', parentConvId: 'p-1', createdAt: 2})
        const others = Array.from({length: 11}, (_, i) => conv(20 + i))     // 都比 parent 新
        const sections = buildConversationSections({
            ...base,
            projects: [project({conversations: [parent, child, ...others]})],
        })
        expect(sections[0].rows.map(r => r.id)).not.toContain('p-1')
        expect(sections[0].rows.map(r => r.id)).not.toContain('k-1')
    })

    it('父在窗口内时子紧随其后，childCount/indentLevel 正确', () => {
        const parent = conv(30, {id: 'p-1'})
        const child = conv(31, {id: 'k-1', parentConvId: 'p-1'})
        const sections = buildConversationSections({
            ...base,
            projects: [project({conversations: [parent, child]})],
        })
        expect(sections[0].rows.map(r => r.id)).toEqual(['p-1', 'k-1'])
        expect(sections[0].rows[0]).toMatchObject({childCount: 1, indentLevel: 0})
        expect(sections[0].rows[1]).toMatchObject({indentLevel: 1})
    })

    it('父已删除的孤儿子会话按根会话参与窗口计数', () => {
        const orphan = conv(40, {id: 'k-9', parentConvId: 'missing'})
        const sections = buildConversationSections({...base, projects: [project({conversations: [orphan]})]})
        expect(sections[0].rows.map(r => r.id)).toEqual(['k-9'])
    })
})

describe('buildConversationSections — 子会话窗口', () => {
    function parentWithChildren(n: number) {
        const parent = conv(30, {id: 'p-1'})
        const children = Array.from({length: n}, (_, i) => conv(40 + i, {id: `k-${i}`, parentConvId: 'p-1'}))
        return [parent, ...children]
    }

    it('子会话超过 3 条：只显示最新 3 条 + load-more 占位行（hiddenCount 正确）', () => {
        const sections = buildConversationSections({...base, projects: [project({conversations: parentWithChildren(5)})]})
        const rows = sections[0].rows
        expect(rows.map(r => r.kind === 'conv' ? r.id : 'LOAD-MORE')).toEqual([
            'p-1', 'k-4', 'k-3', 'k-2', 'LOAD-MORE',
        ])
        const more = rows[4]
        expect(more).toMatchObject({kind: 'load-more', parentConvId: 'p-1', indentLevel: 1, hiddenCount: 2})
    })

    it('子会话 ≤3 条：全量显示，无 load-more 行', () => {
        const sections = buildConversationSections({...base, projects: [project({conversations: parentWithChildren(3)})]})
        expect(sections[0].rows.every(r => r.kind === 'conv')).toBe(true)
    })

    it('expandedChildParents 命中：全部子会话可见，无 load-more 行', () => {
        const sections = buildConversationSections({
            ...base,
            expandedChildParents: {'p-1': true},
            projects: [project({conversations: parentWithChildren(5)})],
        })
        const ids = sections[0].rows.filter(r => r.kind === 'conv').map(r => r.id)
        expect(ids).toEqual(['p-1', 'k-4', 'k-3', 'k-2', 'k-1', 'k-0'])
        expect(sections[0].rows.some(r => r.kind === 'load-more')).toBe(false)
    })

    it('搜索态豁免子会话窗口（全部可见）', () => {
        const sections = buildConversationSections({
            ...base,
            searchQuery: '会话',
            projects: [project({conversations: parentWithChildren(5)})],
        })
        expect(sections[0].rows.filter(r => r.kind === 'conv')).toHaveLength(6)
        expect(sections[0].rows.some(r => r.kind === 'load-more')).toBe(false)
    })
})

describe('buildConversationSections — 搜索与折叠', () => {
    it('搜索命中忽略窗口（旧会话也出现）', () => {
        const conversations = [
            conv(0, {title: '目标会话'}),
            ...Array.from({length: 11}, (_, i) => conv(10 + i)),
        ]
        const sections = buildConversationSections({
            ...base,
            searchQuery: '目标',
            projects: [project({conversations})],
        })
        expect(sections[0].rows.map(r => r.id)).toContain('c-00')
    })

    it('折叠段：rows 为空，count = 项目下全量会话数（不受窗口截断影响），hasMore 照算', () => {
        const conversations = [
            conv(0, {pinned: true}),
            ...Array.from({length: 12}, (_, i) => conv(10 + i)),
        ]
        const sections = buildConversationSections({
            ...base,
            collapsedKeys: ['/ws/a'],
            projects: [project({conversations})],
        })
        expect(sections[0].collapsed).toBe(true)
        expect(sections[0].rows).toEqual([])
        expect(sections[0].count).toBe(13) // DB 总数 = 1 置顶 + 12 非置顶（非窗口内可见数 11）
        expect(sections[0].hasMore).toBe(true)
    })

    it('count 含子会话：父 + 1 子 → count 2（rows 展开后同为 2 行）', () => {
        const parent = conv(0)
        const child = {...conv(1), parentConvId: parent.id}
        const sections = buildConversationSections({
            ...base,
            collapsedKeys: ['/ws/a'],
            projects: [project({conversations: [parent, child]})],
        })
        expect(sections[0].collapsed).toBe(true)
        expect(sections[0].count).toBe(2)
    })

    it('搜索有命中时强制展开该段（忽略 collapsedKeys）', () => {
        const sections = buildConversationSections({
            ...base,
            searchQuery: '会话 1',
            collapsedKeys: ['/ws/a'],
            projects: [project()],
        })
        expect(sections[0].collapsed).toBe(false)
        expect(sections[0].rows.length).toBeGreaterThan(0)
    })

    it('搜索无命中时该段保持折叠（不因搜索而展开）', () => {
        const sections = buildConversationSections({
            ...base,
            searchQuery: '不存在的词',
            collapsedKeys: ['/ws/a'],
            projects: [project()],
        })
        expect(sections[0].collapsed).toBe(true)
        expect(sections[0].rows).toEqual([])
    })

    // ★ Task 13 I-3：只有子会话命中时，祖先根会话一并视为命中 → 段 rows 能带出命中的子会话
    it('只命中子会话时，其祖先根会话一并可见（子会话出现在 rows）', () => {
        const root = conv(0, {id: 'p-1', title: '父会话'})
        const child = conv(1, {id: 'k-1', parentConvId: 'p-1', title: '独特关键词子会话'})
        const sections = buildConversationSections({
            ...base,
            searchQuery: '独特关键词',
            projects: [project({conversations: [root, child]})],
        })
        expect(sections[0].collapsed).toBe(false)
        expect(sections[0].rows.map(r => r.id)).toEqual(['p-1', 'k-1'])
    })

    it('折叠某段不影响其他段', () => {
        const sections = buildConversationSections({
            ...base,
            collapsedKeys: ['/ws/a'],
            projects: [
                project({projectPath: '/ws/a', projectName: 'a'}),
                project({projectPath: '/ws/b', projectName: 'b'}),
            ],
        })
        expect(sections.map(s => s.collapsed)).toEqual([true, false])
        expect(sections[1].rows.length).toBe(3)
    })

    it('单项目视图：singleProject = true → 折叠不生效（无 chevron）', () => {
        const sections = buildConversationSections({
            ...base,
            singleProject: true,
            collapsedKeys: ['/ws/a'],
            projects: [project()],
        })
        expect(sections[0].collapsed).toBe(false)
        expect(sections[0].rows).toHaveLength(3)
    })
})

describe('buildConversationSections — 分段顺序与段字段', () => {
    it('段顺序 = 入参顺序（组视图按 group_order，由调用方排序）', () => {
        const sections = buildConversationSections({
            ...base,
            projects: [
                project({projectPath: '/ws/b', projectName: 'b'}),
                project({projectPath: '/ws/a', projectName: 'a'}),
            ],
        })
        expect(sections.map(s => s.key)).toEqual(['/ws/b', '/ws/a'])
    })

    it('空项目段 rows 为空、count 0、hasMore false（渲染「暂无会话」）', () => {
        const sections = buildConversationSections({
            ...base,
            projects: [project({conversations: []})],
        })
        expect(sections[0]).toMatchObject({rows: [], count: 0, hasMore: false})
    })

    it('分支徽章字段透传（组视图段头用）', () => {
        const sections = buildConversationSections({
            ...base,
            projects: [project({gitBranch: 'feat/project-group-management'})],
        })
        expect(sections[0].gitBranch).toBe('feat/project-group-management')
    })
})
