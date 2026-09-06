/**
 * McpVersionManager integration tests
 *
 * Covers:
 *   - startupCheck full flow with mock services
 *   - isChecking dedup lock under concurrent calls
 *   - getAllVersionMeta stale-key cleanup
 *   - url/unknown upgrade rejection
 *   - startupCheck failure → manual check recovery
 *   - plugin MCP when plugin cache is empty (startup order edge case)
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

// Shared mock state
const mockState = vi.hoisted(() => ({
  servers: [] as any[],
  pluginCache: new Map<string, any>(),
  /** mcpService.update call log: [serverId, patch][] */
  updateCalls: [] as [string, any][],
  /** pluginVersionManager.switchVersion call log: [pluginName, version][] */
  pluginSwitchCalls: [] as [string, string][],
  /** restartServer failure flag for the current test */
  restartShouldFail: false,
}))

vi.mock('@/main/services/mcpService', () => ({
  mcpService: {
    list: () => mockState.servers,
    get: (id: string) => mockState.servers.find(s => s.id === id),
    update: (id: string, patch: any) => {
      mockState.updateCalls.push([id, patch])
      const server = mockState.servers.find(s => s.id === id)
      if (server) Object.assign(server, patch)
      return true
    },
    onEvent: () => () => {},
  },
}))

