/**
 * PluginVersionManager 单元测试
 *
 * 覆盖插件版本管理核心逻辑：
 *   1. 版本信息收集（tag 前缀过滤、v 前缀归一化、latest/hasUpdate 判定）
 *   2. 升级判断（hasUpdate：纯字符串比较，不依赖 semver 解析）
 *   3. 版本切换决策（插件不存在 / 本地插件拒绝 / checkout 失败 / 成功）
 *   4. 缓存行为（warmCache 成功与失败 fallback、getVersions/exportMap/getAllVersionMeta）
 *   5. 同步与启动检查（syncVersions / startupCheck）
 *
 * 说明：versionManager 内部依赖 installer（真实 git 命令）、PluginRegistry 与
 * powerManager，这里全部 mock 隔离，仅验证模块自身的版本管理逻辑。
 * 注意：versionManager 的升级判断是「current !== latest」的字符串比较，
 * 与 updater/compareVersions.ts 的 semver 比较不同，此处不重复测 semver。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {versionManager} from '@/main/plugin/versionManager'

// ── 共享 mock 状态（hoisted，供 vi.mock factory 使用） ──────────────────
const mockState = vi.hoisted(() => ({
  // installer 行为
  tags: [] as string[],
  branches: [] as string[],
  currentRef: '',
  fetchTagsError: null as Error | null,
  listTagsError: null as Error | null,
  currentRefError: null as Error | null,
  checkoutRefResult: {success: true} as {success: boolean; error?: string},
  checkoutRefError: null as Error | null,
  // loader / powerManager
  reloadManifestVersion: '9.9.9',
  refreshCalls: 0,
  // registry
  registryPlugins: new Map<string, Record<string, any>>(),
}))

vi.mock('@/main/plugin/installer', () => {
  class MockPluginInstaller {
    async fetchTags(): Promise<void> {
      if (mockState.fetchTagsError) throw mockState.fetchTagsError
    }
    async listTags(): Promise<string[]> {
      if (mockState.listTagsError) throw mockState.listTagsError
      return mockState.tags
    }
    async listBranches(): Promise<string[]> {
      return mockState.branches
    }
    async getCurrentRef(): Promise<string> {
      if (mockState.currentRefError) throw mockState.currentRefError
      return mockState.currentRef
    }
    async checkoutRef(): Promise<{success: boolean; error?: string}> {
      if (mockState.checkoutRefError) throw mockState.checkoutRefError
      return mockState.checkoutRefResult
    }
  }
  return {PluginInstaller: MockPluginInstaller}
})

vi.mock('@/main/plugin/registry', () => {
  class MockRegistry {
    private static instance: MockRegistry | undefined
    static getInstance(): MockRegistry {
      if (!MockRegistry.instance) MockRegistry.instance = new MockRegistry()
      return MockRegistry.instance
    }
    get(name: string): Record<string, any> | undefined {
      return mockState.registryPlugins.get(name)
    }
    getAll(): Record<string, any>[] {
      return Array.from(mockState.registryPlugins.values())
    }
    unregister(name: string): void {
      mockState.registryPlugins.delete(name)
    }
    updateEnabled(): void {
      // no-op
    }
  }
  return {PluginRegistry: MockRegistry}
})

vi.mock('@/main/plugin/loader', () => {
  class MockPluginLoader {
    constructor(_registry: unknown) {}
    async loadPlugin(): Promise<{manifest: {version: string}}> {
      return {manifest: {version: mockState.reloadManifestVersion}}
    }
  }
  return {PluginLoader: MockPluginLoader}
})

vi.mock('@/main/agent/powerManager', () => {
  return {
    powerManager: {
      async refresh(): Promise<void> {
        mockState.refreshCalls += 1
      },
    },
  }
})

// ── 辅助函数 ──────────────────────────────────────────────────────────

function seedPlugin(name: string, source = 'github', version = '1.0.0', path = '/tmp/plugin'): void {
  mockState.registryPlugins.set(name, {
    name,
    source,
    path,
    enabled: true,
    manifest: {name, version},
  })
}

/** 直接调用私有 collectVersionInfo，验证版本收集/比较算法 */
async function collect(pluginPath: string, manifestVersion?: string) {
  return (versionManager as any).collectVersionInfo(pluginPath, manifestVersion)
}

