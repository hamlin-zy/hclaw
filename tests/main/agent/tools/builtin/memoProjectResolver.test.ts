/**
 * memoProjectResolver — 项目清单收集与目标项目解析纯函数
 *
 * 覆盖：分组顺序/未分组兜底、__unassigned__ 剔除、name 回退 basename、
 * 组+项目精确匹配、全局匹配的 0/1/N 命中三种结果、格式化成文本。
 */
import {describe, it, expect} from 'vitest'
import {collectProjectEntries, resolveTargetPath, formatProjectsText} from '../../../../../src/main/agent/tools/builtin/memoProjectResolver'
import type {ProjectGroupWithMembers} from '@shared/types/projectGroup'

const WS = [
    {path: 'E:\\a\\hclaw', name: 'hclaw'},
    {path: 'E:\\b\\mcp', name: 'nuphus-mcp'},
    {path: 'D:\\Downloads', name: 'Downloads'},
    {path: '__unassigned__', name: '__unassigned__'},
]
const G = (id: string, name: string, sortOrder: number, paths: string[]): ProjectGroupWithMembers => ({
    id, name, sortOrder, createdAt: 0, updatedAt: 0,
    members: paths.map((p, i) => ({projectPath: p, groupOrder: i})),
})
const GROUPS = [G('g1', '常用', 0, ['E:\\a\\hclaw']), G('g2', '我的MCP', 1, ['E:\\b\\mcp'])]

describe('collectProjectEntries', () => {
    it('排除 __unassigned__，补齐组名，未分组排最后', () => {
        const entries = collectProjectEntries(WS, GROUPS)
        expect(entries).toHaveLength(3)
        expect(entries.map(e => e.name)).toEqual(['hclaw', 'nuphus-mcp', 'Downloads'])
        expect(entries[0].groupName).toBe('常用')
        expect(entries[0].path).toBe('E:\\a\\hclaw')
        expect(entries[2].groupName).toBe('')
    })

    it('name 为空时回退 path.basename', () => {
        const entries = collectProjectEntries([{path: 'E:\\x\\no-name', name: ''}], [])
        expect(entries[0].name).toBe('no-name')
    })
})

describe('resolveTargetPath', () => {
    const entries = collectProjectEntries(WS, GROUPS)

    it('组 + 项目 → 命中', () => {
        expect(resolveTargetPath(entries, {projectGroup: '常用', project: 'hclaw'}))
            .toEqual({ok: true, path: 'E:\\a\\hclaw'})
    })

    it('只给项目且全局唯一 → 命中', () => {
        expect(resolveTargetPath(entries, {project: 'Downloads'}))
            .toEqual({ok: true, path: 'D:\\Downloads'})
    })

    it('只给组 → 报错（组没有落点）', () => {
        const r = resolveTargetPath(entries, {projectGroup: '常用'})
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toContain('project')
    })

    it('组不存在 → 报错', () => {
        expect(resolveTargetPath(entries, {projectGroup: '没有这个组', project: 'hclaw'}).ok).toBe(false)
    })

    it('项目不存在 → 报错并提示 list_projects', () => {
        const r = resolveTargetPath(entries, {project: '不存在的项目'})
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toContain('list_projects')
    })

    it('同名项目跨组 → 报歧义，提示补 projectGroup', () => {
        // 复刻真实数据：两个同名项目分属不同组
        const dup = collectProjectEntries(
            [{path: 'E:\\w\\自媒体\\多平台', name: '多平台内容规划'}, {path: 'E:\\w\\media\\多平台', name: '多平台内容规划'}],
            [G('g1', '零散', 0, ['E:\\w\\自媒体\\多平台']), G('g2', '媒体', 1, ['E:\\w\\media\\多平台'])],
        )
        const r = resolveTargetPath(dup, {project: '多平台内容规划'})
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toContain('projectGroup')
        // 给了组就能消歧
        expect(resolveTargetPath(dup, {projectGroup: '媒体', project: '多平台内容规划'}))
            .toEqual({ok: true, path: 'E:\\w\\media\\多平台'})
    })

    it('同名项目同组 → 仍报错', () => {
        const dup = collectProjectEntries(
            [{path: 'E:\\w\\a', name: '同名'}, {path: 'E:\\w\\b', name: '同名'}],
            [G('g1', '零散', 0, ['E:\\w\\a', 'E:\\w\\b'])],
        )
        expect(resolveTargetPath(dup, {projectGroup: '零散', project: '同名'}).ok).toBe(false)
    })
})

describe('formatProjectsText', () => {
    it('按组输出，未分组单独成段', () => {
        const text = formatProjectsText(collectProjectEntries(WS, GROUPS))
        expect(text).toContain('项目组「常用」:')
        expect(text).toContain('  - hclaw')
        expect(text).toContain('未分组项目:')
        expect(text).toContain('  - Downloads')
        expect(text).not.toContain('__unassigned__')
    })
})
