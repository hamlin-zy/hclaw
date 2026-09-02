/**
 * PluginVersionManager — 插件版本管理核心模块
 *
 * 职责：
 *   1. 启动时对所有 git 源插件执行 git fetch --tags，缓存版本列表
 *   2. 提供版本查询（tags/branches/latest/hasUpdate）
 *   3. 提供版本切换能力（git checkout + powerManager.refresh）
 *   4. 检测有可用更新的插件并推送红点状态
 *
 * 数据流：
 *   index.ts (启动) → startupCheck() → 缓存 → webContents.send 推送
 *   PluginDialog  → syncVersions(name) → 更新缓存 → 推送
 *   PluginDialog  → switchVersion(name, ref) → git checkout → powerManager.refresh
 */

import {PluginInstaller} from './installer'
import {PluginRegistry} from './registry'
import {powerManager} from '../agent/powerManager'
import {createLogger} from '../agent/logger'
import {repoRegistry} from '../repo/registry'
import {repoVersionManager} from '../repo/versionManager'

const logger = createLogger('plugin-version')

// ── 类型定义 ──────────────────────────────────────────

export interface VersionInfo {
  /** 所有 git tags，按 semver 降序排列 */
  tags: string[]
  /** 远程分支列表（origin/ 前缀已去除） */
  branches: string[]
  /** 最新 tag（tags.length > 0 时的第一个） */
  latest: string
  /** 当前所在 ref（tag 或 branch 名） */
  current: string
  /** 是否有可用更新（current vs latest semver 比较） */
  hasUpdate: boolean
}

export interface SwitchResult {
  success: boolean
  error?: string
  versionInfo?: VersionInfo
}

// ── PluginVersionManager ──────────────────────────────

class PluginVersionManagerImpl {
  /** 内存缓存: pluginName → VersionInfo */
  private versionMap = new Map<string, VersionInfo>()
  /** 复用 installer 实例，避免每次操作创建新对象 */
  private installer = new PluginInstaller('')

