/**
 * 启动护栏与未就绪路径 — Task 4 契约
 *
 * 背景：仓库能力（capabilities）来自 powerManager 初始化后的技能/代理/插件注册表。
 * powerManager.initialize() 之前采集到的能力清单必然为空 —— 若把这个空清单当成
 * 「仓库能力全禁用」写回注册表，红点与分组会被写坏。
 *
 * 三条不变量：
 *   1. waitForRegistryReady：未就绪时等待，超时返回 false（默认 20s）；已就绪立即 true；
 *   2. initializeRepoSystem：注册表未就绪 → 记 warn('repo-startup-skipped')、
 *      不 discover、不 startupCheck、返回上一轮注册表快照；
 *   3. repo:list（discoverRepos）：注册表未就绪 → 直接返回 repoRegistry.getAll() 快照，
 *      绝不重扫（重扫会用空能力数据覆盖既有仓库的 capabilities）——Review Focus #1。
 *
 * 判据说明：“未就绪” 以 powerManager.hasLoadedOnce() 为准（单调：加载过就永不复位）——
 * 插件安装/卸载路径的 resetInitialized() 只回落 isInitialized()，refresh() 不恢复它，
 * 用后者会让守卫在数据已新鲜时长期误判未就绪（见最后一条回归用例）。
 *
 * 隔离：config/hclawPaths 指向系统临时目录，powerManager 打桩、PluginInstaller 打桩
 *      （fetchTags 为 spy），不触碰真实 ~/.hclaw，不跑真实 git / 不联网。
 */
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Module from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  /** ipcMain.handle 捕获的通道 → handler */
  handlers: new Map<string, (e: unknown, ...args: any[]) => unknown>(),
  /** powerManager.hasLoadedOnce() 的可控答案 —— 守卫实际判据（单调：加载过就永不复位） */
  loadedOnce: false,
  /** powerManager.isInitialized() 的可控答案 —— 回归用例需要它回落 false 但仍不放行守卫 */
  initialized: false,
  /** powerManager.whenInitialized() 的可控实现（缺省永不 resolve） */
  whenInitialized: (() => new Promise<void>(() => {})) as () => Promise<void>,
  /** PluginInstaller.fetchTags spy —— startupCheck 对外副作用的唯一探针 */
  fetchTags: vi.fn(async () => {}),
}))

vi.mock('electron', () => ({
  ipcMain: {handle: (ch: string, fn: (e: unknown, ...args: any[]) => unknown) => { h.handlers.set(ch, fn) }},
  app: {isPackaged: false, getPath: () => ''},
  BrowserWindow: {getAllWindows: () => []},
}))

// 路径能力指向临时目录，避免落到真实 ~/.hclaw
vi.mock('@/main/hclawPaths', () => {
  const osMod = require('os')
  const pathMod = require('path')
  const testDir = pathMod.join(osMod.tmpdir(), 'hclaw-test-startup-guard')
  return {
    getHclawDir: () => testDir,
    getHclawDataDir: () => pathMod.join(testDir, 'data'),
  }
})

// 副作用隔离：真实 sqlite 模块顶层会读 config（registry.test.ts 同款桩）
vi.mock('@/main/repositories/sqlite', () => ({
  getDatabase: () => ({}),
  systemSettingsRepo: {},
  workspaceRepo: {},
}))

vi.mock('@/main/agent/powerManager', () => ({
  powerManager: {
    isInitialized: () => h.initialized,
    hasLoadedOnce: () => h.loadedOnce,
    whenInitialized: () => h.whenInitialized(),
    refresh: async () => {},
  },
}))

// versionManager 顶层会 new PluginInstaller('')；打桩后 fetchTags 变成可断言 spy
vi.mock('@/main/plugin/installer', () => ({
  PluginInstaller: class {
    fetchTags = h.fetchTags
    listTags = async () => []
    listBranches = async () => []
    getCurrentRef = async () => 'HEAD'
  },
}))

