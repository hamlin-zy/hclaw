/**
 * McpVersionManager — MCP 服务版本管理核心模块
 *
 * 职责：
 *   1. 启动时探测所有已启用 MCP 服务的版本
 *   2. 按 sourceType 分流检测（npx / plugin / binary / url / unknown）
 *   3. 缓存版本元数据，广播红点状态到渲染进程
 *   4. 提供升级执行入口（npx: 清缓存+重启 / plugin: 委托 / binary: 下载）
 *
 * 架构参考：PluginVersionManager（startupCheck → versionMap → broadcast → red dot）
 * 但检测逻辑完全独立，不复用插件/repo 代码。
 */

import {mcpService} from '../../services/mcpService'
import {broadcastToAllWindows} from '../../utils/windowBroadcast'
import {createLogger} from '../logger'
import {versionManager as pluginVersionManager} from '../../plugin/versionManager'
import type {McpServer} from '../../../shared/types/mcp'
import type {VersionMeta, SourceType} from './versionUtils'
import {
  parseNpmPackageSpec,
  buildNpxVersionArgs,
  compareVersions,
  compareVersionAsc,
  isValidVersionSpec,
  parseVersionOutput,
} from './versionUtils'
import {exec, spawn} from 'child_process'
import {promisify} from 'util'
import path from 'path'
import {mcpWorkerManager} from './mcpWorkerManager'

const execAsync = promisify(exec)
const logger = createLogger('mcp-version')

/** 提取错误信息（logger / 返回值共用） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 从 server id 解析插件名（格式 plugin:{pluginName}:{serverName}） */
function pluginNameOf(server: {id: string}): string {
  return server.id.split(':')[1] || ''
}

export class McpVersionManager {
  /** 内存缓存: serverId → VersionMeta */
  private versionMap = new Map<string, VersionMeta>()
  /** 去重锁：防止并发 startupCheck */
  private isChecking = false

  /**
   * 推断 MCP 服务的来源类型。
   *
   * 按优先级顺序判断（顺序有语义含义，勿随意调换）：
   *   1. command basename 是 npx/npm → 'npx'
   *      （必须早于 plugin 前缀判断：plugin:ecc:github 的 id 有 plugin 前缀，
   *        但实际执行的是 npx，应按 npm 包版本探测，否则会错误地走 git tags 路径）
   *   2. plugin: 前缀 → 'plugin'
   *   3. 有 url 且 command 为空 → 'url'
   *   4. command 非空且非 npx/npm → 'binary'
   *   5. 其他 → 'unknown'
   */
  inferSourceType(server: McpServer): SourceType {
    const basename = path.basename(server.command).toLowerCase().replace(/\.(cmd|exe|bat)$/, '')

    // Priority 1: npx/npm command (handle full paths like C:\...\npx.cmd)
    if (basename === 'npx' || basename === 'npm') {
      return 'npx'
    }

    // Priority 2: plugin prefix (only when NOT npx/npm)
    if (server.id.startsWith('plugin:')) {
      return 'plugin'
    }

    // Priority 3: URL-only server (no command)
    if (server.url && !server.command) {
      return 'url'
    }

    // Priority 4: binary (any non-empty command that's not npx/npm)
    if (server.command) {
      return 'binary'
    }

    // Priority 5: unknown
    return 'unknown'
  }

  /** 空版本 meta（探测失败 / 无版本信息时兜底） */
  private emptyMeta(sourceType: SourceType): VersionMeta {
    return {current: null, latest: null, hasUpdate: null, sourceType, lastChecked: Date.now(), availableVersions: []}
  }

  /**
   * Detect version for a single MCP server — dispatch by sourceType.
   * Each branch is independently fault-tolerant; failure returns null meta.
   */
  async detect(server: McpServer): Promise<VersionMeta> {
    const sourceType = this.inferSourceType(server)

    switch (sourceType) {
      case 'npx':
        return this.detectNpxVersion(server)
      case 'plugin':
        return this.detectPluginVersion(server)
      case 'binary':
        return this.detectBinaryVersion(server)
      case 'url':
        return this.emptyMeta('url')
      case 'unknown':
        return this.emptyMeta('unknown')
    }
  }