  /**
   * 启动时调用 — fire-and-forget。
   * 对所有 git 源插件执行 git fetch --tags 并缓存版本信息。
   * 结果通过 webContents.send('plugin:status-update', data) 推送，
   * 由调用方（index.ts 中的 ipc handler）获取 mainWindow 发送。
   */
  async startupCheck(): Promise<Record<string, VersionInfo>> {
    const registry = PluginRegistry.getInstance()
    const allPlugins = registry.getAll()
    const gitPlugins = allPlugins.filter(p =>
      ['github', 'gitee', 'gitlab'].includes(p.source)
    )

    logger.info('startupCheck.start', {total: allPlugins.length, gitPlugins: gitPlugins.length})

    if (gitPlugins.length === 0) return {}

    await Promise.all(gitPlugins.map(async (plugin) => {
      try {
        await this.installer.fetchTags(plugin.path)
        const info = await this.collectVersionInfo(plugin.path, plugin.manifest.version)
        this.versionMap.set(plugin.name, info)
        logger.info('startupCheck.plugin', {plugin: plugin.name, hasUpdate: info.hasUpdate, current: info.current, latest: info.latest})
      } catch (err) {
        logger.warn('startupCheck.failed', {
          plugin: plugin.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }))

    const result = this.exportMap()
    logger.info('startupCheck.done', {cachedCount: this.versionMap.size})
    return result
  }

  /**
   * 同步单个插件的版本列表 — git fetch --tags + 重新缓存。
   * 由「同步版本」按钮调用。
   */
  async syncVersions(pluginName: string): Promise<VersionInfo | null> {
    const registry = PluginRegistry.getInstance()
    const plugin = registry.get(pluginName)
    if (!plugin || !['github', 'gitee', 'gitlab'].includes(plugin.source)) {
      return null
    }

    try {
      await this.installer.fetchTags(plugin.path)
      const info = await this.collectVersionInfo(plugin.path, plugin.manifest.version)
      this.versionMap.set(pluginName, info)
      return info
    } catch (err) {
      logger.error('syncVersions.failed', {
        plugin: pluginName,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  /**
   * 获取缓存的版本信息（不触发远程请求）。
   * 缓存未命中时尝试从本地收集一次（不 fetch）。
   */
  getVersions(pluginName: string): VersionInfo | undefined {
    return this.versionMap.get(pluginName)
  }

  /**
   * 预热缓存：本地收集版本信息（不触发远程 fetch）。
   * 适用于插件列表加载时初始化下拉显示。
   */
  async warmCache(pluginName: string, pluginPath: string, manifestVersion?: string): Promise<VersionInfo> {
    try {
      const info = await this.collectVersionInfo(pluginPath, manifestVersion)
      this.versionMap.set(pluginName, info)
      return info
    } catch {
      const fallback: VersionInfo = {
        tags: [],
        branches: [],
        latest: manifestVersion || '0.0.0',
        current: manifestVersion || '0.0.0',
        hasUpdate: false,
      }
      this.versionMap.set(pluginName, fallback)
      return fallback
    }
  }

  /**
   * 切换插件版本 — git checkout ref + powerManager.refresh。
   * 切换后会重新加载插件能力。
   */
  async switchVersion(pluginName: string, ref: string): Promise<SwitchResult> {
    const registry = PluginRegistry.getInstance()
    const plugin = registry.get(pluginName)
    if (!plugin) {
      return {success: false, error: `Plugin not found: ${pluginName}`}
    }
    if (!['github', 'gitee', 'gitlab'].includes(plugin.source)) {
      return {success: false, error: 'Local plugins do not support version switching'}
    }

    try {
      const repo = repoRegistry.getByPath(plugin.path)
      const result = repo
        ? await repoVersionManager.checkoutRefForRepo(repo.id, ref)
        : await this.installer.checkoutRef(plugin.path, ref)
      if (!result.success) {
        return result
      }

      // 重新加载插件能力
      await powerManager.refresh()

      // 重新加载插件 manifest（git checkout 后 plugin.json 可能已变化）
      let newManifestVersion = plugin.manifest.version
      try {
        const {PluginLoader} = await import('./loader')
        const loader = new PluginLoader(registry)
        registry.unregister(pluginName)
        const newPlugin = await loader.loadPlugin(plugin.path)
        registry.updateEnabled(pluginName, plugin.enabled)
        newManifestVersion = newPlugin.manifest.version
      } catch (err) {
        logger.warn('switchVersion.reload-manifest-failed', {
          plugin: pluginName,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // 刷新版本缓存（使用新 manifest 版本号）
      const versionInfo = await this.collectVersionInfo(plugin.path, newManifestVersion)
      this.versionMap.set(pluginName, versionInfo)

      logger.info('switchVersion.success', {plugin: pluginName, ref})
      return {success: true, versionInfo}
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('switchVersion.failed', {plugin: pluginName, ref, error: message})
      return {success: false, error: message}
    }
  }

  /**
   * 导出完整的状态 map（用于推送红点状态）。
   */
  exportMap(): Record<string, VersionInfo> {
    return Object.fromEntries(this.versionMap)
  }

  /**
   * 获取所有插件的版本元数据（不含 tags/branches 列表，仅红点相关字段）。
   * 供渲染进程 via IPC 调用，用于页面打开后即时同步红点状态。
   */
  getAllVersionMeta(): Record<string, { current: string; latest: string; hasUpdate: boolean }> {
    const meta: Record<string, { current: string; latest: string; hasUpdate: boolean }> = {}
    for (const [name, info] of this.versionMap) {
      meta[name] = { current: info.current, latest: info.latest, hasUpdate: info.hasUpdate }
    }
    return meta
  }

  /**
   * 从 manifest 版本号推断 tag 前缀。
   *
   * 场景：impeccable 单仓同时发版 skill/cli/extension 三组件，tag 为
   *   skill-v4.0.3 / ext-v1.3.0 / cli-v3.4.0。
   * 如果不按前缀过滤，插件管理器下拉框会混入其他组件的 tag。
   *
   * 推断规则：找到 tags 中第一个以 manifestVersion 结尾的 tag，
   * 提取其前缀（"skill-v"、"ext-v"等），然后只保留该前缀的 tag。
   */
  private inferTagPrefix(tags: string[], manifestVersion?: string): string {
    if (!manifestVersion || tags.length === 0) return ''
    const matched = tags.find(t => t.endsWith(manifestVersion))
    if (!matched) return ''
    return matched.slice(0, matched.length - manifestVersion.length)
  }

  /**
   * 收集版本信息（本地 git 命令，不 fetch）。
   * manifestVersion 用于判断 current（当 getCurrentRef 返回 'HEAD' 时兜底）。
   */
  private async collectVersionInfo(pluginPath: string, manifestVersion?: string): Promise<VersionInfo> {
    const allTags = await this.installer.listTags(pluginPath)

    // ── 按 tag 前缀过滤 ──────────────────────────────
    // 单仓多组件场景（如 impeccable: skill-v / ext-v / cli-v），
    // 只保留属于当前插件的 tag。
    const prefix = this.inferTagPrefix(allTags, manifestVersion)
    const tags = prefix ? allTags.filter(t => t.startsWith(prefix)) : allTags

    // Tags 列表不为空时，不获取 branch（版本切换以 tag 为主）
    let branches: string[] = []
    if (tags.length === 0) {
      branches = await this.installer.listBranches(pluginPath)
    }

    const rawCurrent = await this.installer.getCurrentRef(pluginPath).catch(() => '')

    // 对 current 和 tags 做 v 前缀归一化比较：标签名可能带 v 也可能不带
    const stripV = (s: string) => s.replace(/^v/i, '')
    const normalizedTags = tags.map(stripV)
    const normalizedCurrent = stripV(rawCurrent)
    const matchedIdx = normalizedTags.indexOf(normalizedCurrent)

    // current 使用 tag 的原始名称（含 v 前缀，与 git checkout 兼容）
    let current = matchedIdx >= 0
      ? tags[matchedIdx]
      : (manifestVersion || 'HEAD')

    // 如果 current 不在 tags 列表中（如 manifest version "4.0.2" 但 tag 是 "skill-v4.0.2"），
    // 直接用已推断的前缀拼出完整 tag 名，避免重复遍历查找。
    if (tags.length > 0 && !tags.includes(current) && manifestVersion) {
      const expectedTag = prefix + manifestVersion
      if (tags.includes(expectedTag)) current = expectedTag
    }

    const latest = tags.length > 0 ? tags[0] : ''

    // hasUpdate: 纯字符串比较 current 是否已是 latest tag。
    // 不依赖 semver 解析——插件版本格式五花八门，字符串比较最可靠。
    const hasUpdate = tags.length > 0 && current !== latest

    return {tags, branches, latest, current, hasUpdate}
  }
}

/** 模块级单例 */
export const versionManager = new PluginVersionManagerImpl()
