/**
 * 禁用插件「不检查更新、不亮红点」契约测试。
 *
 * 边界（本次改动）：
 *   A. 启动自动检查跳过禁用插件（不 git fetchTags、不进版本缓存）；
 *      getAllVersionMeta（红点数据源）导出时排除禁用插件；
 *      用户手动「同步版本」「升级」对禁用插件仍照常可用（不改那两条路径）。
 *   B. 用户重新「启用」插件后，后台静默补查一次（git fetch + 比版本 + 广播），
 *      红点立刻回来；补查不阻塞 enable 的返回值。
 *
 * 说明：versionManager 依赖的 installer（真实 git）与 PluginRegistry 全部 mock，
 * plugin/ipc 也在此文件内注册以验证 handler 级行为（registry / installer 是同一份
 * mock 状态，因此 versionManager 与 ipc handler 看到一致的插件集合）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── 共享 mock 状态（hoisted） ──────────────────────────────────────────
const mockState = vi.hoisted(() => ({
  /** 注册表插件表：name → LoadedPlugin 形状 */
  registryPlugins: new Map<string, Record<string, any>>(),
  /** installer.fetchTags 收到的插件 path（按调用顺序） */
  fetchTagsCalls: [] as string[],
  /** 挂起门闸：非 null 时 fetchTags 会阻塞到 release() */
  fetchGate: null as null | {promise: Promise<void>},
  tags: [] as string[],
  currentRef: '',
  /** registerPluginIPC 捕获的 handler */
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  /** BrowserWindow.getAllWindows 返回的窗口 */
  windows: [] as any[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => {
      mockState.ipcHandlers.set(channel, fn)
    },
  },
  BrowserWindow: {getAllWindows: () => mockState.windows},
}))

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
    getEnabled(): Record<string, any>[] {
      return this.getAll().filter((p) => p.enabled)
    }
    getDisabledNames(): Set<string> {
      return new Set(this.getAll().filter((p) => !p.enabled).map((p) => p.name))
    }
    updateEnabled(name: string, enabled: boolean): void {
      const plugin = mockState.registryPlugins.get(name)
      if (plugin) plugin.enabled = enabled
    }
    unregister(name: string): void {
      mockState.registryPlugins.delete(name)
    }
    clear(): void {
      mockState.registryPlugins.clear()
    }
    getCommands(): Map<string, unknown[]> {
      return new Map()
    }
  }
  return {PluginRegistry: MockRegistry}
})

vi.mock('@/main/plugin/installer', () => {
  class MockPluginInstaller {
    constructor(_dir?: string) {}
    async fetchTags(pluginPath: string): Promise<void> {
      mockState.fetchTagsCalls.push(pluginPath)
      if (mockState.fetchGate) await mockState.fetchGate.promise
    }
    async listTags(): Promise<string[]> {
      return mockState.tags
    }
    async listBranches(): Promise<string[]> {
      return []
    }
    async getCurrentRef(): Promise<string> {
      return mockState.currentRef
    }
    async update(): Promise<unknown> {
      return {success: false}
    }
    async reset(): Promise<unknown> {
      return {success: false}
    }
  }
  return {PluginInstaller: MockPluginInstaller}
})

vi.mock('@/main/plugin/loader', () => {
  class MockPluginLoader {
    constructor(_registry?: unknown) {}
    async loadAllPlugins(): Promise<unknown[]> {
      return []
    }
    async loadPlugin(): Promise<{manifest: {version: string}}> {
      return {manifest: {version: '1.0.0'}}
    }
  }
  return {PluginLoader: MockPluginLoader}
})

vi.mock('@/main/plugin/plugins-config', () => ({
  loadPluginsConfig: () => ({enabledPlugins: [], disabledPlugins: []}),
  savePluginsConfig: () => {},
  enablePluginInConfig: (_name: string, config: unknown) => config,
  disablePluginInConfig: (_name: string, config: unknown) => config,
  isPluginEnabled: () => true,
}))

// 隔离插件目录：避免 registerPluginIPC → initializePluginSystem 触碰真实 ~/.hclaw
vi.mock('@/main/hclawPaths', async () => {
  const path = await import('node:path')
  const os = await import('node:os')
  return {getHclawDir: () => path.join(os.tmpdir(), 'hclaw-plugin-enabled-filter-test')}
})

vi.mock('@/main/agent/powerManager', () => ({
  powerManager: {
    resetInitialized: () => {},
    async refresh(): Promise<void> {},
  },
}))

vi.mock('@/main/agent/skills', () => ({skillRegistry: {getAll: () => []}}))
vi.mock('@/main/agent/skills/loader', () => ({serializeSkills: (skills: unknown[]) => skills}))
vi.mock('@/main/agent/agentRegistry', () => ({agentRegistry: {getAll: () => []}}))

// ── 被测模块 ──────────────────────────────────────────────────────────
import {versionManager} from '@/main/plugin/versionManager'
import {registerPluginIPC} from '@/main/plugin/ipc'

// ── 辅助 ──────────────────────────────────────────────────────────────

function seedPlugin(name: string, enabled = true, pluginPath = `/tmp/${name}`): void {
  mockState.registryPlugins.set(name, {
    name,
    source: 'github',
    path: pluginPath,
    enabled,
    manifest: {name, version: '1.0.0'},
  })
}

function setEnabled(name: string, enabled: boolean): void {
  const plugin = mockState.registryPlugins.get(name)
  if (plugin) plugin.enabled = enabled
}

function makeWindow(id: number) {
  return {id, webContents: {send: vi.fn()}, isDestroyed: () => false}
}

function handlerOf(channel: string): (...args: any[]) => any {
  const handler = mockState.ipcHandlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler
}