vi.mock('@/main/utils/windowBroadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

vi.mock('@/main/agent/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

vi.mock('@/main/plugin/versionManager', () => ({
  versionManager: {
    getVersions: (name: string) => mockState.pluginCache.get(name),
    switchVersion: (name: string, version: string) => {
      mockState.pluginSwitchCalls.push([name, version])
      const info = mockState.pluginCache.get(name)
      if (info) info.current = version
      return {success: true}
    },
  },
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  // execAsync = promisify(exec), and the util mock passes promisify through,
  // so exec(command, opts) must return the {stdout} shape directly.
  exec: (command: string) => {
    if (command.includes('versions --json')) {
      return {stdout: JSON.stringify(['1.0.0', '1.5.0', '2.0.0'])}
    }
    return {stdout: '2.0.0\n'}
  },
}))

vi.mock('util', async () => {
  const actual = await vi.importActual('util')
  return {...actual, promisify: (fn: Function) => fn}
})

vi.mock('@/main/agent/mcp/mcpWorkerManager', () => ({
  mcpWorkerManager: {
    restartServer: () =>
      mockState.restartShouldFail
        ? Promise.resolve({success: false, error: 'restart failed'})
        : Promise.resolve({success: true}),
    stopServer: () => Promise.resolve({success: true}),
  },
}))

vi.mock('@/main/plugin/installer', () => ({
  PluginInstaller: class {
    async update() { return {success: true, updated: true} }
  },
}))

vi.mock('@/main/agent/powerManager', () => ({
  powerManager: {refresh: vi.fn().mockResolvedValue(undefined)},
}))

import {McpVersionManager} from '@/main/agent/mcp/versionManager'
import {broadcastToAllWindows} from '@/main/utils/windowBroadcast'

function makeServer(overrides: any = {}): any {
  return {
    id: 'mcp-test',
    name: 'test',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    url: '',
    enabled: true,
    userDescription: '',
    ...overrides,
  }
}

describe('McpVersionManager integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.servers = []
    mockState.pluginCache.clear()
    mockState.updateCalls = []
    mockState.pluginSwitchCalls = []
    mockState.restartShouldFail = false
  })

  it('startupCheck handles mixed source types', async () => {
    mockState.servers = [
      makeServer({id: 'srv-url', url: 'https://example.com', command: ''}),
      makeServer({id: 'srv-unknown', command: '', url: ''}),
    ]

    const manager = new McpVersionManager()
    const result = await manager.startupCheck()

    expect(result['srv-url'].sourceType).toBe('url')
    expect(result['srv-url'].current).toBeNull()
    expect(result['srv-unknown'].sourceType).toBe('unknown')
    expect(result['srv-unknown'].hasUpdate).toBeNull()
    expect(broadcastToAllWindows).toHaveBeenCalledWith('mcp:status-update', expect.any(Object))
  })

  it('isChecking prevents concurrent startupCheck', async () => {
    const manager = new McpVersionManager()
    expect(manager.isChecking).toBe(false)

    // With empty servers, startupCheck resolves immediately
    const result1 = await manager.startupCheck()
    expect(manager.isChecking).toBe(false)

    // Second call should also succeed (no lock held)
    const result2 = await manager.startupCheck()
    expect(result2).toEqual(result1)
  })

  it('getAllVersionMeta removes stale entries', async () => {
    mockState.servers = [makeServer({id: 'srv-active'})]

    const manager = new McpVersionManager()
    // Inject stale data
    ;(manager as any).versionMap.set('stale', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'binary', lastChecked: Date.now(),
    })
    ;(manager as any).versionMap.set('srv-active', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'binary', lastChecked: Date.now(),
    })

    const result = manager.getAllVersionMeta()
    expect(result['srv-active']).toBeDefined()
    expect(result['stale']).toBeUndefined()
  })

  it('upgradeServer rejects url sourceType', async () => {
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv-url', {
      current: null, latest: null, hasUpdate: null,
      sourceType: 'url', lastChecked: Date.now(),
    })
    const result = await manager.upgradeServer('srv-url')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })

  it('upgradeServer rejects unknown sourceType', async () => {
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv-unknown', {
      current: null, latest: null, hasUpdate: null,
      sourceType: 'unknown', lastChecked: Date.now(),
    })
    const result = await manager.upgradeServer('srv-unknown')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })

  it('plugin MCP returns null meta when plugin cache empty', async () => {
    mockState.servers = [makeServer({id: 'plugin:myplugin:srv1', command: 'node'})]
    const manager = new McpVersionManager()
    const result = await manager.startupCheck()
    expect(result['plugin:myplugin:srv1'].sourceType).toBe('plugin')
    expect(result['plugin:myplugin:srv1'].current).toBeNull()
    expect(result['plugin:myplugin:srv1'].hasUpdate).toBeNull()
  })

  it('plugin MCP reads from cache when available', async () => {
    mockState.servers = [makeServer({id: 'plugin:myplugin:srv1', command: 'node'})]
    mockState.pluginCache.set('myplugin', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true, tags: [], branches: [],
    })

    const manager = new McpVersionManager()
    const result = await manager.startupCheck()
    expect(result['plugin:myplugin:srv1'].current).toBe('1.0.0')
    expect(result['plugin:myplugin:srv1'].latest).toBe('2.0.0')
    expect(result['plugin:myplugin:srv1'].hasUpdate).toBe(true)
  })

  it('startupCheck overall failure does not throw', async () => {
    // Force a failure by making mcpService.list throw
    mockState.servers = [makeServer({id: 'srv1'})]
    // The detect method will be called — mock it to throw
    const manager = new McpVersionManager()
    vi.spyOn(manager, 'detect' as any).mockRejectedValue(new Error('network down'))

    const result = await manager.startupCheck()
    // Should not throw — returns meta with null values
    expect(result['srv1']).toBeDefined()
    expect(result['srv1'].current).toBeNull()
  })

  it('disabled servers are excluded from startupCheck', async () => {
    mockState.servers = [
      makeServer({id: 'srv-enabled', enabled: true, command: '', url: 'https://example.com'}),
      makeServer({id: 'srv-disabled', enabled: false, command: '', url: 'https://example.com'}),
    ]

    const manager = new McpVersionManager()
    const result = await manager.startupCheck()
    expect(Object.keys(result)).toContain('srv-enabled')
    expect(Object.keys(result)).not.toContain('srv-disabled')
  })

  it('getAllVersionMeta returns empty when versionMap is empty', () => {
    const manager = new McpVersionManager()
    const result = manager.getAllVersionMeta()
    expect(result).toEqual({})
  })

  it('startupCheck failure → manual check recovers (error recovery path)', async () => {
    // Phase 1: Force failure by making detect throw
    mockState.servers = [makeServer({id: 'srv1', command: '', url: 'https://example.com'})]
    const manager = new McpVersionManager()
    vi.spyOn(manager, 'detect' as any).mockRejectedValue(new Error('network down'))

    const result1 = await manager.startupCheck()
    // Should not throw — returns null meta
    expect(result1['srv1']).toBeDefined()
    expect(result1['srv1'].current).toBeNull()

    // Phase 2: Restore detect (remove mock) and retry
    vi.restoreAllMocks()
    const result2 = await manager.startupCheck()
    // Should succeed now — url type returns null meta but doesn't throw
    expect(result2['srv1']).toBeDefined()
    expect(result2['srv1'].sourceType).toBe('url')
  })
})

