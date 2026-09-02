// src/main/repo/type.ts
export type RepoSource = 'github' | 'gitee' | 'gitlab' | 'local'
export type InstallTarget = 'skill' | 'agent'

/** 一个带 .git 的仓库实体（owner/repo 维度） */
export interface GitRepo {
  /** "owner/repo"，由 git remote origin 解析 */
  id: string
  owner: string
  /** 仓库短名，如 gsap-skills */
  name: string
  /** 本地目录（含 .git） */
  path: string
  source: RepoSource
  /** 远程 origin URL */
  origin: string
  /** 该仓库下聚合的能力名 */
  capabilities: { plugins: string[]; skills: string[]; agents: string[] }
  /** 是否含 plugin.json / .claude-plugin/plugin.json（即是否也是插件） */
  hasManifest: boolean
  /** 插件源是否启用（非插件仓库恒 true） */
  enabled: boolean
}

/** 仓库版本信息（对应 plugin 的 VersionInfo，key 换成 repoId） */
export interface RepoVersionInfo {
  tags: string[]; branches: string[]; latest: string; current: string; hasUpdate: boolean
}

/** 红点用精简版本元数据 */
export interface RepoVersionMeta { current: string; latest: string; hasUpdate: boolean }

/** 版本切换结果 */
export interface RepoSwitchResult { success: boolean; versionInfo?: RepoVersionInfo; error?: string }

/** git remote 解析结果（供 registry/installer 复用） */
export interface RemoteInfo { origin: string; owner: string; name: string; source: RepoSource }
