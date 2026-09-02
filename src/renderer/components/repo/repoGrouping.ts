// repoGrouping — SkillsDialog 仓库 tab 的分组 + hasUpdate 优先排序纯函数
// 独立成模块便于单测（无 React / zustand 依赖）。用泛型保留传入对象的完整类型。

export interface RepoGroup<R = any, S = any> {
  repo: R
  skills: S[]
}

/**
 * 按仓库归属分组：有归属（repo.capabilities.skills 包含技能 id）的进 group，
 * 无归属的进 local。repo capabilities 为空 skills 时不产生空 group。
 */
export function buildRepoGroups<S = any, R = any>(
  skills: S[],
  repos: R[],
): { local: S[]; groups: RepoGroup<R, S>[] } {
  const grouped = new Map<string, RepoGroup<R, S>>()
  const local: S[] = []

  for (const skill of skills) {
    const repo = repos.find(r => (r as any).capabilities?.skills?.includes((skill as any).id))
    if (repo) {
      const entry = grouped.get((repo as any).id) || { repo, skills: [] }
      entry.skills.push(skill)
      grouped.set((repo as any).id, entry)
    } else {
      local.push(skill)
    }
  }

  return { local, groups: Array.from(grouped.values()) }
}

/**
 * 仓库 tab 的技能过滤：只保留 skills 管理页安装仓库的技能（source='user'），
 * 排除插件目录技能（source='plugin'），确保插件目录仓库不产生分组。
 */
export function filterRepoTabSkills<S extends {source?: string}>(skills: S[]): S[] {
  return skills.filter(s => s.source !== 'plugin')
}

/**
 * 按 hasUpdate 排序：updateMap[repo.id] 为 true 的 repo 排在前，
 * 其余保持原序（稳定排序，用于有更新的列表项置顶）。
 *
 * 泛型 G 收窄到 `{ repo: { id } }`：仅依赖 group.repo.id 排序，
 * 调用方传入任意携带 repo 的分组结构（RepoGroup 或 { repo, agents } 等），
 * 返回类型保留完整 G，无需 as any 断言。
 */
export function sortReposByUpdate<G extends { repo: { id: string } }>(
  groups: G[],
  updateMap: Record<string, boolean>,
): G[] {
  return [...groups].sort((a, b) => {
    const au = updateMap[a.repo.id] ? 1 : 0
    const bu = updateMap[b.repo.id] ? 1 : 0
    return bu - au
  })
}
