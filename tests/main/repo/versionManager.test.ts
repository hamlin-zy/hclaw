import {beforeEach, describe, expect, it, vi} from 'vitest'
import {repoVersionManager} from '@/main/repo/versionManager'

const mockState = vi.hoisted(() => ({
  tags: [] as string[], branches: [] as string[], currentRef: '',
  listTagsError: null as Error | null,
  checkoutRefResult: {success: true} as {success: boolean; error?: string},
  refreshCalls: 0,
  registryRepos: new Map<string, Record<string, any>>(),
}))

vi.mock('@/main/plugin/installer', () => {
  class MockInstaller {
    async fetchTags() {}
    async listTags() { if (mockState.listTagsError) throw mockState.listTagsError; return mockState.tags }
    async listBranches() { return mockState.branches }
    async getCurrentRef() { return mockState.currentRef }
    async checkoutRef() { return mockState.checkoutRefResult }
  }
  return {PluginInstaller: MockInstaller}
})

vi.mock('@/main/repo/registry', () => ({
  repoRegistry: {
    get: (id: string) => mockState.registryRepos.get(id),
    getByPath: () => undefined,
  },
}))

vi.mock('@/main/agent/powerManager', () => ({
  powerManager: { async refresh() { mockState.refreshCalls += 1 } },
}))

async function collect(p: string) { return (repoVersionManager as any).collectVersionInfo(p) }

beforeEach(() => {
  mockState.tags = []; mockState.branches = []; mockState.currentRef = ''
  mockState.listTagsError = null; mockState.checkoutRefResult = {success: true}
  mockState.refreshCalls = 0; mockState.registryRepos.clear()
  ;(repoVersionManager as any).versionMap.clear()
})

describe('startupCheck — 插件仓库不混入 repo 红点', () => {
  it('rootType=plugin 的仓库被跳过', async () => {
    mockState.tags = ['v2.0.0', 'v1.0.0']; mockState.currentRef = 'v1.0.0'
    const repos = [
      {id: 'greensock/gsap-skills', source: 'github', path: '/tmp/gsap', hasManifest: false, rootType: 'skill' as const, capabilities: {plugins: [], skills: [], agents: []}, owner: 'greensock', name: 'gsap-skills', origin: '', enabled: true},
      {id: 'heygen-com/hyperframes', source: 'github', path: '/tmp/hf', hasManifest: true, rootType: 'plugin' as const, capabilities: {plugins: [], skills: [], agents: []}, owner: 'heygen-com', name: 'hyperframes', origin: '', enabled: true},
    ]
    await repoVersionManager.startupCheck(repos as any)
    const meta = repoVersionManager.getAllVersionMeta()
    expect(meta['greensock/gsap-skills']).toBeDefined()
    expect(meta['heygen-com/hyperframes']).toBeUndefined()
  })
})

describe('collectVersionInfo', () => {
  it('current === latest → 无更新', async () => {
    mockState.tags = ['v1.0.0']; mockState.currentRef = 'v1.0.0'
    const info = await collect('/tmp/r')
    expect(info.hasUpdate).toBe(false)
  })
  it('current 低于 latest → 有更新', async () => {
    mockState.tags = ['v2.0.0', 'v1.0.0']; mockState.currentRef = 'v1.0.0'
    const info = await collect('/tmp/r')
    expect(info.hasUpdate).toBe(true); expect(info.latest).toBe('v2.0.0')
  })
  it('v 前缀归一化匹配 current', async () => {
    mockState.tags = ['v1.0.0']; mockState.currentRef = '1.0.0'
    const info = await collect('/tmp/r')
    expect(info.current).toBe('v1.0.0')
  })
  it('tags 为空 → 分支用于下拉，current=HEAD 兜底', async () => {
    mockState.tags = []; mockState.branches = ['main', 'dev']; mockState.currentRef = ''
    const info = await collect('/tmp/r')
    expect(info.branches).toEqual(['main', 'dev']); expect(info.current).toBe('HEAD'); expect(info.hasUpdate).toBe(false)
  })
})