vi.mock('@/main/utils/windowBroadcast', () => ({
  broadcastToAllWindows: () => {},
  broadcastToOtherWindows: () => {},
}))

// ── 让 ipc.ts 内部的原生 require 在测试中可解析 ───────────────────────────────
// 守卫放行后 discoverRepos 会经 collectCapabilityInputs() 用原生 require('../agent/skills')
// 等采集能力清单；node 原生 require 不解析「目录 + index.ts」形式（src/main/agent/skills 即
// 目录），故把这三个请求重定向到临时 CJS 桩。未放行守卫的用例不会走到这里，隔离性不变。
const capStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-guard-cap-stubs-'))
const CAP_STUBS: Record<string, string> = {
  '../agent/skills': 'module.exports = {skillRegistry: {getAll: () => []}}',
  '../agent/agentRegistry': 'module.exports = {agentRegistry: {getAll: () => []}}',
  '../plugin/registry': 'module.exports = {PluginRegistry: {getInstance: () => ({getAll: () => []})}}',
}
for (const request of Object.keys(CAP_STUBS)) {
  const file = path.join(capStubDir, `${request.replace(/\W+/g, '_')}.cjs`)
  fs.writeFileSync(file, CAP_STUBS[request], 'utf8')
  CAP_STUBS[request] = file
}
const moduleInternals = Module as unknown as {_resolveFilename: (...args: any[]) => string}
const originalResolveFilename = moduleInternals._resolveFilename
moduleInternals._resolveFilename = function (request: string, ...rest: any[]): string {
  return CAP_STUBS[request] ?? originalResolveFilename.call(this, request, ...rest)
}
afterAll(() => { moduleInternals._resolveFilename = originalResolveFilename })

import {initializeRepoSystem, registerRepoIPC, waitForRegistryReady} from '@/main/repo/ipc'
import {repoRegistry} from '@/main/repo/registry'
import {repoVersionManager} from '@/main/repo/versionManager'
import type {GitRepo} from '@/main/repo/type'

const REPO_ID = 'g/gsap-skills'

const origin = async () => ({
  origin: 'https://github.com/g/gsap-skills.git', owner: 'g', name: 'gsap-skills', source: 'github' as const,
})

/** 造一个含 .git 的真实仓库目录树（discover 只认文件系统，不跑 git） */
function makeRepoTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-guard-'))
  const skillDir = path.join(base, 'skills', 'public', 'gsap@source', 'skill1')
  fs.mkdirSync(path.join(base, 'skills', 'public', 'gsap@source', '.git'), {recursive: true})
  fs.mkdirSync(skillDir, {recursive: true})
  return {
    roots: {
      plugins: path.join(base, 'plugins'),
      skillsPublic: path.join(base, 'skills', 'public'),
      agents: path.join(base, 'agents'),
    },
    skills: [{id: 's1', dir: skillDir, enabled: true}],
  }
}

/** 预置「上一轮快照」：注册表里已有一条能力启用的仓库 */
async function seedRegistry(): Promise<GitRepo[]> {
  const {roots, skills} = makeRepoTree()
  await repoRegistry.discover(origin, {roots, skills, agents: [], plugins: []})
  const seeded = repoRegistry.getAll()
  expect(seeded.map(r => r.id)).toEqual([REPO_ID])
  expect(seeded[0].hasEnabledCapability).toBe(true)
  return seeded
}

function notReady(): void {
  h.loadedOnce = false
  h.initialized = false
  h.whenInitialized = () => new Promise<void>(() => {}) // 永不 resolve → 只能靠超时兜底
}

describe('waitForRegistryReady — 就绪等待与超时', () => {
  beforeEach(() => {
    repoRegistry.clear()
    h.fetchTags.mockClear()
    notReady()
  })

  it('whenInitialized 永不 resolve + timeoutMs=10 → 返回 false（不悬挂）', async () => {
    await expect(waitForRegistryReady(10)).resolves.toBe(false)
  })

  it('已加载过（守卫判据）→ 立即返回 true，且不触碰 whenInitialized', async () => {
    h.loadedOnce = true
    h.initialized = true
    h.whenInitialized = () => { throw new Error('已加载过时不应等待') }
    await expect(waitForRegistryReady(10)).resolves.toBe(true)
  })
})

