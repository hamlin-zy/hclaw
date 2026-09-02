// tests/main/plugin/versionManager.delegation.test.ts
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {versionManager} from '@/main/plugin/versionManager'

const mockState = vi.hoisted(() => ({
  getByPathResult: undefined as any,
  checkoutCalls: 0,
  checkoutResult: {success: true},
  fallbackUsed: 0,
}))

vi.mock('@/main/plugin/installer', () => {
  class MockInstaller {
    async checkoutRef() { mockState.fallbackUsed++; return mockState.checkoutResult }
    async fetchTags() {}
    async listTags() { return [] }
    async listBranches() { return [] }
    async getCurrentRef() { return '' }
  }
  return {PluginInstaller: MockInstaller}
})
vi.mock('@/main/repo/registry', () => ({
  repoRegistry: { getByPath: () => mockState.getByPathResult },
}))
vi.mock('@/main/repo/versionManager', () => ({
  repoVersionManager: {
    async checkoutRefForRepo() { mockState.checkoutCalls++; return mockState.checkoutResult },
  },
}))
vi.mock('@/main/plugin/registry', () => ({
  PluginRegistry: class { static getInstance() { return { get: (n: string) => (mockState as any)[`plugin_${n}`], getAll: () => [] } } },
}))
vi.mock('@/main/plugin/loader', () => ({
  PluginLoader: class { async loadPlugin() { return {manifest: {version: '9.9.9'}} } },
}))
vi.mock('@/main/agent/powerManager', () => ({ powerManager: { async refresh() {} } }))

beforeEach(() => {
  mockState.getByPathResult = undefined
  mockState.checkoutCalls = 0
  mockState.fallbackUsed = 0
  mockState.checkoutResult = {success: true}
})

describe('PluginVersionManager 委托', () => {
  it('仓库可被发现 → 走 repoVersionManager.checkoutRefForRepo', async () => {
    ;(mockState as any).plugin_demo = {name: 'demo', source: 'github', path: '/tmp/p', enabled: true, manifest: {name: 'demo', version: '1.0.0'}}
    mockState.getByPathResult = {id: 'obra/demo', path: '/tmp/p', source: 'github', capabilities: {plugins: [], skills: [], agents: []}, hasManifest: true, enabled: true}
    const r = await versionManager.switchVersion('demo', 'v2.0.0')
    expect(mockState.checkoutCalls).toBe(1)
    expect(mockState.fallbackUsed).toBe(0)
    expect(r.success).toBe(true)
  })
  it('仓库不可被发现 → 回退 installer.checkoutRef', async () => {
    ;(mockState as any).plugin_demo = {name: 'demo', source: 'github', path: '/tmp/p', enabled: true, manifest: {name: 'demo', version: '1.0.0'}}
    mockState.getByPathResult = undefined
    const r = await versionManager.switchVersion('demo', 'v2.0.0')
    expect(mockState.fallbackUsed).toBe(1)
    expect(mockState.checkoutCalls).toBe(0)
    expect(r.success).toBe(true)
  })
})
