import {describe, expect, it} from 'vitest'

// repoGrouping：SkillsDialog 仓库 tab 的分组 + hasUpdate 优先排序纯函数
describe('buildRepoGroups', () => {
  it('按仓库归属分组：有归属进 group，无归属进 local', async () => {
    const {buildRepoGroups} = await import('@/renderer/components/repo/repoGrouping')
    const repos = [
      {id: 'gsap/gsap', capabilities: {skills: ['skill.a', 'skill.b'], agents: [], plugins: []}},
    ]
    const skills = [
      {id: 'skill.a', name: 'a'},
      {id: 'skill.c', name: 'c'},
    ]
    const {local, groups} = buildRepoGroups(skills as any, repos as any)
    expect(groups).toHaveLength(1)
    expect(groups[0].repo.id).toBe('gsap/gsap')
    expect(groups[0].skills.map(s => s.id)).toEqual(['skill.a'])
    expect(local.map(s => s.id)).toEqual(['skill.c'])
  })

  it('无仓库归属时 groups 为空、全部进 local', async () => {
    const {buildRepoGroups} = await import('@/renderer/components/repo/repoGrouping')
    const {local, groups} = buildRepoGroups(
      [{id: 's1', name: 's1'}] as any,
      [{id: 'x/y', capabilities: {skills: ['other'], agents: [], plugins: []}}] as any,
    )
    expect(groups).toHaveLength(0)
    expect(local.map(s => s.id)).toEqual(['s1'])
  })

  it('repo capabilities 为空 skills 时不产生空 group', async () => {
    const {buildRepoGroups} = await import('@/renderer/components/repo/repoGrouping')
    const repos = [{id: 'e/f', capabilities: {skills: [], agents: [], plugins: []}}]
    const {groups} = buildRepoGroups([] as any, repos as any)
    expect(groups).toHaveLength(0)
  })
})

describe('filterRepoTabSkills', () => {
  it('排除插件目录技能（source=plugin），保留用户/内置/无 source 技能', async () => {
    const {filterRepoTabSkills} = await import('@/renderer/components/repo/repoGrouping')
    const skills = [
      {id: 's.user', source: 'user'},
      {id: 's.plugin', source: 'plugin'},
      {id: 's.builtin', source: 'builtin'},
      {id: 's.none'},
    ]
    const result = filterRepoTabSkills(skills as any) as {id: string}[]
    expect(result.map(s => s.id)).toEqual(['s.user', 's.builtin', 's.none'])
  })

  it('全部为插件技能时返回空数组', async () => {
    const {filterRepoTabSkills} = await import('@/renderer/components/repo/repoGrouping')
    expect(filterRepoTabSkills([{id: 'a', source: 'plugin'}] as any)).toHaveLength(0)
  })
})

describe('sortReposByUpdate', () => {
  it('hasUpdate 的 repo 排在前，其余保持原序', async () => {
    const {sortReposByUpdate} = await import('@/renderer/components/repo/repoGrouping')
    const groups = [
      {repo: {id: 'a', capabilities: {skills: [], agents: [], plugins: []}}, skills: [{id: 'a1'}]},
      {repo: {id: 'b', capabilities: {skills: [], agents: [], plugins: []}}, skills: [{id: 'b1'}]},
      {repo: {id: 'c', capabilities: {skills: [], agents: [], plugins: []}}, skills: [{id: 'c1'}]},
    ] as any
    const updateMap = {a: false, b: true, c: false}
    const sorted = sortReposByUpdate(groups, updateMap)
    expect(sorted.map(g => g.repo.id)).toEqual(['b', 'a', 'c'])
  })

  it('全部无更新时保持原序', async () => {
    const {sortReposByUpdate} = await import('@/renderer/components/repo/repoGrouping')
    const groups = [
      {repo: {id: 'a', capabilities: {skills: [], agents: [], plugins: []}}, skills: []},
      {repo: {id: 'b', capabilities: {skills: [], agents: [], plugins: []}}, skills: []},
    ] as any
    const sorted = sortReposByUpdate(groups, {a: false, b: false})
    expect(sorted.map(g => g.repo.id)).toEqual(['a', 'b'])
  })
})
