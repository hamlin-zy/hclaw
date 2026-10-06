/**
 * capabilitySignal + refreshRepoMeta — 能力开关 → 红点派生 的刷新链路契约
 *
 * 链路：能力开关 handler（skills/agents IPC）→ notifyCapabilityStateChanged()
 *      → 监听器（repo 侧注册）→ refreshRepoMeta() → 内存重算 capabilities + 广播 repo:status-update
 *
 * 三条不变量：
 *   1. 信号模块是零 import 的叶子（避免 skills/agents 与 repo 之间形成环）；
 *   2. handler 里 notify 必须严格晚于 `await powerManager.refresh()` —— 否则重算读到的是旧启用态；
 *   3. 轻量刷新不重新 discover（discover 会为每个仓库跑一次 git getRemotes）：只内存重算 + 广播，
 *      并发调用复用在途 promise，不重入。
 *
 * 隔离：config/hclawPaths 指向系统临时目录，sqlite / powerManager / 各注册表全部打桩，
 *       不触碰真实 ~/.hclaw，不跑真实 git。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  /** 调用顺序探针：refresh / notify 谁先谁后 */
  order: [] as string[],
  /** ipcMain.handle 捕获的通道 → handler */
  handlers: new Map<string, (e: unknown, ...args: any[]) => unknown>(),
  /** 打桩的技能注册表内容 */
  skills: [] as any[],
  /** 打桩的 agentLoader.findAgentFile 返回值 */
  agentFile: '',
  /** broadcastToAllWindows 捕获的广播 */
  broadcasts: [] as Array<{channel: string; payload: unknown}>,
  /** repoVersionManager.versionMap 的替身：id → info，getAllVersionMeta 的唯一数据源 */
  versions: new Map<string, unknown>(),
  /** warmCache 调用记录 */
  warmCalls: [] as Array<{id: string; path: string}>,
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
  const testDir = pathMod.join(osMod.tmpdir(), 'hclaw-test-capability-signal')
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
    refresh: async () => { h.order.push('refresh') },
    isInitialized: () => true,
    hasLoadedOnce: () => true,
    whenInitialized: async () => {},
  },
}))

vi.mock('@/main/agent/skills', () => ({
  skillRegistry: {
    getAll: () => h.skills,
    get: (id: string) => h.skills.find(s => s.id === id),
    unregister: () => {},
  },
}))

vi.mock('@/main/agent/skills/loader', () => ({
  serializeSkills: (list: unknown[]) => list,
  writeSkillOverride: () => {},
  writeSkillOverrides: () => {},
  getAndClearLoadErrors: () => [],
}))

vi.mock('@/main/agent/agentRegistry', () => ({
  agentRegistry: {getAll: () => []},
}))

vi.mock('@/main/plugin/registry', () => ({
  PluginRegistry: {getInstance: () => ({getAll: () => []})},
}))

vi.mock('@/main/agent/agentLoader', () => ({
  findAgentFile: async () => h.agentFile,
  scanAllAgents: async () => [],
  updatePluginAgentOverride: async () => {},
}))

vi.mock('@/main/agent/agentLoadErrors', () => ({
  getAndClearAgentLoadErrors: () => [],
}))

vi.mock('@/main/utils/windowBroadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { h.broadcasts.push({channel, payload}) },
  broadcastToOtherWindows: () => {},
}))

vi.mock('@/main/repo/versionManager', () => ({
  repoVersionManager: {
    // 广播载荷与版本缓存同源：补 warmCache 后 payload 才会多出该仓库（红点恢复的判据）
    getAllVersionMeta: () => Object.fromEntries(h.versions),
    getVersions: (id: string) => h.versions.get(id),
    warmCache: async (id: string, repoPath: string) => {
      h.warmCalls.push({id, path: repoPath})
      const info = {tags: [], branches: [], latest: '', current: 'HEAD', hasUpdate: false}
      h.versions.set(id, info)
      return info
    },
    prune: () => {},
    startupCheck: async () => ({}),
    drop: () => {},
  },
}))

vi.mock('@/main/repo/installer', () => ({
  installRepo: async () => ({success: true}),
}))

import {
  clearCapabilityStateListener,
  notifyCapabilityStateChanged,
  setCapabilityStateListener,
} from '@/main/repo/capabilitySignal'
import {refreshRepoMeta, registerRepoIPC} from '@/main/repo/ipc'
import {repoRegistry} from '@/main/repo/registry'
import {registerHandlers as registerSkillHandlers} from '@/main/agent/ipc/skills'
import {registerHandlers as registerAgentHandlers} from '@/main/agent/ipc/agents'

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-signal-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

