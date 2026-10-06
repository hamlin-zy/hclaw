// src/main/repo/ipc.ts
import * as fs from 'fs'
import * as path from 'path'
import {ipcMain, IpcMainInvokeEvent} from 'electron'
import {createLogger} from '../agent/logger'
import {getHclawDir} from '../hclawPaths'
import {broadcastToAllWindows} from '../utils/windowBroadcast'
import {repoRegistry, type RegistryDeps} from './registry'
import {repoVersionManager} from './versionManager'
import {installRepo} from './installer'
import {uninstallRepo, asError, DEFAULT_RETRY_DELAYS_MS, type UninstallDeps} from './uninstaller'
import {setCapabilityStateListener} from './capabilitySignal'
import {powerManager} from '../agent/powerManager'
import type {InstallTarget, GitRepo} from './type'

const logger = createLogger('repo')

/** waitForRegistryReady 默认超时（ms） */
const REGISTRY_READY_TIMEOUT_MS = 20000

/**
 * 等待能力注册表（powerManager）完成首次全量初始化。
 * 已加载过立即 true；否则最多等 timeoutMs（默认 20s），超时返回 false 让调用方走降级路径。
 * 判据用 hasLoadedOnce()（单调）而非 isInitialized()：插件安装/卸载路径会
 * resetInitialized() + refresh()，refresh() 不恢复 initialized —— 用后者会让守卫在
 * 该窗口内长期误判「未就绪」，而此刻 refresh() 刚跑完、能力数据其实是新鲜的。
 * 不做 reject —— 调用方需要的是「能不能用」，不是异常。
 */
