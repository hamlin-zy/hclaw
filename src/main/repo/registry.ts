// src/main/repo/registry.ts
import * as fs from 'fs'
import * as path from 'path'
import {simpleGit} from 'simple-git'
import {getHclawDir} from '../config'
import type {GitRepo, RemoteInfo, RepoSource} from './type'
import {parseGitOrigin} from './origin'

/** discover 可注入的依赖集合（测试无需 config mock / 真实 git） */
export interface RegistryDeps {
  roots: {plugins: string; skillsPublic: string; agents: string}
  skills: {id: string; dir: string}[]
  agents: {id: string; filePath: string}[]
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
    const rootPaths = [roots.plugins, roots.skillsPublic, roots.agents]

    for (const root of rootPaths) {
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

  /** 聚合能力、填充 hasManifest/enabled（纯逻辑） */
  private computeCapabilities(
    repos: GitRepo[],
    skills: {id: string; dir: string}[],
    agents: {id: string; filePath: string}[],
    plugins: {name: string; path: string; enabled: boolean}[],
  ): void {
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