  /**
   * Spawn a command with timeout and return stdout.
   * Returns null on any failure (timeout, non-zero exit, error).
   */
  private spawnWithTimeout(command: string, args: string[], timeout: number): Promise<string | null> {
    return new Promise((resolve) => {
      let stdout = ''
      let timedOut = false
      // P0#1 fix: declare child BEFORE setTimeout to avoid TDZ reference
      let child: ReturnType<typeof spawn> | null = null

      const timer = setTimeout(() => {
        timedOut = true
        child?.kill('SIGTERM')
      }, timeout)

      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', () => {
        // Ignore stderr
      })

      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })

      child.on('close', (code: number) => {
        clearTimeout(timer)
        if (timedOut || code !== 0) {
          resolve(null)
          return
        }
        resolve(stdout)
      })
    })
  }

  /**
   * Detect npx/npm package version.
   * 1. Parse package name from command + args
   * 2. GetCurrent: spawn(command, [...originalArgs, '--version']) — NOT npx --version
   * 3. GetLatest: exec('npm view <pkg> version', 10s timeout)
   */
  private async detectNpxVersion(server: McpServer): Promise<VersionMeta> {
    const now = Date.now()
    const spec = parseNpmPackageSpec(server.command, server.args)
    if (!spec.pkgName) {
      logger.warn('[DIAG] detectNpxVersion: parser returned empty pkgName', {id: server.id, command: server.command, args: server.args})
      return this.emptyMeta('npx')
    }

    // Reuse the shared npm registry query (also used by detectBinaryVersion
    // for npm-global binaries). Keeps the two paths in sync.
    const {latest, availableVersions} = await this.queryNpmRegistry(spec.pkgName)

    // Current: parse from args. If no pin, npx fetches latest → current = latest
    const current = spec.version ?? latest

    const hasUpdate = compareVersions(current, latest)
    return {current, latest, hasUpdate, sourceType: 'npx', lastChecked: now, availableVersions}
  }

  /**
   * Detect plugin MCP version by reading pluginVersionManager cache.
   * No network requests — purely reads the plugin version manager's in-memory cache.
   * If plugin startupCheck hasn't completed (cache empty), returns null meta gracefully.
   */
  private async detectPluginVersion(server: McpServer): Promise<VersionMeta> {
    const now = Date.now()
    // Parse plugin name from id format: plugin:{pluginName}:{serverName}
    const pluginName = pluginNameOf(server)

    logger.info('[DIAG] detectPluginVersion: called', {
      id: server.id, pluginName, command: server.command, args: server.args,
    })

    if (!pluginName) {
      logger.warn('[DIAG] detectPluginVersion: empty pluginName', {id: server.id})
      return this.emptyMeta('plugin')
    }

    const versionInfo = pluginVersionManager.getVersions(pluginName)
    if (!versionInfo) {
      logger.warn('[DIAG] detectPluginVersion: pluginVersionManager has no data for plugin, availableVersions will be empty', {
        id: server.id, pluginName,
      })
      return this.emptyMeta('plugin')
    }

    logger.info('[DIAG] detectPluginVersion: got versionInfo', {
      id: server.id, pluginName,
      current: versionInfo.current, latest: versionInfo.latest,
      hasUpdate: versionInfo.hasUpdate, tagsCount: versionInfo.tags?.length ?? 0,
    })

    return {
      current: versionInfo.current,
      latest: versionInfo.latest,
      hasUpdate: versionInfo.hasUpdate,
      sourceType: 'plugin',
      lastChecked: now,
      availableVersions: versionInfo.tags || [],
    }
  }

  /**
   * Detect local binary version.
   *
   * Flow:
   *   1. GetCurrent: spawn(command, ['--version'], 3s timeout)
   *   2. Do NOT resolve the binary to a global npm/pip package and do NOT
   *      contact any registry or checkUrl for latest version.
   *
   * Why no upgrade detection for global binaries?
   *   `resolveBinary()` matches a binary by its basename against the local
   *   global `npm ls -g` / `pip list` indexes. That match is only a string
   *   equality on the binary name and does not verify that the running
   *   binary actually came from that package. Two unrelated packages can
   *   share a binary name (e.g. `foo-mcp` in npm and `foo-mcp` in pip, or a
   *   user-local binary that happens to collide), which produces a false
   *   positive: the UI then shows "upgrade to <registry latest>" and, if the
   *   user clicks it, `switchBinaryPkgVersion` will actually
   *   `npm install -g <pkg>@latest` / `pip install <pkg>==<latest>` and
   *   pollute the global environment.
   *
   * Consequence: binary servers still show their current version (from
   * `--version`), but never show a red dot / upgrade button / version
   * dropdown. Users who want auto-upgrade should install the same MCP server
   * via `npx <pkg>` (sourceType='npx') which is unambiguously pinned.
   */
  private async detectBinaryVersion(server: McpServer): Promise<VersionMeta> {
    const now = Date.now()

    // GetCurrent: spawn --version (may be null — that's fine)
    const currentStdout = await this.spawnWithTimeout(
      server.command,
      ['--version'],
      3000,
    )
    const current = currentStdout ? parseVersionOutput(currentStdout) : null

    return {
      current,
      latest: null,
      hasUpdate: null,
      sourceType: 'binary',
      lastChecked: now,
      availableVersions: [],
    }
  }

  /**
   * npm registry: `npm view <pkg> version` and `npm view <pkg> versions --json`.
   */
  private async queryNpmRegistry(pkgName: string): Promise<{latest: string | null, availableVersions: string[]}> {
    let latest: string | null = null
    try {
      const {stdout} = await execAsync(`npm view ${pkgName} version`, {timeout: 10_000})
      latest = stdout.trim() || null
    } catch (err) {
      logger.warn('npm view version failed', {pkgName, error: errMsg(err)})
    }

    let availableVersions: string[] = []
    try {
      const {stdout} = await execAsync(`npm view ${pkgName} versions --json`, {timeout: 10_000})
      const parsed = JSON.parse(stdout.trim())
      if (Array.isArray(parsed)) {
        availableVersions = parsed
          .filter((v: unknown) => typeof v === 'string')
          .sort(compareVersionAsc)
      }
    } catch (err) {
      logger.warn('npm view versions failed', {pkgName, error: errMsg(err)})
    }

    return {latest, availableVersions}
  }

  /**
   * Startup check — fire-and-forget, called from index.ts.
   * 1. Check isChecking dedup lock
   * 2. Get all enabled MCP servers
   * 3. Promise.allSettled(servers.map(detect))
   * 4. Store results in versionMap
   * 5. broadcastToAllWindows('mcp:status-update')
   * 6. Whole thing in try-catch — failures only log, never throw
   */
  async startupCheck(): Promise<Record<string, VersionMeta>> {
    if (this.isChecking) {
      logger.warn('startupCheck already in progress, returning cached result')
      return this.getAllVersionMeta()
    }

    this.isChecking = true

    try {
      const servers = mcpService.list().filter(s => s.enabled)
      logger.info('startupCheck.start', {total: servers.length})

      if (servers.length === 0) {
        const result = this.getAllVersionMeta()
        broadcastToAllWindows('mcp:status-update', result)
        return result
      }

      await Promise.all(servers.map(async (server) => {
          try {
            const meta = await this.detect(server)
            this.versionMap.set(server.id, meta)
            logger.info('startupCheck.server', {
              id: server.id, sourceType: meta.sourceType,
              current: meta.current, latest: meta.latest, hasUpdate: meta.hasUpdate,
            })
          } catch (err) {
            // Per-server failure: write null meta (distinguishes "detected but failed" from "not detected")
            const sourceType = this.inferSourceType(server)
            this.versionMap.set(server.id, {
              current: null, latest: null, hasUpdate: null,
              sourceType, lastChecked: Date.now(),
            })
            logger.warn('startupCheck.server.failed', {
              id: server.id,
              error: errMsg(err),
            })
          }
        }),
      )

      const result = this.getAllVersionMeta()
      logger.info('startupCheck.done', {cachedCount: this.versionMap.size})

      broadcastToAllWindows('mcp:status-update', result)
      return result
    } catch (err) {
      logger.error('startupCheck.failed', {
        error: errMsg(err),
      })
      return this.getAllVersionMeta()
    } finally {
      this.isChecking = false
    }
  }

  /**
   * Get cached version meta for a single server.
   */
  getVersionMeta(serverId: string): VersionMeta | null {
    return this.versionMap.get(serverId) ?? null
  }

  /**
   * Get cached available versions for a server.
   */
  getAvailableVersions(serverId: string): string[] {
    return this.versionMap.get(serverId)?.availableVersions ?? []
  }

  /**
   * Export all version meta — with stale-key cleanup.
   * Before returning, verify each key still exists in the current mcpServer list.
   * Remove keys that no longer exist (defensive against cache pollution).
   */
  getAllVersionMeta(): Record<string, VersionMeta> {
    // Only keep entries for currently enabled servers — disabled servers
    // should have their version data cleaned up (spec: "disabled after
    // startupCheck — Verify stale entry removed on next getAllVersionMeta call")
    const currentServerIds = new Set(
      mcpService.list().filter(s => s.enabled).map(s => s.id)
    )

    // Cleanup stale entries
    for (const key of this.versionMap.keys()) {
      if (!currentServerIds.has(key)) {
        this.versionMap.delete(key)
      }
    }

    return Object.fromEntries(this.versionMap)
  }

  /**
   * upgrade/switch 共享的前置守卫链：
   *   1. versionMap 命中检查
   *   2. 拒绝不支持的 sourceType（url/unknown/binary 无可升级产物）
   *   3. mcpService 服务器存在性检查
   */
  private resolveUpgradable(serverId: string): {ok: true; server: McpServer; meta: VersionMeta & {sourceType: 'npx' | 'plugin'}} | {ok: false; error: string} {
    const meta = this.versionMap.get(serverId)
    if (!meta) {
      return {ok: false, error: `Server ${serverId} not found in version cache`}
    }

    // Reject unsupported source types before touching the service —
    // url/unknown/binary servers have no upgradable artifact.
    // (binary upgrade detection was disabled: see detectBinaryVersion.)
    if (meta.sourceType === 'url' || meta.sourceType === 'unknown' || meta.sourceType === 'binary') {
      return {ok: false, error: 'unsupported_source_type'}
    }

    const server = mcpService.get(serverId)
    if (!server) {
      return {ok: false, error: `Server ${serverId} not found in service`}
    }

    // 守卫排除 url/unknown/binary 后，sourceType 只剩 npx | plugin
    return {ok: true, server, meta: meta as VersionMeta & {sourceType: 'npx' | 'plugin'}}
  }

  /**
   * Upgrade a server by sourceType dispatch.
   *   npx:     clear npm cache + restart server + re-probe
   *   plugin:  delegate to pluginInstaller.update()
   *   binary:  return manual update instruction (cannot auto-download binaries)
   *   url/unknown: return unsupported_source_type
   *
   * On restart failure: roll back versionMap to old value, preserve red dot.
   */
  async upgradeServer(serverId: string): Promise<{success: boolean; error?: string}> {
    const resolved = this.resolveUpgradable(serverId)
    if (!resolved.ok) return {success: false, error: resolved.error}
    const {server, meta} = resolved

    switch (meta.sourceType) {
      case 'npx':
        return this.upgradeNpxServer(serverId, server, meta)
      case 'plugin':
        return this.upgradePluginServer(serverId, server)
    }
  }

  /**
   * npx upgrade: clear npm cache → restart → re-probe version.
   * Cache clean failure is non-fatal (ignored).
   */
  private async upgradeNpxServer(
    serverId: string,
    server: McpServer,
    oldMeta: VersionMeta,
  ): Promise<{success: boolean; error?: string}> {
    try {
      // Clear npm cache (non-fatal if fails)
      try {
        await execAsync('npm cache clean --force', {timeout: 30000})
      } catch {
        logger.warn('upgradeNpx: cache clean failed (non-fatal)', {serverId})
      }

      // Restart server via Worker
      const restartResult = await mcpWorkerManager.restartServer(serverId)
      if (!restartResult.success) {
        // Roll back versionMap — preserve red dot
        this.versionMap.set(serverId, oldMeta)
        logger.warn('upgradeNpx: restart failed, rolling back', {serverId})
        return {success: false, error: 'restart failed'}
      }

      // Re-probe version after restart (delay 2s for process readiness)
      await new Promise(r => setTimeout(r, 2000))
      const newMeta = await this.detect(server)
      this.versionMap.set(serverId, newMeta)
      logger.info('upgradeNpx: success', {serverId, newCurrent: newMeta.current})
      return {success: true}
    } catch (err) {
      this.versionMap.set(serverId, oldMeta)
      return {success: false, error: errMsg(err)}
    }
  }

  /**
   * Plugin upgrade: delegate to pluginInstaller.update().
   */
  private async upgradePluginServer(
    serverId: string,
    server: McpServer,
  ): Promise<{success: boolean; error?: string}> {
    const pluginName = pluginNameOf(server)
    if (!pluginName) {
      return {success: false, error: 'Cannot parse plugin name from server id'}
    }

    try {
      const {PluginInstaller} = await import('../../plugin/installer')
      const installer = new PluginInstaller('')
      const result = await installer.update(pluginName, {force: true})
      if (!result.success) {
        return {success: false, error: 'Plugin update failed'}
      }

      // Refresh plugin capabilities (reloads plugin MCP servers)
      const {powerManager} = await import('../powerManager')
      await powerManager.refresh()

      // Re-read plugin version cache
      this.syncPluginMeta(serverId, pluginName, false)

      logger.info('upgradePlugin: success', {serverId, pluginName})
      return {success: true}
    } catch (err) {
      return {success: false, error: errMsg(err)}
    }
  }

  /**
   * 插件升级/切换成功后：从 pluginVersionManager 缓存回写 versionMap。
   * withAvailableVersions 控制是否携带 availableVersions 字段
   * （upgradePluginServer 原实现不写该字段，switchPluginVersion 写 —— 保持原行为）。
   */
  private syncPluginMeta(serverId: string, pluginName: string, withAvailableVersions: boolean): void {
    const versionInfo = pluginVersionManager.getVersions(pluginName)
    this.versionMap.set(serverId, {
      current: versionInfo?.current ?? null,
      latest: versionInfo?.latest ?? null,
      hasUpdate: versionInfo?.hasUpdate ?? null,
      sourceType: 'plugin',
      lastChecked: Date.now(),
      ...(withAvailableVersions ? {availableVersions: versionInfo?.tags ?? []} : {}),
    })
  }

  /**
   * Switch a server to a specific version.
   *   npx:     modify args to pin version → update mcpService → restart → re-probe
   *   plugin:  delegate to pluginVersionManager.switchVersion
   *   binary:  if pkgName+pkgManager set, run install command via that manager;
   *            else reject (unknown source)
   *   url/unknown: not supported
   */
  async switchVersion(serverId: string, version: string): Promise<{success: boolean, error?: string}> {
    const resolved = this.resolveUpgradable(serverId)
    if (!resolved.ok) return {success: false, error: resolved.error}
    const {server, meta} = resolved

    if (meta.sourceType === 'npx') {
      return this.switchNpxVersion(serverId, server, version)
    }

    if (meta.sourceType === 'plugin') {
      return this.switchPluginVersion(serverId, server, version)
    }

    return {success: false, error: 'unsupported_source_type'}
  }

  /**
   * npx version switch: modify args to pin version → update config → restart → re-probe.
   * Args are rolled back only if the update wasn't already applied (restart failed).
   * After a successful restart, versionMap reflects reality: re-probe on best effort,
   * falling back to optimistic state (current = targetVersion) if the probe fails.
   */
  private async switchNpxVersion(
    serverId: string,
    server: McpServer,
    targetVersion: string,
  ): Promise<{success: boolean, error?: string}> {
    if (!isValidVersionSpec(targetVersion)) {
      return {success: false, error: 'invalid version specifier'}
    }
    const oldMeta = this.versionMap.get(serverId)!
    const spec = parseNpmPackageSpec(server.command, server.args)
    if (!spec.pkgName) {
      return {success: false, error: 'Cannot parse package name from server args'}
    }

    // Phase 1: build args (pure computation — nothing to roll back on throw)
    let newArgs: string[]
    try {
      newArgs = buildNpxVersionArgs(server.args, spec.pkgName, targetVersion)
    } catch (err) {
      return {success: false, error: errMsg(err)}
    }
    const oldArgs = [...server.args]

    try {
      // Update mcpService config + persist to mcp.json
      mcpService.update(serverId, {args: newArgs})

      // Restart server
      const restartResult = await mcpWorkerManager.restartServer(serverId)
      if (!restartResult.success) {
        // Restart failed — new args were already applied, roll them back
        if (!mcpService.update(serverId, {args: oldArgs})) {
          logger.error('switchNpxVersion: rollback write failed', {serverId})
        }
        this.versionMap.set(serverId, oldMeta)
        logger.warn('switchNpxVersion: restart failed, rolling back', {serverId})
        return {success: false, error: 'restart failed — args rolled back'}
      }

      // Restart succeeded — args are now live. Best-effort re-probe.
      try {
        await new Promise(r => setTimeout(r, 2000))
        const updatedServer = mcpService.get(serverId) || server
        const newMeta = await this.detect({...updatedServer, args: newArgs})
        this.versionMap.set(serverId, newMeta)
      } catch (probeErr) {
        // Re-probe failed but server is running the new version.
        // Set optimistic versionMap state reflecting the pinned version.
        this.versionMap.set(serverId, {
          ...oldMeta,
          current: targetVersion,
          hasUpdate: false,
          lastChecked: Date.now(),
        })
        logger.warn('switchNpxVersion: re-probe failed, using optimistic state', {
          serverId,
          error: errMsg(probeErr),
        })
      }
      logger.info('switchNpxVersion: success', {serverId, targetVersion})
      return {success: true}
    } catch (err) {
      // Only reachable if mcpService.update or restartServer throws
      // (restartServer's rejection path is handled by the restartResult check).
      try {
        if (!mcpService.update(serverId, {args: oldArgs})) {
          logger.error('switchNpxVersion: rollback write failed', {serverId})
        }
      } catch (rollbackErr) {
        logger.error('switchNpxVersion: rollback threw', {serverId, error: rollbackErr})
      }
      this.versionMap.set(serverId, oldMeta)
      return {success: false, error: errMsg(err)}
    }
  }

  /**
   * Plugin version switch: delegate to pluginVersionManager.switchVersion.
   */
  private async switchPluginVersion(
    serverId: string,
    server: McpServer,
    version: string,
  ): Promise<{success: boolean, error?: string}> {
    const pluginName = pluginNameOf(server)
    if (!pluginName) {
      return {success: false, error: 'Cannot parse plugin name from server id'}
    }

    try {
      const result = await pluginVersionManager.switchVersion(pluginName, version)
      if (!result.success) {
        return {success: false, error: result.error || 'Plugin version switch failed'}
      }

      // Update versionMap from pluginVersionManager
      this.syncPluginMeta(serverId, pluginName, true)

      logger.info('switchPluginVersion: success', {serverId, pluginName, version})
      return {success: true}
    } catch (err) {
      return {success: false, error: errMsg(err)}
    }
  }
}

/** 模块级单例 */
export const mcpVersionManager = new McpVersionManager()