/** 版本缓存基线：仅 obra/x 有条目（对照「全禁用仓库在启动时被跳过 → 无条目」） */
function resetVersionState(): void {
  h.versions = new Map([['obra/x', {current: 'v1', latest: 'v2', hasUpdate: true}]])
  h.warmCalls.length = 0
}

describe('capabilitySignal — 模块级监听器契约', () => {
  afterEach(() => { clearCapabilityStateListener() })

  it('未注册监听器时 notify resolve 且不抛', async () => {
    clearCapabilityStateListener()
    await expect(notifyCapabilityStateChanged()).resolves.toBeUndefined()
  })

  it('set 后 notify 调用监听器一次', async () => {
    const fn = vi.fn()
    setCapabilityStateListener(fn)
    await notifyCapabilityStateChanged()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('重复 set 覆盖旧监听器（旧的不再被调用）', async () => {
    const oldFn = vi.fn()
    const newFn = vi.fn()
    setCapabilityStateListener(oldFn)
    setCapabilityStateListener(newFn)
    await notifyCapabilityStateChanged()
    expect(oldFn).not.toHaveBeenCalled()
    expect(newFn).toHaveBeenCalledTimes(1)
  })

  it('clearCapabilityStateListener 后 notify 不再触发（测试隔离契约）', async () => {
    const fn = vi.fn()
    setCapabilityStateListener(fn)
    clearCapabilityStateListener()
    await notifyCapabilityStateChanged()
    expect(fn).not.toHaveBeenCalled()
  })

  it('异步监听器：notify 返回的 promise 等到其完成才 resolve', async () => {
    const done: string[] = []
    setCapabilityStateListener(async () => {
      await Promise.resolve()
      done.push('listener-done')
    })
    await notifyCapabilityStateChanged()
    expect(done).toEqual(['listener-done'])
  })
})

describe('refreshRepoMeta — 轻量刷新（不 discover / 在途复用）', () => {
  beforeEach(() => {
    h.order.length = 0
    h.broadcasts.length = 0
    h.skills = []
    resetVersionState()
    repoRegistry.clear()
    clearCapabilityStateListener()
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('不调用 discover，只广播 repo:status-update', async () => {
    const discoverSpy = vi.spyOn(repoRegistry, 'discover')
    await refreshRepoMeta(() => ({skills: [], agents: [], plugins: []}))
    expect(discoverSpy).not.toHaveBeenCalled()
    expect(h.broadcasts).toEqual([
      {channel: 'repo:status-update', payload: {'obra/x': {current: 'v1', latest: 'v2', hasUpdate: true}}},
    ])
  })

  it('registerRepoIPC 接线：notify → 注入的采集器 → 真实重算 + 广播 repo:status-update', async () => {
    // 真实仓库 + 仓库内技能，用于验证「重算真的发生」（能力被禁用后 hasEnabledCapability 翻转）
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-wire-'))
    const skillDir = path.join(base, 'skills', 'public', 'gsap@source', 'skill1')
    fs.mkdirSync(path.join(base, 'skills', 'public', 'gsap@source', '.git'), {recursive: true})
    fs.mkdirSync(skillDir, {recursive: true})
    const roots = {
      plugins: path.join(base, 'plugins'),
      skillsPublic: path.join(base, 'skills', 'public'),
      agents: path.join(base, 'agents'),
    }
    const origin = async () => ({origin: 'https://github.com/g/g.git', owner: 'g', name: 'gsap-skills', source: 'github' as const})
    await repoRegistry.discover(origin, {roots, skills: [{id: 's1', dir: skillDir, enabled: true}]})
    const repoId = 'g/gsap-skills'
    expect(repoRegistry.getAll().find(r => r.id === repoId)!.hasEnabledCapability).toBe(true)

    // 注入的采集器从打桩后的注册表取真实数据（技能已被禁用）
    h.skills = [{id: 's1', skillDir, enabled: false}]
    const collect = vi.fn(() => ({
      skills: h.skills.map(s => ({id: s.id, dir: s.skillDir, enabled: s.enabled})),
      agents: [],
      plugins: [],
    }))

    const refreshSpy = vi.spyOn(repoRegistry, 'refreshCapabilities')
    const discoverSpy = vi.spyOn(repoRegistry, 'discover')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    registerRepoIPC(collect)
    await expect(notifyCapabilityStateChanged()).resolves.toBeUndefined()

    expect(collect).toHaveBeenCalledTimes(1) // 监听器真的走了接线处的采集器
    expect(refreshSpy).toHaveBeenCalledTimes(1) // 重算真的发生
    expect(refreshSpy.mock.calls[0][0]).toEqual({skills: [{id: 's1', dir: skillDir, enabled: false}], agents: [], plugins: []})
    expect(repoRegistry.getAll().find(r => r.id === repoId)!.hasEnabledCapability).toBe(false)
    expect(discoverSpy).not.toHaveBeenCalled() // 不重读 git remote
    expect(h.broadcasts).toEqual([
      {channel: 'repo:status-update', payload: {'obra/x': {current: 'v1', latest: 'v2', hasUpdate: true}}},
    ])
    expect(warnSpy).not.toHaveBeenCalled() // 成功路径不留失败日志
  })

  it('启动时因全禁用被跳过的仓库：重新启用后补 warmCache，广播 payload 含该仓库（红点恢复）', async () => {
    // 场景：该仓库「上次会话就全部禁用」，本次启动时 startupCheck 跳过它（不写版本条目）
    // → versionMap 里没有它的条目。用户重新启用一个能力后，若只做「重算 + 广播」，
    // 广播出的 meta 仍缺这个仓库 → 仓库 tab 与卡片红点都不恢复。
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-warm-'))
    const skillDir = path.join(base, 'skills', 'public', 'gsap@source', 'skill1')
    fs.mkdirSync(path.join(base, 'skills', 'public', 'gsap@source', '.git'), {recursive: true})
    fs.mkdirSync(skillDir, {recursive: true})
    const roots = {
      plugins: path.join(base, 'plugins'),
      skillsPublic: path.join(base, 'skills', 'public'),
      agents: path.join(base, 'agents'),
    }
    const origin = async () => ({origin: 'https://github.com/g/g.git', owner: 'g', name: 'gsap-skills', source: 'github' as const})
    await repoRegistry.discover(origin, {roots, skills: [{id: 's1', dir: skillDir, enabled: false}]})
    const repoId = 'g/gsap-skills'
    const repoPath = path.join(base, 'skills', 'public', 'gsap@source')
    expect(repoRegistry.get(repoId)!.hasEnabledCapability).toBe(false)
    expect(h.versions.has(repoId)).toBe(false) // 启动跳过 → 无版本条目
    expect(h.warmCalls).toEqual([])

    // 重新启用其中一个能力 → 走真实的 notify 链路
    registerRepoIPC(() => ({skills: [{id: 's1', dir: skillDir, enabled: true}], agents: [], plugins: []}))
    await expect(notifyCapabilityStateChanged()).resolves.toBeUndefined()

    expect(repoRegistry.get(repoId)!.hasEnabledCapability).toBe(true)
    expect(h.warmCalls).toEqual([{id: repoId, path: repoPath}]) // 补缓存只补缺条目的仓库
    const payload = h.broadcasts[h.broadcasts.length - 1].payload as Record<string, unknown>
    expect(Object.keys(payload)).toContain(repoId) // 红点恢复的判据：广播里必须有它
  })

  it('失败路径（warn 探针）：采集器抛错 → 记 repo-meta-refresh-failed、不广播、不外抛', async () => {
    registerRepoIPC(() => { throw new Error('collect boom') })
    const discoverSpy = vi.spyOn(repoRegistry, 'discover')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(notifyCapabilityStateChanged()).resolves.toBeUndefined()
    expect(h.broadcasts).toHaveLength(0)
    expect(discoverSpy).not.toHaveBeenCalled()
    // 区分力：监听器没接上时 notify 无任何副作用；接上才会走进 refreshRepoMeta 的 catch
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('repo-meta-refresh-failed')
  })

  it('源码契约：registerRepoIPC 在接线处注入采集器，默认仍为真实采集，刷新体不含 discover', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/main/repo/ipc.ts'), 'utf-8')
    expect(src).toContain('setCapabilityStateListener(() => refreshRepoMeta(collect))')
    expect(src).toContain('collect: CapabilityInputCollector = collectCapabilityInputs')
    // 按符号定位刷新体：从 refreshRepoMeta 声明到其后第一个文档块（即下一个函数的 docstring）为止，
    // 避免把后续函数（initializeRepoSystem）的注释误当成本函数体。
    const start = src.indexOf('export function refreshRepoMeta')
    const body = src.slice(start, src.indexOf('/**', start))
    expect(body).toContain("broadcastToAllWindows('repo:status-update'")
    expect(body).not.toContain('discover')
  })

  it('并发调用复用在途 promise（不并发重入）', async () => {
    const refreshSpy = vi.spyOn(repoRegistry, 'refreshCapabilities')
    const inputs = () => ({skills: [], agents: [], plugins: []})
    const p1 = refreshRepoMeta(inputs)
    const p2 = refreshRepoMeta(inputs)
    expect(p1).toBe(p2)
    await p1
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('重算抛错时不外抛（仅记日志），在途变量清空后后续调用仍可刷新', async () => {
    const inputs = () => ({skills: [], agents: [], plugins: []})
    const spy = vi.spyOn(repoRegistry, 'refreshCapabilities').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(refreshRepoMeta(inputs)).resolves.toBeUndefined()
    expect(h.broadcasts).toHaveLength(0)
    await expect(refreshRepoMeta(inputs)).resolves.toBeUndefined()
    expect(h.broadcasts).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('refreshCapabilities 内存重算能力派生（技能全禁用 → hasEnabledCapability=false）', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-refresh-'))
    const skillDir = path.join(base, 'skills', 'public', 'gsap@source', 'skill1')
    fs.mkdirSync(path.join(base, 'skills', 'public', 'gsap@source', '.git'), {recursive: true})
    fs.mkdirSync(skillDir, {recursive: true})

    const roots = {
      plugins: path.join(base, 'plugins'),
      skillsPublic: path.join(base, 'skills', 'public'),
      agents: path.join(base, 'agents'),
    }
    const origin = async () => ({origin: 'https://github.com/g/g.git', owner: 'g', name: 'gsap-skills', source: 'github' as const})

    await repoRegistry.discover(origin, {roots, skills: [{id: 's1', dir: skillDir, enabled: true}]})
    expect(repoRegistry.getAll().find(r => r.id === 'g/gsap-skills')!.hasEnabledCapability).toBe(true)

    const discoverSpy = vi.spyOn(repoRegistry, 'discover')
    const repos = repoRegistry.refreshCapabilities({skills: [{id: 's1', dir: skillDir, enabled: false}], agents: [], plugins: []})

    expect(discoverSpy).not.toHaveBeenCalled()
    expect(repos.find(r => r.id === 'g/gsap-skills')!.hasEnabledCapability).toBe(false)
    // 仓库边界（path / id）不因能力开关而变
    expect(repos.find(r => r.id === 'g/gsap-skills')!.path).toBe(path.join(base, 'skills', 'public', 'gsap@source'))
  })
})

describe('能力开关触发点 — notify 必须严格晚于 refresh', () => {
  const call = (channel: string, ...args: unknown[]) =>
    h.handlers.get(channel)!(null, ...args) as Promise<Record<string, unknown>>

  beforeEach(() => {
    h.order.length = 0
    h.broadcasts.length = 0
    h.handlers.clear()
    h.agentFile = ''
    h.skills = []
    resetVersionState()
    repoRegistry.clear()

    registerSkillHandlers()
    registerAgentHandlers()
    registerRepoIPC() // 内部注册 repo 侧监听器
    // 覆盖为顺序探针（信号模块为单监听器，最后 set 者生效）
    setCapabilityStateListener(() => { h.order.push('notify') })
  })

  afterEach(() => { clearCapabilityStateListener() })

  it('skill-toggle：await refreshAndRespond 之后才 notify', async () => {
    h.skills = [{id: 's1', filePath: 'C:\\tmp\\s\\SKILL.md', enabled: true}]
    const result = await call('skill-toggle', 's1')
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh', 'notify'])
  })

  it('skill-toggle-batch：await powerManager.refresh 之后才 notify', async () => {
    const result = await call('skill-toggle-batch', {skillIds: ['s1', 's2'], enabled: false})
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh', 'notify'])
  })

  it('skill-remove：notify 之后才 attemptDelete（不在 refresh 之前通知）', async () => {
    const gone = path.join(os.tmpdir(), 'cap-signal-gone-' + Date.now(), 'SKILL.md')
    h.skills = [{id: 's1', filePath: gone, enabled: true}]
    const result = await call('skill-remove', 's1')
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh', 'notify'])
  })

  it('agents:delete：await powerManager.refresh 之后才 notify', async () => {
    h.agentFile = tmpFile('agent.md', '---\nname: x\nenabled: false\n---\nbody')
    const result = await call('agents:delete', 'local-x')
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh', 'notify'])
  })

  it('agents:update（带 enabled）：await powerManager.refresh 之后才 notify', async () => {
    const result = await call('agents:update', 'local-x', {enabled: false})
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh', 'notify'])
  })

  it('agents:update（只改 description）：不 notify（启用态未变，无需重算红点）', async () => {
    h.agentFile = tmpFile('agent.md', '---\nname: x\ndescription: 旧\n---\nbody')
    const result = await call('agents:update', 'local-x', {description: '新描述'})
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh'])
  })

  it('agents:toggle-batch：await powerManager.refresh 之后才 notify', async () => {
    const result = await call('agents:toggle-batch', {templateIds: ['local-a', 'local-b'], enabled: false})
    expect(result.success).toBe(true)
    expect(h.order).toEqual(['refresh', 'notify'])
  })
})
