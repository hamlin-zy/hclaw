// src/main/repo/registry.ts
import * as fs from 'fs'
import * as path from 'path'
import {simpleGit} from 'simple-git'
import {getHclawDir} from '../hclawPaths'
import type {GitRepo, RemoteInfo, RepoSource, RepoRootType} from './type'
import {parseGitOrigin} from './origin'

/** discover 可注入的依赖集合（测试无需 config mock / 真实 git） */
export interface RegistryDeps {
  roots: {plugins: string; skillsPublic: string; agents: string}
  skills: {id: string; dir: string; enabled: boolean}[]
  agents: {id: string; filePath: string; enabled: boolean}[]
  plugins: {name: string; path: string; enabled: boolean}[]
}

/** 从 startDir 向上逐级寻找与某仓库 path 完全相等的目录 */
export function findRepoRoot(startDir: string, repos: GitRepo[]): GitRepo | undefined {
  let dir = path.resolve(startDir)
  while (true) {
    const hit = repos.find(r => path.resolve(r.path) === dir)
    if (hit) return hit
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 默认 git origin 读取器（真实 git 命令），补齐 RemoteInfo.origin 字段 */
async function readRemoteOrigin(dir: string): Promise<RemoteInfo | null> {
  try {
    const git = simpleGit(dir)
    const remotes = await git.getRemotes(true)
    const origin = remotes.find(r => r.name === 'origin')
    if (!origin?.refs.fetch) return null
    const parsed = parseGitOrigin(origin.refs.fetch)
    return parsed ? {...parsed, origin: origin.refs.fetch} : null
  } catch {
    return null
  }
}

export class RepoRegistry {
  private repos = new Map<string, GitRepo>()
  private static instance: RepoRegistry

  static getInstance(): RepoRegistry {
    if (!RepoRegistry.instance) RepoRegistry.instance = new RepoRegistry()
    return RepoRegistry.instance
  }

  /**
   * 扫描三类仓库根目录，构建 GitRepo 列表。
   * originReader / deps 均可注入以便测试隔离（默认真实 git + getHclawDir 路径）。
   */
  async discover(
    originReader: (dir: string) => Promise<RemoteInfo | null> = readRemoteOrigin,
    deps?: Partial<RegistryDeps>,
  ): Promise<GitRepo[]> {
    const hclawDir = getHclawDir()
    const roots = deps?.roots ?? {
      plugins: path.join(hclawDir, 'plugins'),
      skillsPublic: path.join(hclawDir, 'skills', 'public'),
      agents: path.join(hclawDir, 'agents'),
    }
    const skills = deps?.skills ?? []
    const agents = deps?.agents ?? []
    const plugins = deps?.plugins ?? []

    const found: GitRepo[] = []
    const seen = new Set<string>()
    // rootType 映射：plugins → plugin，skills/public → skill，agents → agent
    const rootEntries: {path: string; type: RepoRootType}[] = [
      {path: roots.plugins, type: 'plugin'},
      {path: roots.skillsPublic, type: 'skill'},
      {path: roots.agents, type: 'agent'},
    ]

    for (const {path: root, type: rootType} of rootEntries) {
      if (!fs.existsSync(root)) continue
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(root, {withFileTypes: true})
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dirPath = path.join(root, entry.name)
        // 只处理含 .git 的目录（仓库根）
        if (!fs.existsSync(path.join(dirPath, '.git'))) continue

        let parsed: RemoteInfo | null = null
        try {
          parsed = await originReader(dirPath)
        } catch {
          parsed = null
        }

        let owner: string, name: string, source: RepoSource, id: string
        if (parsed) {
          owner = parsed.owner; name = parsed.name; source = parsed.source; id = `${owner}/${name}`
        } else {
          // 无 origin 或解析不出：local，id 用目录名（去 @source/@xxx 后缀）
          const baseName = entry.name.replace(/@source$/, '').replace(/@[a-z]+$/, '')
          owner = baseName; name = baseName; source = 'local'; id = baseName
        }
        if (seen.has(id)) continue
        seen.add(id)

        found.push({
          id, owner, name, path: dirPath, source, origin: parsed?.origin || '',
          capabilities: {plugins: [], skills: [], agents: []},
          hasManifest: this.hasManifest(dirPath),
          enabled: true,
          hasEnabledCapability: true,
          rootType,
        })
      }
    }

    this.computeCapabilities(found, skills, agents, plugins)
    this.repos = new Map(found.map(r => [r.id, r]))
    return found
  }

  private hasManifest(repoPath: string): boolean {
    return (fs.existsSync(path.join(repoPath, '.claude-plugin', 'plugin.json')) ||
      fs.existsSync(path.join(repoPath, 'plugin.json')))
  }

  /** 聚合能力、填充 hasManifest/enabled，并派生 hasEnabledCapability。
   * 幂等：每次进入先清空 skills/agents 聚合结果，可重复调用。 */
  private computeCapabilities(
    repos: GitRepo[],
    skills: {id: string; dir: string; enabled: boolean}[],
    agents: {id: string; filePath: string; enabled: boolean}[],
    plugins: {name: string; path: string; enabled: boolean}[],
  ): void {
    for (const repo of repos) {
      repo.capabilities.skills.length = 0
      repo.capabilities.agents.length = 0
    }

    const skillEnabled = new Map(skills.map(s => [s.id, s.enabled]))
    const agentEnabled = new Map(agents.map(a => [a.id, a.enabled]))

    for (const skill of skills) {
      const repo = findRepoRoot(skill.dir, repos)
      if (repo) repo.capabilities.skills.push(skill.id)
    }
    for (const agent of agents) {
      if (typeof agent.filePath !== 'string') continue
      const repo = findRepoRoot(path.dirname(agent.filePath), repos)
      if (repo) repo.capabilities.agents.push(agent.id)
    }
    for (const plugin of plugins) {
      const repo = findRepoRoot(plugin.path, repos)
      if (repo) {
        if (!repo.capabilities.plugins.includes(plugin.name)) repo.capabilities.plugins.push(plugin.name)
        repo.hasManifest = true
        if (!plugin.enabled) repo.enabled = false
      }
    }

    // 派生 hasEnabledCapability：技能仓库看 skills、代理仓库看 agents、插件仓库看两者合并；
    // 列表为空时保守为 true（不因解析失败熄灭红点）。
    // 判据用 `!== false`：能力清单经 `(s: any)` 透传，缺 `enabled` 字段时 get 得 undefined ——
    // 若按「=== true 才算启用」会把它当禁用，仓库被误判全禁用、红点被误熄灭（漏更新提示）。
    // 缺字段视为启用，与本特性「全禁用才熄红点」的保守口径一致。
    for (const repo of repos) {
      const enabledFlags = repo.rootType === 'agent'
        ? repo.capabilities.agents.map(id => agentEnabled.get(id) !== false)
        : repo.rootType === 'skill'
          ? repo.capabilities.skills.map(id => skillEnabled.get(id) !== false)
          : [
              ...repo.capabilities.skills.map(id => skillEnabled.get(id) !== false),
              ...repo.capabilities.agents.map(id => agentEnabled.get(id) !== false),
            ]
      repo.hasEnabledCapability = enabledFlags.length === 0 ? true : enabledFlags.some(Boolean)
    }
  }

  /**
   * 能力开关变化后的轻量重算：复用 `this.repos` 里现有仓库（path / id / 仓库边界都取自 discover
   * 的结果），仅按新的能力清单重算 capabilities 与 hasEnabledCapability。
   *
   * 有意不重新 discover —— discover 会为每个仓库跑一次 `git getRemotes`，而能力开关只改变
   * 「启用态」、不改变仓库边界；每次开关都全量扫描的性能开销不可接受。
   * deps 缺省的空能力清单意味着「无任何能力信息」，不改变仓库集合本身。
   */
  refreshCapabilities(deps?: Partial<RegistryDeps>): GitRepo[] {
    const repos = this.getAll()
    this.computeCapabilities(repos, deps?.skills ?? [], deps?.agents ?? [], deps?.plugins ?? [])
    return repos
  }

  get(id: string): GitRepo | undefined { return this.repos.get(id) }
  getAll(): GitRepo[] { return Array.from(this.repos.values()) }
  getByPath(p: string): GitRepo | undefined {
    const resolved = path.resolve(p)
    for (const repo of this.repos.values()) {
      if (path.resolve(repo.path) === resolved) return repo
    }
    return undefined
  }
  clear(): void { this.repos.clear() }
}

/** 模块级单例 */
export const repoRegistry = RepoRegistry.getInstance()