beforeEach(() => {
  mockState.registryPlugins.clear()
  mockState.fetchTagsCalls = []
  mockState.fetchGate = null
  mockState.tags = []
  mockState.currentRef = ''
  mockState.windows = []
  ;(versionManager as any).versionMap.clear()
  registerPluginIPC()
})

// ── 1. startupCheck 跳过禁用插件 ──────────────────────────────────────

describe('startupCheck — 禁用插件不参与启动检查', () => {
  it('enabled=false 的 git 插件不调用 fetchTags，且不出现在返回值/缓存中', async () => {
    seedPlugin('on', true, '/tmp/on')
    seedPlugin('off', false, '/tmp/off')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'

    const result = await versionManager.startupCheck()

    expect(mockState.fetchTagsCalls).toEqual(['/tmp/on'])
    expect(Object.keys(result)).toEqual(['on'])
    expect(versionManager.getVersions('off')).toBeUndefined()
  })
})

// ── 2. getAllVersionMeta 排除禁用插件 ────────────────────────────────

describe('getAllVersionMeta — 红点数据源过滤禁用插件', () => {
  it('先 sync 进缓存、再禁用 → 该条目不再导出；重新启用后恢复导出', async () => {
    seedPlugin('demo')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    await versionManager.syncVersions('demo')
    expect(versionManager.getAllVersionMeta().demo).toEqual({
      current: 'v1.0.0',
      latest: 'v2.0.0',
      hasUpdate: true,
    })

    setEnabled('demo', false)
    expect(versionManager.getAllVersionMeta().demo).toBeUndefined()
    // 缓存本身保留（禁用不影响用户手动「同步版本」读到旧数据）
    expect(versionManager.getVersions('demo')).toBeDefined()

    setEnabled('demo', true)
    expect(versionManager.getAllVersionMeta().demo).toBeDefined()
  })

  it('注册表中已不存在的残留条目（卸载后）不导出', async () => {
    seedPlugin('ghost')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    await versionManager.syncVersions('ghost')

    mockState.registryPlugins.delete('ghost')
    expect(versionManager.getAllVersionMeta()).toEqual({})
  })
})

// ── 3. handleDisable 广播 ────────────────────────────────────────────

describe('handleDisable — 成功后广播红点数据源', () => {
  it('广播一次 plugin:status-update，payload 不含被禁用插件', async () => {
    seedPlugin('demo')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'
    await versionManager.syncVersions('demo')

    const sender = makeWindow(1)
    const other = makeWindow(2)
    mockState.windows = [sender, other]

    const result = await handlerOf('plugin:disable')({sender: sender.webContents}, 'demo')

    expect(result.success).toBe(true)
    // 含发起窗口：togglePlugin 返回值不更新 renderer 的 updateMap，
    // 只广播给「其它窗口」会让发起窗口红点残留。
    expect(other.webContents.send).toHaveBeenCalledTimes(1)
    expect(other.webContents.send).toHaveBeenCalledWith('plugin:status-update', {})
    expect(sender.webContents.send).toHaveBeenCalledTimes(1)
    expect(sender.webContents.send).toHaveBeenCalledWith('plugin:status-update', {})
  })

  it('插件不存在（失败路径）不广播', async () => {
    const sender = makeWindow(1)
    const other = makeWindow(2)
    mockState.windows = [sender, other]

    const result = await handlerOf('plugin:disable')({sender: sender.webContents}, 'ghost')

    expect(result.success).toBe(false)
    expect(other.webContents.send).not.toHaveBeenCalled()
  })
})

// ── 4. handleEnable 后台补查 + 广播 ──────────────────────────────────

describe('handleEnable — 重新启用后后台静默补查一次', () => {
  it('不阻塞 enable 返回，补查完成后广播带回该插件的红点数据', async () => {
    seedPlugin('demo', false, '/tmp/demo')
    mockState.tags = ['v2.0.0', 'v1.0.0']
    mockState.currentRef = 'v1.0.0'

    const sender = makeWindow(1)
    const other = makeWindow(2)
    mockState.windows = [sender, other]

    // 门闸：fetchTags 挂起，证明 enable 的返回不依赖补查
    let release!: () => void
    mockState.fetchGate = {promise: new Promise<void>((resolve) => (release = resolve))}

    const result = await handlerOf('plugin:enable')({sender: sender.webContents}, 'demo')

    expect(result.success).toBe(true)
    await vi.waitFor(() => expect(mockState.fetchTagsCalls).toEqual(['/tmp/demo']))
    expect(sender.webContents.send).not.toHaveBeenCalled()
    expect(other.webContents.send).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => {
      expect(other.webContents.send).toHaveBeenCalledWith(
        'plugin:status-update',
        expect.objectContaining({demo: expect.objectContaining({hasUpdate: true})}),
      )
    })
    // 发起窗口同样收到广播（broadcastToAllWindows）
    expect(sender.webContents.send).toHaveBeenCalledWith(
      'plugin:status-update',
      expect.objectContaining({demo: expect.objectContaining({hasUpdate: true})}),
    )
  })

  it('补查抛错不影响 enable 返回（仅记录日志）', async () => {
    seedPlugin('demo', false, '/tmp/demo')
    const sender = makeWindow(1)
    const other = makeWindow(2)
    mockState.windows = [sender, other]

    const syncSpy = vi
      .spyOn(versionManager, 'syncVersions')
      .mockRejectedValueOnce(new Error('git exploded'))

    const result = await handlerOf('plugin:enable')({sender: sender.webContents}, 'demo')

    expect(result.success).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sender.webContents.send).not.toHaveBeenCalled()
    expect(other.webContents.send).not.toHaveBeenCalled()
    syncSpy.mockRestore()
  })
})