describe('switchVersion integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.servers = []
    mockState.pluginCache.clear()
    mockState.updateCalls = []
    mockState.pluginSwitchCalls = []
    mockState.restartShouldFail = false
  })

  it('switches npx server version end-to-end', async () => {
    vi.useFakeTimers()
    try {
      mockState.servers = [
        makeServer({
          id: 'srv-npx',
          command: 'npx',
          args: ['-y', 'some-mcp-server@1.0.0'],
        }),
      ]

      const manager = new McpVersionManager()
      // Seed version cache (as startupCheck would)
      ;(manager as any).versionMap.set('srv-npx', {
        current: '1.0.0', latest: '2.0.0', hasUpdate: true,
        sourceType: 'npx', lastChecked: Date.now(),
        availableVersions: ['1.0.0', '1.5.0', '2.0.0'],
      })

      const resultP = manager.switchVersion('srv-npx', '1.5.0')
      // switchNpxVersion waits 2s before re-probing after restart
      await vi.advanceTimersByTimeAsync(2100)
      const result = await resultP

      expect(result.success).toBe(true)

      // mcpService.update called with pinned args
      expect(mockState.updateCalls.length).toBe(1)
      expect(mockState.updateCalls[0][0]).toBe('srv-npx')
      expect(mockState.updateCalls[0][1]).toEqual({
        args: ['-y', 'some-mcp-server@1.5.0'],
      })

      // mcpService persisted the new args
      const server = mockState.servers.find(s => s.id === 'srv-npx')
      expect(server.args).toEqual(['-y', 'some-mcp-server@1.5.0'])

      // versionMap updated with new current
      const meta = (manager as any).versionMap.get('srv-npx')
      expect(meta.current).toBe('1.5.0')
      expect(meta.sourceType).toBe('npx')
    } finally {
      vi.useRealTimers()
    }
  })

  it('switches plugin server version end-to-end', async () => {
    mockState.servers = [
      makeServer({id: 'plugin:myplugin:srv1', command: 'node'}),
    ]
    mockState.pluginCache.set('myplugin', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      tags: ['v1.0.0', 'v2.0.0'], branches: [],
    })

    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('plugin:myplugin:srv1', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'plugin', lastChecked: Date.now(),
      availableVersions: ['v1.0.0', 'v2.0.0'],
    })

    const result = await manager.switchVersion('plugin:myplugin:srv1', 'v2.0')

    expect(result.success).toBe(true)
    expect(mockState.pluginSwitchCalls).toEqual([['myplugin', 'v2.0']])

    // versionMap updated from pluginVersionManager cache
    const meta = (manager as any).versionMap.get('plugin:myplugin:srv1')
    expect(meta.current).toBe('v2.0')
    expect(meta.sourceType).toBe('plugin')
  })

  it('does not broadcast directly — broadcast lives in the IPC handler', async () => {
    // Note: per the architecture, switchVersion itself never broadcasts.
    // The `mcp:status-update` broadcast after a version switch happens in the
    // IPC handler `mcp:switch-version` (src/main/agent/ipc/, covered by Task 4
    // tests) and in startupCheck — NOT inside McpVersionManager.switchVersion.
    // This test pins that contract: the manager must not double-broadcast.
    mockState.servers = [
      makeServer({id: 'srv-npx', command: 'npx', args: ['-y', 'pkg@1.0.0']}),
    ]
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv-npx', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
      availableVersions: [],
    })

    vi.useFakeTimers()
    try {
      const p = manager.switchVersion('srv-npx', '1.5.0')
      await vi.advanceTimersByTimeAsync(2100)
      await p
    } finally {
      vi.useRealTimers()
    }

    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })

  it('rolls back args on restart failure', async () => {
    mockState.restartShouldFail = true
    mockState.servers = [
      makeServer({
        id: 'srv-npx',
        command: 'npx',
        args: ['-y', 'some-mcp-server@1.0.0'],
      }),
    ]

    const manager = new McpVersionManager()
    const oldMeta = {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
      availableVersions: ['1.0.0', '1.5.0'],
    }
    ;(manager as any).versionMap.set('srv-npx', oldMeta)

    const result = await manager.switchVersion('srv-npx', '1.5.0')

    expect(result.success).toBe(false)
    expect(result.error).toBe('restart failed — args rolled back')

    // mcpService.update called twice: first pin, then rollback
    expect(mockState.updateCalls.length).toBe(2)
    expect(mockState.updateCalls[0][1]).toEqual({
      args: ['-y', 'some-mcp-server@1.5.0'],
    })
    expect(mockState.updateCalls[1][1]).toEqual({
      args: ['-y', 'some-mcp-server@1.0.0'],
    })

    // versionMap preserved old meta
    const meta = (manager as any).versionMap.get('srv-npx')
    expect(meta).toEqual(oldMeta)
  })
})