beforeEach(() => {
  mockState.tags = []
  mockState.branches = []
  mockState.currentRef = ''
  mockState.fetchTagsError = null
  mockState.listTagsError = null
  mockState.currentRefError = null
  mockState.checkoutRefResult = {success: true}
  mockState.checkoutRefError = null
  mockState.reloadManifestVersion = '9.9.9'
  mockState.refreshCalls = 0
  mockState.registryPlugins.clear()
  ;(versionManager as any).versionMap.clear()
})

// ── 版本收集 / 升级判断 ────────────────────────────────────────────────

describe('collectVersionInfo — 升级判断（hasUpdate）', () => {
  it('current === latest → 无更新', async () => {
    mockState.tags = ['v1.0.0']
    mockState.currentRef = 'v1.0.0'
    const info = await collect('/tmp/p')
    expect(info.hasUpdate).toBe(false)
    expect(info.latest).toBe('v1.0.0')
    expect(info.current).toBe('v1.0.0')
  })

  it('current 低于 latest（tags 排序首项）→ 有更新', async () => {
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    const info = await collect('/tmp/p')
    expect(info.hasUpdate).toBe(true)
    expect(info.latest).toBe('v2.0.0')
  })

  it('current 不在 tags 中 → current 兜底为 manifest 版本对应 tag', async () => {
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'HEAD' // git 无法精确匹配
    const info = await collect('/tmp/p', '1.0.0')
    expect(info.current).toBe('v1.0.0')
    expect(info.latest).toBe('v2.0.0')
    expect(info.hasUpdate).toBe(true)
  })

  it('tags 为空 → 无更新，latest 为空串，current 兜底为 HEAD', async () => {
    mockState.tags = []
    mockState.currentRef = 'main'
    const info = await collect('/tmp/p')
    expect(info.hasUpdate).toBe(false)
    expect(info.latest).toBe('')
    expect(info.current).toBe('HEAD')
  })

  it('升级判断为纯字符串比较（不依赖 semver）：current 与 latest 字符串不等即为更新', async () => {
    // 即使 current 字符串序上更大，只要不是 tags[0]（latest），仍判定为有更新
    mockState.tags = ['v0.2.0', 'v0.10.0']
    mockState.currentRef = 'v0.10.0'
    const info = await collect('/tmp/p')
    expect(info.hasUpdate).toBe(true)
    expect(info.latest).toBe('v0.2.0')
  })
})

