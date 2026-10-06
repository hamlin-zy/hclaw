/**
 * repo:uninstall IPC 接线契约 — Task 7
 *
 * 主进程侧把 Task 6 的卸载核心（uninstaller.uninstallRepo）接成 IPC handler：
 *   1. 守卫拒绝的返回形状（仓库不存在 / 插件仓库 / 路径不在可卸载根下 / 缺 .git）
 *      必须原样透传给渲染层 —— 渲染层据 error 文案与 success 决定提示方式；
 *   2. 装配给 uninstallRepo 的 deps 键集合是 Task 6 的对外契约（键多一个少一个都会
 *      让 deps 里的实现被静默忽略），故逐字断言；
 *   3. 契约里声明为 `(): void` 的三个回调（deleteSkillOverrides / dropVersionCache /
 *      broadcastMeta）必须装配**同步**实现：若传 async 函数，其 rejection 会绕过
 *      uninstaller 内部的 try/catch 变成 unhandled rejection（表现为「没 warning
 *      但操作没生效」）。注意「装配 deps」用例里的三个探针打的是桩
 *      （deleteSkillOverrides 来自 CJS 桩、broadcastMeta 来自被 mock 的 windowBroadcast），
 *      只验证装配形态；真实实现的同步性由「三个 void 契约真实实现同步」用例
 *      直取真实模块保证（绕过 CJS 桩与 vi.mock）；
 *   4. roots 必须是真实路径（getHclawDir 下的 skills/public 与 agents），
 *      不能是空串 —— 否则守卫会把一切合法仓库判为「不在可卸载的根目录下」。
 *
 * 隔离：electron 打桩（捕获 handler）、hclawPaths 指向临时目录、powerManager /
 *      plugin installer / sqlite / broadcast 全部打桩，uninstaller 默认转发真实实现
 *      （仅装配断言用例换成 spy），不触碰真实 ~/.hclaw、不跑真实 git、不删真实目录。
 */
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import Module from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** 本文件独占的临时 hclaw 目录（被 @/main/hclawPaths 打桩复用） */
const TEST_HCLAW_DIR = path.join(os.tmpdir(), 'hclaw-test-uninstall-ipc')

const h = vi.hoisted(() => ({
  /** ipcMain.handle 捕获的通道 → handler */
  handlers: new Map<string, (e: unknown, ...args: any[]) => unknown>(),
  /** null → 走真实 uninstaller.uninstallRepo；置为 spy → 捕获装配的 deps */
  uninstallSpy: null as null | ((repoId: string, deps: any) => Promise<any>),
  /** broadcastToAllWindows 捕获的广播 */
  broadcasts: [] as Array<{channel: string; payload: unknown}>,
}))

vi.mock('electron', () => ({
  ipcMain: {handle: (ch: string, fn: (e: unknown, ...args: any[]) => unknown) => { h.handlers.set(ch, fn) }},
  app: {isPackaged: false, getPath: () => ''},
  BrowserWindow: {getAllWindows: () => []},
}))

vi.mock('@/main/hclawPaths', () => {
  const osMod = require('os')
  const pathMod = require('path')
  const testDir = pathMod.join(osMod.tmpdir(), 'hclaw-test-uninstall-ipc')
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
    refresh: async () => {},
    isInitialized: () => true,
    hasLoadedOnce: () => true,
    whenInitialized: async () => {},
  },
}))

// versionManager 顶层会 new PluginInstaller('')；打桩避免真实 git 与网络
vi.mock('@/main/plugin/installer', () => ({
  PluginInstaller: class {
    fetchTags = async () => {}
    listTags = async () => []
    listBranches = async () => []
    getCurrentRef = async () => 'HEAD'
  },
}))

vi.mock('@/main/utils/windowBroadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { h.broadcasts.push({channel, payload}) },
  broadcastToOtherWindows: () => {},
}))

// uninstaller：默认转发真实实现（守卫用例走真实代码路径），装配断言用例换成 spy
vi.mock('@/main/repo/uninstaller', async importOriginal => {
  const actual = await importOriginal<typeof import('@/main/repo/uninstaller')>()
  return {
    ...actual,
    uninstallRepo: (repoId: string, deps: any) =>
      h.uninstallSpy ? h.uninstallSpy(repoId, deps) : actual.uninstallRepo(repoId, deps),
  }
})