describe('initializeRepoSystem — 未就绪时跳过版本检查', () => {
  beforeEach(() => {
    repoRegistry.clear()
    h.fetchTags.mockClear()
    notReady()
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('未就绪（超时兜底）→ 不 discover、不 startupCheck、不 fetchTags，返回上一轮快照并记 warn', async () => {
    const snapshot = await seedRegistry()
    const discoverSpy = vi.spyOn(repoRegistry, 'discover')
    const startupSpy = vi.spyOn(repoVersionManager, 'startupCheck')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.useFakeTimers()
    try {
      const pending = initializeRepoSystem()
      await vi.advanceTimersByTimeAsync(20_000) // 默认超时 20000ms
      const result = await pending

      expect(h.fetchTags).not.toHaveBeenCalled()      // 没跑版本检查
      expect(startupSpy).not.toHaveBeenCalled()       // startupCheck 未被调用
      expect(discoverSpy).not.toHaveBeenCalled()      // 未重扫（避免空能力覆盖）
      expect(result).toEqual(snapshot)                // 返回上一轮注册表快照，而非 []
      expect(result.map(r => r.id)).toEqual([REPO_ID])
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('repo-startup-skipped')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('discoverRepos 就绪守卫 — repo:list 不用空能力数据覆盖注册表', () => {
  const call = (channel: string, ...args: unknown[]) =>
    h.handlers.get(channel)!(null, ...args) as Promise<unknown>

  beforeEach(() => {
    repoRegistry.clear()
    h.handlers.clear()
    h.fetchTags.mockClear()
    notReady()
    registerRepoIPC()
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('未就绪时 repo:list 返回既有快照，且不再 discover / 不重算能力', async () => {
    const snapshot = await seedRegistry()
    const discoverSpy = vi.spyOn(repoRegistry, 'discover')
    const refreshSpy = vi.spyOn(repoRegistry, 'refreshCapabilities')

    notReady()
    const result = (await call('repo:list')) as GitRepo[]

    expect(discoverSpy).not.toHaveBeenCalled()          // 未就绪 ≠ 能力为空，禁止重扫覆盖
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(result).toEqual(snapshot)                    // 上一轮快照原样返回
    expect(result.map(r => r.id)).toEqual([REPO_ID])
    expect(result[0].hasEnabledCapability).toBe(true)   // 能力派生没被空清单抹掉
  })

  it('回归：initialize() 完成过 → resetInitialized() 后 isInitialized()=false，守卫仍不命中（重扫取新鲜数据）', async () => {
    const stale = await seedRegistry()                  // 上一轮快照：该仓库能力启用
    expect(stale[0].hasEnabledCapability).toBe(true)
    // 本次重扫结果：能力已按新鲜清单重算（这里表现为全禁用）
    const fresh = stale.map(r => ({...r, hasEnabledCapability: false}))
    const discoverSpy = vi.spyOn(repoRegistry, 'discover').mockResolvedValue(fresh)

    // 插件安装/卸载路径：resetInitialized() 把 initialized 打回 false，而 refresh() 不恢复它
    h.initialized = false
    h.loadedOnce = true

    const result = (await call('repo:list')) as GitRepo[]

    expect(h.initialized).toBe(false)                   // isInitialized() 确为 false
    expect(discoverSpy).toHaveBeenCalledTimes(1)        // 守卫未命中 → 确实走了真实 discover
    expect(result).toEqual(fresh)                       // 返回重扫结果
    expect(result).not.toEqual(stale)                   // 而非上一轮快照
    expect(result[0].hasEnabledCapability).toBe(false)  // 用的是新鲜能力数据
  })
})