describe('collectVersionInfo — 版本解析边界', () => {
  it('v 前缀归一化：tag 为 v 前缀而 current 无前缀，也能匹配', async () => {
    mockState.tags = ['v1.0.0', 'v0.2.0']
    mockState.currentRef = '0.2.0'
    const info = await collect('/tmp/p')
    expect(info.current).toBe('v0.2.0')
    expect(info.hasUpdate).toBe(true)
  })

  it('单仓多组件 tag 前缀过滤（skill-v / ext-v）', async () => {
    mockState.tags = ['skill-v4.0.3', 'skill-v4.0.2', 'ext-v1.3.0', 'skill-v3.0.0']
    const info = await collect('/tmp/p', '4.0.2')
    expect(info.tags).toEqual(['skill-v4.0.3', 'skill-v4.0.2', 'skill-v3.0.0'])
    expect(info.current).toBe('skill-v4.0.2')
    expect(info.latest).toBe('skill-v4.0.3')
    expect(info.hasUpdate).toBe(true)
  })

  it('tag 无前缀可匹配 manifest 版本 → 前缀为空，不过滤', async () => {
    mockState.tags = ['1.0.0', '0.5.0']
    mockState.currentRef = '1.0.0'
    const info = await collect('/tmp/p', '1.0.0')
    expect(info.tags).toEqual(['1.0.0', '0.5.0'])
    expect(info.current).toBe('1.0.0')
    expect(info.hasUpdate).toBe(false)
  })

  it('无 tag 可匹配 manifest 版本 → 保留全部 tag，current 用 manifest 版本原文', async () => {
    mockState.tags = ['release-1', 'release-2']
    mockState.currentRef = 'HEAD'
    const info = await collect('/tmp/p', '2.0.0')
    expect(info.tags).toEqual(['release-1', 'release-2'])
    expect(info.current).toBe('2.0.0')
    expect(info.latest).toBe('release-1')
    expect(info.hasUpdate).toBe(true)
  })

  it('tags 为空时获取远程分支列表，current 兜底为 manifest 版本', async () => {
    mockState.tags = []
    mockState.branches = ['origin/main', 'origin/dev']
    mockState.currentRef = ''
    const info = await collect('/tmp/p', '1.2.3')
    expect(info.branches).toEqual(['origin/main', 'origin/dev'])
    expect(info.current).toBe('1.2.3')
    expect(info.latest).toBe('')
    expect(info.hasUpdate).toBe(false)
  })

  it('getCurrentRef 抛错 → current 兜底为 manifest 版本', async () => {
    mockState.tags = ['v1.0.0']
    mockState.currentRefError = new Error('not a git repo')
    const info = await collect('/tmp/p', '0.1.0')
    expect(info.current).toBe('0.1.0')
    expect(info.latest).toBe('v1.0.0')
    expect(info.hasUpdate).toBe(true)
  })

  it('manifest 版本缺失且 current 无法匹配 → current 为 HEAD', async () => {
    mockState.tags = ['v1.0.0']
    mockState.currentRef = 'some-branch'
    const info = await collect('/tmp/p')
    expect(info.current).toBe('HEAD')
    expect(info.hasUpdate).toBe(true)
  })
})

// ── 缓存行为 ──────────────────────────────────────────────────────────

describe('warmCache / getVersions / exportMap / getAllVersionMeta', () => {
  it('warmCache 成功收集并缓存', async () => {
    mockState.tags = ['v1.0.0']
    mockState.currentRef = 'v1.0.0'
    const info = await versionManager.warmCache('demo', '/tmp/demo', '1.0.0')
    expect(info.hasUpdate).toBe(false)
    expect(versionManager.getVersions('demo')).toBe(info)
  })

  it('warmCache 收集失败 → fallback（无 manifestVersion 时为 0.0.0）', async () => {
    mockState.listTagsError = new Error('git failed')
    const info = await versionManager.warmCache('demo', '/tmp/demo')
    expect(info).toEqual({
      tags: [],
      branches: [],
      latest: '0.0.0',
      current: '0.0.0',
      hasUpdate: false,
    })
    expect(versionManager.getVersions('demo')).toBe(info)
  })

  it('warmCache 收集失败 → fallback 使用 manifest 版本', async () => {
    mockState.listTagsError = new Error('git failed')
    const info = await versionManager.warmCache('demo', '/tmp/demo', '1.2.3')
    expect(info.latest).toBe('1.2.3')
    expect(info.current).toBe('1.2.3')
  })

  it('getVersions 缓存未命中 → undefined', () => {
    expect(versionManager.getVersions('nope')).toBeUndefined()
  })

  it('exportMap 导出全量缓存', async () => {
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    await versionManager.warmCache('a', '/tmp/a', '1.0.0')
    // b 插件单独状态：current === latest → 无更新
    mockState.tags = ['v0.5.0']
    mockState.currentRef = 'v0.5.0'
    await versionManager.warmCache('b', '/tmp/b', '0.5.0')
    const map = versionManager.exportMap()
    expect(Object.keys(map)).toEqual(['a', 'b'])
    expect(map.a!.hasUpdate).toBe(true)
    expect(map.b!.hasUpdate).toBe(false)
  })

  it('getAllVersionMeta 仅返回红点相关字段', async () => {
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    await versionManager.warmCache('a', '/tmp/a', '1.0.0')
    const meta = versionManager.getAllVersionMeta()
    expect(meta.a).toEqual({current: 'v1.0.0', latest: 'v2.0.0', hasUpdate: true})
  })
})

// ── 同步与启动检查 ────────────────────────────────────────────────────

