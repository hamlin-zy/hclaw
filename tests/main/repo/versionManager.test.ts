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
    mockState.registryRepos.set('loc', {id: 'loc', source: 'local', path: '/tmp/loc', hasManifest: false})
    const r = await repoVersionManager.switchVersion('loc', 'v1')
    expect(r.success).toBe(false)
  })
  it('切换成功 → refresh + 更新缓存', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true})
    mockState.tags = ['v2.0.0']; mockState.currentRef = 'v2.0.0'
    const r = await repoVersionManager.switchVersion('obra/x', 'v2.0.0')
    expect(r.success).toBe(true)
    expect(mockState.refreshCalls).toBe(1)
    expect(r.versionInfo!.current).toBe('v2.0.0'); expect(r.versionInfo!.hasUpdate).toBe(false)
    expect(repoVersionManager.getVersions('obra/x')).toBe(r.versionInfo)
  })
  it('checkout 失败 → 不 refresh', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true})
    mockState.checkoutRefResult = {success: false, error: 'conflict'}
    const r = await repoVersionManager.switchVersion('obra/x', 'v1')
    expect(r.success).toBe(false); expect(mockState.refreshCalls).toBe(0)
  })
})

describe('syncVersions / getAllVersionMeta', () => {
  it('syncVersions 成功后缓存', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true})
    mockState.tags = ['v2.0.0', 'v1.0.0']; mockState.currentRef = 'v1.0.0'
    const info = await repoVersionManager.syncVersions('obra/x')
    expect(info!.hasUpdate).toBe(true)
  })
  it('getAllVersionMeta 只含红点字段', async () => {
    mockState.registryRepos.set('obra/x', {id: 'obra/x', source: 'github', path: '/tmp/r', hasManifest: true})
    mockState.tags = ['v2.0.0', 'v1.0.0']; mockState.currentRef = 'v1.0.0'
    await repoVersionManager.syncVersions('obra/x')
    expect(repoVersionManager.getAllVersionMeta()['obra/x']).toEqual({current: 'v1.0.0', latest: 'v2.0.0', hasUpdate: true})
  })
})