// ── 让 ipc.ts 内部的原生 require 在测试中可解析 ───────────────────────────────
// 卸载 handler 用原生 require 惰性引入 agent 侧实现（规避顶层循环依赖），而 node 原生
// require 不解析 TS 路径（`../agent/skills` 还是「目录 + index.ts」形式），故把这些请求
// 重定向到临时 CJS 桩。桩同时是「同步实现」的探针：返回 undefined。
const capStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-ipc-cap-stubs-'))
const CAP_STUBS: Record<string, string> = {
  '../agent/skills': 'module.exports = {skillRegistry: {getAll: () => []}}',
  '../agent/agentRegistry': 'module.exports = {agentRegistry: {getAll: () => []}}',
  '../plugin/registry': 'module.exports = {PluginRegistry: {getInstance: () => ({getAll: () => []})}}',
  '../agent/skills/loader': 'module.exports = {deleteSkillOverrides: () => undefined}',
  '../agent/agentLoader': 'module.exports = {deleteAgentOverrides: async () => undefined}',
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
afterAll(() => {
  moduleInternals._resolveFilename = originalResolveFilename
  fs.rmSync(capStubDir, {recursive: true, force: true})
  fs.rmSync(TEST_HCLAW_DIR, {recursive: true, force: true})
})

import {registerRepoIPC} from '@/main/repo/ipc'
import {repoRegistry} from '@/main/repo/registry'
import type {GitRepo} from '@/main/repo/type'

/** Task 6 的 UninstallDeps 键集合（逐字） */
const EXPECTED_DEP_KEYS = [
  'getRepo', 'roots', 'rm', 'deleteSkillOverrides', 'deleteAgentOverrides',
  'dropVersionCache', 'reloadCapabilities', 'discoverRepos', 'broadcastMeta', 'retryDelaysMs',
]

const ORIGIN_READER = async (dir: string) => {
  const name = path.basename(dir)
  return {origin: `https://github.com/g/${name}.git`, owner: 'g', name, source: 'github' as const}
}

const uninstallHandler = () => {
  const handler = h.handlers.get('repo:uninstall')
  expect(handler, 'repo:uninstall handler 未注册').toBeTypeOf('function')
  return handler as (e: unknown, repoId: string) => Promise<any>
}

/** 造一棵含 .git 的仓库树并 discover 进注册表 */
async function seedRepos(): Promise<{roots: {plugins: string; skillsPublic: string; agents: string}; repos: GitRepo[]}> {
  const roots = {
    plugins: path.join(TEST_HCLAW_DIR, 'plugins'),
    skillsPublic: path.join(TEST_HCLAW_DIR, 'skills', 'public'),
    agents: path.join(TEST_HCLAW_DIR, 'agents'),
  }
  fs.mkdirSync(path.join(roots.plugins, 'plug1', '.git'), {recursive: true})
  const skillDir = path.join(roots.skillsPublic, 'sk1')
  fs.mkdirSync(path.join(skillDir, '.git'), {recursive: true})
  const repos = await repoRegistry.discover(ORIGIN_READER, {roots, skills: [], agents: [], plugins: []})
  return {roots, repos}
}

beforeEach(() => {
  h.handlers.clear()
  h.broadcasts.length = 0
  h.uninstallSpy = null
  repoRegistry.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(() => {
  fs.rmSync(TEST_HCLAW_DIR, {recursive: true, force: true})
  fs.mkdirSync(TEST_HCLAW_DIR, {recursive: true})
})

describe('repo:uninstall — 守卫结果透传（真实 uninstaller）', () => {
  it('注册表为空 → {success:false, error:"仓库不存在: ghost/x"}', async () => {
    registerRepoIPC()
    const result = await uninstallHandler()({}, 'ghost/x')
    expect(result).toEqual({success: false, error: '仓库不存在: ghost/x'})
  })

  it('插件仓库 → 拒绝并提示去插件页签卸载（不加 "插件" 之外的字段）', async () => {
    const {repos} = await seedRepos()
    expect(repos.find(r => r.rootType === 'plugin')?.id).toBe('g/plug1')
    registerRepoIPC()

    const result = await uninstallHandler()({}, 'g/plug1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('插件')
    expect(result.error).toContain('g/plug1')
  })

  it('roots 为真实 getHclawDir 路径：根下但缺 .git → 报「缺少 .git」而非「不在可卸载的根目录下」', async () => {
    const {roots} = await seedRepos()
    const repoDir = path.join(roots.skillsPublic, 'sk1')
    // discover 只认含 .git 的目录，故先 discover 再摘掉 .git，制造「注册表已知但目录已非仓库」
    fs.rmSync(path.join(repoDir, '.git'), {recursive: true, force: true})
    registerRepoIPC()

    const result = await uninstallHandler()({}, 'g/sk1')
    expect(result.success).toBe(false)
    expect(result.error).toBe(`仓库目录缺少 .git: ${repoDir}`)
  })
})

describe('repo:uninstall — 装配 deps', () => {
  it('键集合逐字等于 Task 6 的 UninstallDeps（多一个少一个都算违约）', async () => {
    registerRepoIPC()
    h.uninstallSpy = vi.fn(async () => ({success: true, removed: {skills: 0, agents: 0}}))

    const result = await uninstallHandler()({}, 'g/x')
    expect(result).toEqual({success: true, removed: {skills: 0, agents: 0}})

    const spy = h.uninstallSpy as unknown as {mock: {calls: any[][]}}
    expect(spy.mock.calls).toHaveLength(1)
    const [repoId, deps] = spy.mock.calls[0]
    expect(repoId).toBe('g/x')
    expect(Object.keys(deps).slice().sort()).toEqual(EXPECTED_DEP_KEYS.slice().sort())
  })

  it('deps 里函数引用直接来自 ipc 模块作用域（含 getRepo/discoverRepos），非占位实现', async () => {
    registerRepoIPC()
    h.uninstallSpy = vi.fn(async () => ({success: true}))
    await uninstallHandler()({}, 'g/x')

    const spy = h.uninstallSpy as unknown as {mock: {calls: any[][]}}
    const deps = spy.mock.calls[0][1]
    for (const key of EXPECTED_DEP_KEYS) expect(deps[key], `${key} 缺失`).toBeDefined()
    expect(deps.roots.skillsPublic).toBe(path.join(TEST_HCLAW_DIR, 'skills', 'public'))
    expect(deps.roots.agents).toBe(path.join(TEST_HCLAW_DIR, 'agents'))
    expect(deps.getRepo('g/x')).toBeUndefined() // 真实 repoRegistry.get（本例未 seed）
  })

  it('装配形态：deps 三个 void 回调可调用且当前返回非 Promise（探针打在桩上，真实同步性见下一条）', async () => {
    registerRepoIPC()
    h.uninstallSpy = vi.fn(async () => ({success: true}))
    await uninstallHandler()({}, 'g/x')

    const spy = h.uninstallSpy as unknown as {mock: {calls: any[][]}}
    const deps = spy.mock.calls[0][1]

    // 本条只验证装配形态（键存在、引用可调用、装配的是 ipc 作用域内的函数），
    // 对「真实实现是否同步」**没有**约束力：deleteSkillOverrides 来自 CJS 桩
    // （`module.exports = {deleteSkillOverrides: () => undefined}`）、broadcastMeta
    // 展开后调用的是被 vi.mock 掉的 windowBroadcast —— 桩自己返回 undefined，
    // 即便未来真实实现变成 async，这三行也永远绿。TS 同样拦不住（`(): void` 允许
    // 赋入返回 Promise 的函数）。真实同步性由下一条用例直取真实模块保证。
    expect(deps.deleteSkillOverrides([])).toBeUndefined()
    expect(deps.dropVersionCache('g/x')).toBeUndefined()
    expect(deps.broadcastMeta()).toBeUndefined()
    expect(h.broadcasts[h.broadcasts.length - 1]?.channel).toBe('repo:status-update')
  })

  it('三个 void 契约的真实实现同步：直取真实模块 → 返回 undefined 且非 Promise', async () => {
    // 绕过本文件的 CJS 桩（Module._resolveFilename 劫持）与 vi.mock（windowBroadcast）：
    // 走 vitest 的 ESM 解析直接 import 真实实现，这才是核心风险的保证 —— 若任一实现
    // 变成 async，其 rejection 会绕过 uninstaller 的 try/catch 成为 unhandled rejection。
    const {deleteSkillOverrides} = await vi.importActual<typeof import('@/main/agent/skills/loader')>('@/main/agent/skills/loader')
    const {repoVersionManager} = await vi.importActual<typeof import('@/main/repo/versionManager')>('@/main/repo/versionManager')
    const {broadcastToAllWindows} = await vi.importActual<typeof import('@/main/utils/windowBroadcast')>('@/main/utils/windowBroadcast')

    // 入参均为无副作用形态：空 id 列表（no-op 守卫，不碰数据库）、未缓存的 repoId
    // （只删内存 Map）、无窗口（本文件 BrowserWindow 桩为 getAllWindows: () => []）。
    const probes: Array<[string, unknown]> = [
      ['deleteSkillOverrides([])', deleteSkillOverrides([])],
      ["repoVersionManager.drop('x')", repoVersionManager.drop('x')],
      ["broadcastToAllWindows('repo:status-update', {})", broadcastToAllWindows('repo:status-update', {})],
    ]
    for (const [label, value] of probes) {
      expect(value instanceof Promise, `${label} 不得返回 Promise（rejection 会绕过 uninstaller 的 try/catch）`).toBe(false)
      expect(value, `${label} 应返回 undefined`).toBeUndefined()
    }
  })
})