export function waitForRegistryReady(timeoutMs: number = REGISTRY_READY_TIMEOUT_MS): Promise<boolean> {
  if (powerManager.hasLoadedOnce()) return Promise.resolve(true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([powerManager.whenInitialized().then(() => true), timeout])
    .finally(() => { if (timer) clearTimeout(timer) })
}

/** 从真实注册表聚合技能/代理/插件能力（供 discover 填充 capabilities）。
 * require 为有意设计：规避顶层循环依赖（agent/skills、agent/agentRegistry、plugin/registry 与 repo 模块互相引用风险），
 * 故禁用 no-require-imports 规则。 */
/* eslint-disable @typescript-eslint/no-require-imports */
function collectCapabilityInputs() {
  const {skillRegistry} = require('../agent/skills') as typeof import('../agent/skills')
  const {agentRegistry} = require('../agent/agentRegistry') as typeof import('../agent/agentRegistry')
  const {PluginRegistry} = require('../plugin/registry') as typeof import('../plugin/registry')

  const skills = skillRegistry.getAll().map((s: any) => ({id: s.id, dir: s.skillDir, enabled: s.enabled}))
  const agents = agentRegistry.getAll()
    .filter((a: any) => typeof a.filePath === 'string')
    .map((a: any) => ({id: a.id, filePath: a.filePath, enabled: a.enabled}))
  const plugins = PluginRegistry.getInstance().getAll().map((p: any) => ({
    name: p.name, path: p.path, enabled: p.enabled,
  }))
  return {skills, agents, plugins}
}

/** 发现仓库并把版本缓存裁剪到活跃仓库集合（返回值形状不变）。 */
async function discoverRepos(): Promise<GitRepo[]> {
  // 注册表未就绪 ≠ 能力为空：powerManager 初始化前采集到的能力清单必然为空，
  // 照此重算会把「仓库能力全禁用」写进注册表（红点与分组被写坏）。
  // 此时原样返回上一轮快照、不做任何覆盖；首次 discover 由 initializeRepoSystem
  // 在 initAgent() 之后触发（见 src/main/index.ts）。
  // 判据用 hasLoadedOnce()（单调）：插件安装/卸载路径 resetInitialized() + refresh() 后
  // initialized 仍是 false，但能力数据已新鲜，不应再被守卫拦住。
  if (!powerManager.hasLoadedOnce()) return repoRegistry.getAll()
  const inputs = collectCapabilityInputs()
  const repos = await repoRegistry.discover(undefined, inputs)
  repoVersionManager.prune(repos.map(r => r.id))
  return repos
}

/** 能力清单采集器。接线处可注入，签名与 `collectCapabilityInputs` 一致。 */
type CapabilityInputCollector = () => Partial<RegistryDeps>

export function registerRepoIPC(collect: CapabilityInputCollector = collectCapabilityInputs): void {
  // 能力开关（技能/代理启用态）变化 → 重算红点派生并广播。
  // 依赖方向：skills/agents IPC → capabilitySignal ← repo/ipc（单向，信号模块零 import）。
  // 采集器在接线处注入（默认即真实采集），使 notify 链路可被测试直接驱动跑通。
  setCapabilityStateListener(() => refreshRepoMeta(collect))

  ipcMain.handle('repo:install', async (_e: IpcMainInvokeEvent, target: InstallTarget, url: string) => {
    return installRepo(target, url)
  })

  ipcMain.handle('repo:list', async () => {
    return discoverRepos()
  })

  ipcMain.handle('repo:get-versions', async (_e, repoId: string) => {
    let info = repoVersionManager.getVersions(repoId)
    if (!info) {
      const repo = repoRegistry.get(repoId)
      if (repo) info = await repoVersionManager.warmCache(repoId, repo.path)
    }
    return info ?? null
  })

  ipcMain.handle('repo:sync-versions', async (_event: IpcMainInvokeEvent, repoId: string) => {
    const info = await repoVersionManager.syncVersions(repoId)
    broadcastToAllWindows('repo:status-update', repoVersionManager.getAllVersionMeta())
    return info
  })

  ipcMain.handle('repo:switch-version', async (_event: IpcMainInvokeEvent, repoId: string, ref: string) => {
    const result = await repoVersionManager.switchVersion(repoId, ref)
    if (result.success) {
      broadcastToAllWindows('repo:status-update', repoVersionManager.getAllVersionMeta())
    }
    return result
  })

  ipcMain.handle('repo:get-all-version-meta', async () => {
    return repoVersionManager.getAllVersionMeta()
  })

  /**
   * 卸载一个仓库（技能/代理仓库）：删本地克隆 + 清 override 残留 + 刷新缓存与红点。
   * 守卫（仓库不存在 / 插件仓库 / 路径不在可卸载根下 / 缺 .git）与失败语义都在
   * uninstaller 内，此处只做依赖装配与结果透传，契约见 UninstallResult。
   */
  ipcMain.handle('repo:uninstall', async (_e: IpcMainInvokeEvent, repoId: string) => {
    // agent 侧依赖走惰性 require（沿用上方 collectCapabilityInputs 的 eslint-disable 块）：
    // skills loader / agentLoader 与 repo 模块存在互相引用风险，顶层 import 会形成循环依赖。
    const {deleteSkillOverrides} = require('../agent/skills/loader') as typeof import('../agent/skills/loader')
    const {deleteAgentOverrides} = require('../agent/agentLoader') as typeof import('../agent/agentLoader')

    const deps: UninstallDeps = {
      getRepo: id => repoRegistry.get(id),
      // 真实路径：uninstaller 用 isStrictlyUnderRoot 判合法性，空串会让一切仓库被判为越界
      roots: {
        skillsPublic: path.join(getHclawDir(), 'skills', 'public'),
        agents: path.join(getHclawDir(), 'agents'),
      },
      // force 容忍目录已被外部删除（ENOENT）：卸载是幂等操作，不该因残留状态报错
      // 用 fs.promises.rm：@types/node 只给 fs.rm 声明了 callback 重载，promise 形态在 fs.promises 上
      rm: dir => fs.promises.rm(dir, {recursive: true, force: true}),
      // 契约里 deleteSkillOverrides / dropVersionCache / broadcastMeta 是同步 `(): void`：
      // 传同步实现，否则 rejection 会绕过 uninstaller 的 try/catch 变成 unhandled rejection
      deleteSkillOverrides,
      deleteAgentOverrides,
      dropVersionCache: id => repoVersionManager.drop(id),
      reloadCapabilities: () => powerManager.refresh(),
      // 目录已变化 → 重新发现仓库边界（自带就绪守卫），并广播新的红点元数据
      discoverRepos,
      broadcastMeta: () => broadcastToAllWindows('repo:status-update', repoVersionManager.getAllVersionMeta()),
      // 走 uninstaller 模块的默认重试间隔（9 × 500ms）；接线处无需调整时不再硬编码副本
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    }
    return uninstallRepo(repoId, deps)
  })
}

/**
 * 能力开关变化后的轻量刷新：内存重算 capabilities / hasEnabledCapability + 广播红点元数据。
 * 广播前为「重算后已启用、却缺版本条目」的仓库补一次 warmCache —— 否则「全禁用 → 重新启用」
 * 这类仓库（启动时被跳过、从未写过条目）的红点不会恢复。
 *
 * 有意不重新 discover、不 prune —— 能力开关只改变「启用态」，不改变仓库边界；
 * discover 会为每个仓库跑一次 `git getRemotes`，每次开关都全量扫描的开销不可接受。
 * 仓库集合的真相仍由 repo:list 的 discover 路径负责。
 * 并发调用复用同一个在途 promise（不重入）；失败只记日志不外抛（调用方是 IPC 写路径）。
 *
 * collect 为能力清单采集器（缺省即真实采集）。采集与重算同处 catch 边界内：
 * 采集走惰性 require 以规避顶层循环依赖，而该 require 在 vitest 下无法解析 TS 路径，
 * 故接线处（registerRepoIPC）留出注入口，让测试能真正驱动本条轻量链路。
 */
let repoMetaRefresh: Promise<void> | null = null

export function refreshRepoMeta(collect: CapabilityInputCollector = collectCapabilityInputs): Promise<void> {
  if (repoMetaRefresh) return repoMetaRefresh
  repoMetaRefresh = (async () => {
    const repos = repoRegistry.refreshCapabilities(collect())
    // 补版本缓存（别删这段）：上次会话就被全部禁用的仓库，启动检查会跳过它 —— 它没有版本
    // 条目；用户重新启用某个能力后，「全禁用即过滤」虽已解除，但 versionMap 里仍没有它，
    // 广播出的 meta 缺这个仓库 → 仓库 tab 与卡片红点都不恢复（两者同源 meta）。
    // 故对「重算后已启用、却没有版本条目」的仓库按轻量口径补一次 warmCache：
    // 内部已 try/catch 且不 fetchTags、只跑本地 git 命令，与轻量路径的开销目标一致。
    for (const repo of repos) {
      if (!repo.hasEnabledCapability || repo.source === 'local' || repo.rootType === 'plugin') continue
      if (repoVersionManager.getVersions(repo.id) !== undefined) continue
      await repoVersionManager.warmCache(repo.id, repo.path)
    }
    broadcastToAllWindows('repo:status-update', repoVersionManager.getAllVersionMeta())
  })()
    .catch(err => {
      logger.warn('repo-meta-refresh-failed', {error: asError(err)})
    })
    .finally(() => {
      repoMetaRefresh = null
    })
  return repoMetaRefresh
}

/**
 * 启动时调用：发现仓库 + 启动版本检查（fire-and-forget），推送红点。
 *
 * 注册表未就绪（powerManager 尚未首次全量初始化）时降级：只记 warn 并返回上一轮
 * 注册表快照 —— 不做 discover、不做 startupCheck。调用点已在 initAgent() 之后
 * （见 src/main/index.ts），故此处的超时只是防御性兜底（其它调用方 / 启动顺序变化）。
 */
export async function initializeRepoSystem(): Promise<GitRepo[]> {
  try {
    const ready = await waitForRegistryReady()
    if (!ready) {
      logger.warn('repo-startup-skipped', {reason: 'registry-not-ready'})
      return repoRegistry.getAll()
    }
    const repos = await discoverRepos()
    const metas = await repoVersionManager.startupCheck(repos)
    logger.info('repo-startup-done', {repos: repos.length, updates: Object.keys(metas).filter(k => metas[k].hasUpdate).length})
    return repos
  } catch (err) {
    logger.warn('repo-startup-failed', {error: asError(err)})
    return []
  }
}
