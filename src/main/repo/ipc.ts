// src/main/repo/ipc.ts
import {ipcMain, IpcMainInvokeEvent} from 'electron'
import {createLogger} from '../agent/logger'
import {broadcastToAllWindows} from '../utils/windowBroadcast'
import {repoRegistry} from './registry'
import {repoVersionManager} from './versionManager'
import {installRepo} from './installer'
import type {InstallTarget, GitRepo} from './type'

const logger = createLogger('repo')

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 从真实注册表聚合技能/代理/插件能力（供 discover 填充 capabilities）。
 * 用 require 规避顶层循环依赖（agent/skills、agent/agentRegistry、plugin/registry 与 repo 模块互相引用风险）。 */
function collectCapabilityInputs() {
  const {skillRegistry} = require('../agent/skills') as typeof import('../agent/skills')
  const {agentRegistry} = require('../agent/agentRegistry') as typeof import('../agent/agentRegistry')
  const {PluginRegistry} = require('../plugin/registry') as typeof import('../plugin/registry')

  const skills = skillRegistry.getAll().map((s: any) => ({id: s.id, dir: s.skillDir}))
  const agents = agentRegistry.getAll()
    .filter((a: any) => typeof a.filePath === 'string')
    .map((a: any) => ({id: a.id, filePath: a.filePath}))
  const plugins = PluginRegistry.getInstance().getAll().map((p: any) => ({
    name: p.name, path: p.path, enabled: p.enabled,
  }))
  return {skills, agents, plugins}
}

export function registerRepoIPC(): void {
  ipcMain.handle('repo:install', async (_e: IpcMainInvokeEvent, target: InstallTarget, url: string) => {
    return installRepo(target, url)
  })

  ipcMain.handle('repo:list', async () => {
    const inputs = collectCapabilityInputs()
    return repoRegistry.discover(undefined, inputs)
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
}

/** 启动时调用：发现仓库 + 启动版本检查（fire-and-forget），推送红点 */
export async function initializeRepoSystem(): Promise<GitRepo[]> {
  try {
    const inputs = collectCapabilityInputs()
    const repos = await repoRegistry.discover(undefined, inputs)
    const metas = await repoVersionManager.startupCheck(repos)
    logger.info('repo-startup-done', {repos: repos.length, updates: Object.keys(metas).filter(k => metas[k].hasUpdate).length})
    return repos
  } catch (err) {
    logger.warn('repo-startup-failed', {error: asError(err)})
    return []
  }
}
