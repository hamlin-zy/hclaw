// src/main/repo/versionManager.ts
import {PluginInstaller} from '../plugin/installer'
import {powerManager} from '../agent/powerManager'
import {createLogger} from '../agent/logger'
import {repoRegistry} from './registry'
import type {GitRepo, RepoVersionInfo, RepoVersionMeta, RepoSwitchResult} from './type'

const logger = createLogger('repo-version')

export class RepoVersionManager {
  /** 内存缓存: repoId → RepoVersionInfo */
  private versionMap = new Map<string, RepoVersionInfo>()
  private installer = new PluginInstaller('')

  /** 收集版本信息（本地 git 命令，不 fetch）。无 manifest 前缀过滤——仓库级按 semver tag。 */
  async collectVersionInfo(repoPath: string): Promise<RepoVersionInfo> {
    const allTags = await this.installer.listTags(repoPath)
    let branches: string[] = []
    if (allTags.length === 0) {
      branches = await this.installer.listBranches(repoPath)
    }
    const rawCurrent = await this.installer.getCurrentRef(repoPath).catch(() => '')
    const stripV = (s: string) => s.replace(/^v/i, '')
    const normalizedTags = allTags.map(stripV)
    const normalizedCurrent = stripV(rawCurrent)
    const idx = normalizedTags.indexOf(normalizedCurrent)
    const current = idx >= 0 ? allTags[idx] : (rawCurrent || 'HEAD')
    const latest = allTags.length > 0 ? allTags[0] : ''
    const hasUpdate = allTags.length > 0 && current !== latest
    return {tags: allTags, branches, latest, current, hasUpdate}
  }

  getVersions(repoId: string): RepoVersionInfo | undefined {
    return this.versionMap.get(repoId)
  }

  async warmCache(repoId: string, repoPath: string): Promise<RepoVersionInfo> {
    // 插件仓库版本由 PluginVersionManager 管理，不混入 repo versionMap
    const repo = repoRegistry.get(repoId)
    if (repo?.rootType === 'plugin') {
      return {tags: [], branches: [], latest: '', current: 'HEAD', hasUpdate: false}
    }
    try {
      const info = await this.collectVersionInfo(repoPath)
      this.versionMap.set(repoId, info)
      return info
    } catch {
      const fallback: RepoVersionInfo = {tags: [], branches: [], latest: '', current: 'HEAD', hasUpdate: false}
      this.versionMap.set(repoId, fallback)
      return fallback
    }
  }

  async syncVersions(repoId: string): Promise<RepoVersionInfo | null> {
    const repo = repoRegistry.get(repoId)
    if (!repo || repo.source === 'local' || repo.rootType === 'plugin') return null
    try {
      await this.installer.fetchTags(repo.path)
      const info = await this.collectVersionInfo(repo.path)
      this.versionMap.set(repoId, info)
      return info
    } catch (err) {
      logger.error('syncVersions.failed', {repoId, error: err instanceof Error ? err.message : String(err)})
      return null
    }
  }

  async startupCheck(repos: GitRepo[]): Promise<Record<string, RepoVersionInfo>> {
    // 只检查技能/代理仓库（rootType !== 'plugin'）。插件仓库的版本由
    // PluginVersionManager 独立管理，混入会导致「仓库」tab 红点亮起但列表项无红点
    // （用户无法定位是哪个仓库有更新）。
    const gitRepos = repos.filter(r => r.source !== 'local' && r.rootType !== 'plugin')
    await Promise.all(gitRepos.map(async (repo) => {
      try {
        await this.installer.fetchTags(repo.path)
        const info = await this.collectVersionInfo(repo.path)
        this.versionMap.set(repo.id, info)
      } catch (err) {
        logger.warn('startupCheck.failed', {repoId: repo.id, error: err instanceof Error ? err.message : String(err)})
      }
    }))
    return this.exportMap()
  }

  /** 供 PluginVersionManager 委托的底层 checkout（仓库可被发现时走 repo 机器） */
  async checkoutRefForRepo(repoId: string, ref: string): Promise<{success: boolean; error?: string}> {
    const repo = repoRegistry.get(repoId)
    if (!repo) return {success: false, error: `Repo not found: ${repoId}`}
    const result = await this.installer.checkoutRef(repo.path, ref)
    if (!result.success) return result
    // checkout 已成功，缓存刷新失败不应让 switch 失败
    try {
      const info = await this.collectVersionInfo(repo.path)
      this.versionMap.set(repoId, info)
    } catch (err) {
      logger.warn('checkoutRefForRepo.cacheRefreshFailed', {repoId, ref, error: err instanceof Error ? err.message : String(err)})
    }
    return result
  }

  async switchVersion(repoId: string, ref: string): Promise<RepoSwitchResult> {
    const repo = repoRegistry.get(repoId)
    if (!repo) return {success: false, error: `Repo not found: ${repoId}`}
    if (repo.source === 'local') {
      return {success: false, error: 'Local repos do not support version switching'}
    }
    if (repo.rootType === 'plugin') {
      return {success: false, error: 'Plugin repos are managed by PluginVersionManager'}
    }
    try {
      const result = await this.installer.checkoutRef(repo.path, ref)
      if (!result.success) return result as RepoSwitchResult
      // 重载能力（含技能/代理/插件）并广播 CapabilityEvents.REFRESHED
      await powerManager.refresh()
      const info = await this.collectVersionInfo(repo.path)
      this.versionMap.set(repoId, info)
      return {success: true, versionInfo: info}
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('switchVersion.failed', {repoId, ref, error: message})
      return {success: false, error: message}
    }
  }

  exportMap(): Record<string, RepoVersionInfo> {
    return Object.fromEntries(this.versionMap)
  }

  getAllVersionMeta(): Record<string, RepoVersionMeta> {
    const meta: Record<string, RepoVersionMeta> = {}
    for (const [id, info] of this.versionMap) {
      // 排除插件仓库——其版本由 PluginVersionManager 管理。
      // 若包含它们，tab 红点（hasUpdate = any(...true)）会因插件仓库
      // 处于 main 分支超前于最新 tag 而恒亮，即使技能仓库已切换到最新版。
      const repo = repoRegistry.get(id)
      if (repo?.rootType === 'plugin') continue
      meta[id] = {current: info.current, latest: info.latest, hasUpdate: info.hasUpdate}
    }
    return meta
  }
}

/** 模块级单例 */
export const repoVersionManager = new RepoVersionManager()