describe('switchVersion', () => {
  it('仓库不存在 → 失败', async () => {
    const r = await repoVersionManager.switchVersion('nope', 'v1')
    expect(r.success).toBe(false)
  })
  it('local 仓库 → 拒绝切换', async () => {
    mockState.registryRepos.set('loc', {id: 'loc', source: 'local', path: '/tmp/loc', hasManifest: false, rootType: 'skill'})
    const r = await repoVersionManager.switchVersion('loc', 'v1')
    expect(r.success).toBe(false)
  })
  it('切换成功 → refresh + 更新缓存', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true, rootType: 'skill'})
    mockState.tags = ['v2.0.0']; mockState.currentRef = 'v2.0.0'
    const r = await repoVersionManager.switchVersion('obra/x', 'v2.0.0')
    expect(r.success).toBe(true)
    expect(mockState.refreshCalls).toBe(1)
    expect(r.versionInfo!.current).toBe('v2.0.0'); expect(r.versionInfo!.hasUpdate).toBe(false)
    expect(repoVersionManager.getVersions('obra/x')).toBe(r.versionInfo)
  })
  it('checkout 失败 → 不 refresh', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true, rootType: 'skill'})
    mockState.checkoutRefResult = {success: false, error: 'conflict'}
    const r = await repoVersionManager.switchVersion('obra/x', 'v1')
    expect(r.success).toBe(false); expect(mockState.refreshCalls).toBe(0)
  })
})

describe('syncVersions / getAllVersionMeta', () => {
  it('syncVersions 成功后缓存', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true, rootType: 'skill'})
    mockState.tags = ['v2.0.0', 'v1.0.0']; mockState.currentRef = 'v1.0.0'
    const info = await repoVersionManager.syncVersions('obra/x')
    expect(info!.hasUpdate).toBe(true)
  })
  it('getAllVersionMeta 只含红点字段', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true, rootType: 'skill'})
    mockState.tags = ['v2.0.0', 'v1.0.0']; mockState.currentRef = 'v1.0.0'
    await repoVersionManager.syncVersions('obra/x')
    expect(repoVersionManager.getAllVersionMeta()['obra/x']).toEqual({current: 'v1.0.0', latest: 'v2.0.0', hasUpdate: true})
  })
})

describe('插件仓库被所有方法一致排除', () => {
  it('warmCache 跳过 plugin 仓库', async () => {
    mockState.registryRepos.set('heygen/hf', {id: 'heygen/hf', source: 'github', path: '/tmp/hf', hasManifest: true, rootType: 'plugin'})
    mockState.tags = ['v0.8.27']; mockState.currentRef = 'main'
    const info = await repoVersionManager.warmCache('heygen/hf', '/tmp/hf')
    expect(info.hasUpdate).toBe(false)
    // 不应进入 versionMap
    expect(repoVersionManager.getVersions('heygen/hf')).toBeUndefined()
  })
  it('syncVersions 跳过 plugin 仓库', async () => {
    mockState.registryRepos.set('heygen/hf', {id: 'heygen/hf', source: 'github', path: '/tmp/hf', hasManifest: true, rootType: 'plugin'})
    mockState.tags = ['v0.8.27']; mockState.currentRef = 'main'
    const info = await repoVersionManager.syncVersions('heygen/hf')
    expect(info).toBeNull()
  })
  it('switchVersion 拒绝 plugin 仓库', async () => {
    mockState.registryRepos.set('heygen/hf', {id: 'heygen/hf', source: 'github', path: '/tmp/hf', hasManifest: true, rootType: 'plugin'})
    const r = await repoVersionManager.switchVersion('heygen/hf', 'v0.8.27')
    expect(r.success).toBe(false)
    expect(mockState.refreshCalls).toBe(0)
  })
  it('getAllVersionMeta 排除 plugin 仓库即使混入 versionMap', async () => {
    // 模拟旧版本代码将 plugin 仓库写入 versionMap 的场景
    ;(repoVersionManager as any).versionMap.set('heygen/hf', {tags: ['v0.8.27'], branches: [], latest: 'v0.8.27', current: 'main', hasUpdate: true})
    mockState.registryRepos.set('heygen/hf', {id: 'heygen/hf', source: 'github', path: '/tmp/hf', hasManifest: true, rootType: 'plugin'})
    // 同时有一条正常的 skill 仓库
    ;(repoVersionManager as any).versionMap.set('obra/x', {tags: ['v2.0.0'], branches: [], latest: 'v2.0.0', current: 'v2.0.0', hasUpdate: false})
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true, rootType: 'skill'})
    const meta = repoVersionManager.getAllVersionMeta()
    expect(meta['heygen/hf']).toBeUndefined()
    expect(meta['obra/x']).toBeDefined()
    expect(meta['obra/x'].hasUpdate).toBe(false)
  })
})