describe('syncVersions', () => {
  it('插件不存在 → null', async () => {
    expect(await versionManager.syncVersions('ghost')).toBeNull()
  })

  it('非 git 源插件（local）→ null', async () => {
    seedPlugin('local-plugin', 'local')
    expect(await versionManager.syncVersions('local-plugin')).toBeNull()
  })

  it('git 插件同步成功 → fetch tags + 缓存 + 返回信息', async () => {
    seedPlugin('demo', 'github', '1.0.0')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    const info = await versionManager.syncVersions('demo')
    expect(info).not.toBeNull()
    expect(info!.hasUpdate).toBe(true)
    expect(versionManager.getVersions('demo')).toBe(info)
  })

  it('fetch tags 失败 → null 且不缓存', async () => {
    seedPlugin('demo', 'github')
    mockState.fetchTagsError = new Error('network down')
    expect(await versionManager.syncVersions('demo')).toBeNull()
    expect(versionManager.getVersions('demo')).toBeUndefined()
  })
})

describe('startupCheck', () => {
  it('无 git 源插件 → 返回空对象', async () => {
    seedPlugin('local-plugin', 'local')
    const result = await versionManager.startupCheck()
    expect(result).toEqual({})
  })

  it('git 插件被收集并缓存，返回 map', async () => {
    seedPlugin('a', 'github', '1.0.0')
    seedPlugin('b', 'gitee', '1.0.0')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    const result = await versionManager.startupCheck()
    expect(Object.keys(result)).toEqual(['a', 'b'])
    expect(result.a!.hasUpdate).toBe(true)
    expect(versionManager.getVersions('a')).toBe(result.a)
    expect(versionManager.getVersions('b')).toBe(result.b)
  })

  it('单个插件 fetch 失败不影响其他插件', async () => {
    seedPlugin('ok', 'github')
    seedPlugin('bad', 'github')
    mockState.fetchTagsError = new Error('boom')
    const result = await versionManager.startupCheck()
    // 两个插件都会在 Promise.all 中 catch：failed 的不缓存
    expect(result).toEqual({})
    expect(versionManager.getVersions('ok')).toBeUndefined()
  })
})

// ── 版本切换 ──────────────────────────────────────────────────────────

describe('switchVersion', () => {
  it('插件不存在 → 失败并返回错误信息', async () => {
    const result = await versionManager.switchVersion('ghost', 'v1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Plugin not found')
    expect(mockState.refreshCalls).toBe(0)
  })

  it('本地插件 → 拒绝切换', async () => {
    seedPlugin('local-plugin', 'local')
    const result = await versionManager.switchVersion('local-plugin', 'v1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Local plugins do not support')
  })

  it('checkout 失败 → 直接返回失败，不刷新 powerManager', async () => {
    seedPlugin('demo', 'github')
    mockState.checkoutRefResult = {success: false, error: 'checkout conflict'}
    const result = await versionManager.switchVersion('demo', 'v1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toBe('checkout conflict')
    expect(mockState.refreshCalls).toBe(0)
  })

  it('checkout 抛异常 → 失败并返回异常信息', async () => {
    seedPlugin('demo', 'github')
    mockState.checkoutRefError = new Error('git exploded')
    const result = await versionManager.switchVersion('demo', 'v1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toBe('git exploded')
  })

  it('切换成功 → 刷新 powerManager、重新加载 manifest、更新缓存', async () => {
    seedPlugin('demo', 'github', '1.0.0')
    mockState.tags = ['v2.0.0']
    mockState.currentRef = 'v2.0.0'
    mockState.reloadManifestVersion = '2.0.0'
    const result = await versionManager.switchVersion('demo', 'v2.0.0')
    expect(result.success).toBe(true)
    expect(mockState.refreshCalls).toBe(1)
    expect(result.versionInfo).toBeDefined()
    expect(result.versionInfo!.current).toBe('v2.0.0')
    expect(result.versionInfo!.hasUpdate).toBe(false)
    // 缓存已刷新
    expect(versionManager.getVersions('demo')).toBe(result.versionInfo)
  })
})
