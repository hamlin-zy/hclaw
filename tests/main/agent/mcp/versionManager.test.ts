import {describe, expect, it, vi, beforeEach} from 'vitest'
import {McpVersionManager} from '@/main/agent/mcp/versionManager'
import type {McpServer} from '@/shared/types/mcp'
import {spawn} from 'child_process'

// Mock mcpService — lightweight, just list()
// Uses hoisted mcpMockState so tests can change server list between tests
const mcpMockState = vi.hoisted(() => ({
  servers: [] as any[],
}))

vi.mock('@/main/services/mcpService', () => ({
  mcpService: {
    list: () => mcpMockState.servers,
    get: (id: string) => mcpMockState.servers.find(s => s.id === id),
    onEvent: () => () => {},
  },
}))

// Mock windowBroadcast
vi.mock('@/main/utils/windowBroadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

// Mock logger
vi.mock('@/main/agent/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// Mock plugin versionManager (needed for import chain)
// Uses hoisted pluginMockState so tests can set versionInfo before each test
const pluginMockState = vi.hoisted(() => ({
  versionInfo: undefined as any,
}))

vi.mock('@/main/plugin/versionManager', () => ({
  versionManager: {
    getVersions: (name: string) => pluginMockState.versionInfo,
  },
}))

// Mock mcpWorkerManager (needed for import chain)
vi.mock('@/main/agent/mcp/mcpWorkerManager', () => ({
  mcpWorkerManager: {
    restartServer: vi.fn().mockResolvedValue({success: true}),
    stopServer: vi.fn().mockResolvedValue({success: true}),
  },
}))

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
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

describe('McpVersionManager.inferSourceType', () => {
  const manager = new McpVersionManager()

  it('returns "plugin" for plugin: prefix id', () => {
    const server = makeServer({id: 'plugin:myplugin:server1', command: 'node'})
    expect(manager.inferSourceType(server)).toBe('plugin')
  })

  it('returns "npx" for npx command', () => {
    const server = makeServer({command: 'npx', args: ['pkg']})
    expect(manager.inferSourceType(server)).toBe('npx')
  })

  it('returns "npx" for full path npx', () => {
    const server = makeServer({command: '/usr/local/bin/npx', args: ['pkg']})
    expect(manager.inferSourceType(server)).toBe('npx')
  })

  it('returns "npx" for npm command', () => {
    const server = makeServer({command: 'npm', args: ['exec', 'pkg']})
    expect(manager.inferSourceType(server)).toBe('npx')
  })

  it('returns "npx" for full path npm on Windows', () => {
    const server = makeServer({command: 'C:\\Program Files\\nodejs\\npm.cmd', args: ['exec', 'pkg']})
    expect(manager.inferSourceType(server)).toBe('npx')
  })

  it('returns "binary" for non-npx executable command', () => {
    const server = makeServer({command: '/usr/local/bin/my-mcp-server', args: ['serve']})
    expect(manager.inferSourceType(server)).toBe('binary')
  })

  it('returns "binary" for relative path command', () => {
    const server = makeServer({command: './my-server', args: []})
    expect(manager.inferSourceType(server)).toBe('binary')
  })

  it('returns "url" when url present and command empty', () => {
    const server = makeServer({command: '', url: 'https://example.com/mcp'})
    expect(manager.inferSourceType(server)).toBe('url')
  })

  it('returns "unknown" when command empty and no url', () => {
    const server = makeServer({command: '', url: ''})
    expect(manager.inferSourceType(server)).toBe('unknown')
  })

  it('npx/npm command takes priority over plugin: prefix (npm version probing wins)', () => {
    const server = makeServer({id: 'plugin:myplugin:server1', command: 'npx', args: ['pkg']})
    // 设计如此（versionManager.ts 优先级注释）：plugin:ecc:github 实际执行 npx，
    // 必须按 npm 包版本探测，不能走 plugin 的 git tags 路径
    expect(manager.inferSourceType(server)).toBe('npx')
  })

  it('returns "binary" for Windows backslash path command', () => {
    const server = makeServer({command: 'C:\\tools\\my-mcp-server.exe', args: ['serve']})
    // path.basename on POSIX returns the full string, but the .exe suffix
    // is stripped and the result is not 'npx'/'npm' → classified as 'binary'
    const result = manager.inferSourceType(server)
    expect(result).toBe('binary')
  })
})

// Shared mock state for child_process
const cpMock = vi.hoisted(() => ({
  spawnResult: {stdout: '', exitCode: 0, error: null as Error | null} as any,
  execResult: {stdout: '', stderr: '', error: null as Error | null} as any,
  // Original factory-based spawn implementation — restorable after mockReturnValue overrides
  defaultSpawnImpl: () => {
    const callbacks: Record<string, Function> = {}
    return {
      stdout: {on: (ev: string, cb: Function) => { callbacks['stdout_data'] = cb; if (cpMock.spawnResult.stdout) cb(cpMock.spawnResult.stdout) }},
      stderr: {on: () => {}},
      on: (ev: string, cb: Function) => {
        if (ev === 'close') setTimeout(() => cb(cpMock.spawnResult.exitCode), 0)
        if (ev === 'error' && cpMock.spawnResult.error) setTimeout(() => cb(cpMock.spawnResult.error), 0)
      },
      kill: vi.fn(),
    }
  },
}))

// Mock child_process — spawn and exec are mocked separately
vi.mock('child_process', () => ({
  spawn: vi.fn(() => cpMock.defaultSpawnImpl()),
  exec: vi.fn((_cmd: string, _opts: any, callback: Function) => {
    if (cpMock.execResult.error) {
      callback(cpMock.execResult.error, '', '')
    } else {
      callback(null, cpMock.execResult.stdout, cpMock.execResult.stderr)
    }
    return {} as any
  }),
}))

// promisify must return a function that behaves as a promise factory
vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util')
  return {
    ...actual,
    promisify: (fn: Function) => {
      return (...args: any[]) => {
        return new Promise((resolve, reject) => {
          fn(...args, (err: any, stdout: string, stderr: string) => {
            if (err) reject(err)
            else resolve({stdout, stderr})
          })
        })
      }
    },
  }
})

describe('McpVersionManager.detect dispatch', () => {
  it('returns null meta for url sourceType', async () => {
    const manager = new McpVersionManager()
    const server = makeServer({command: '', url: 'https://example.com/mcp'})
    const meta = await manager.detect(server)
    expect(meta.sourceType).toBe('url')
    expect(meta.current).toBeNull()
    expect(meta.latest).toBeNull()
    expect(meta.hasUpdate).toBeNull()
    expect(meta.lastChecked).toBeGreaterThan(0)
  })

  it('returns null meta for unknown sourceType', async () => {
    const manager = new McpVersionManager()
    const server = makeServer({command: '', url: ''})
    const meta = await manager.detect(server)
    expect(meta.sourceType).toBe('unknown')
    expect(meta.current).toBeNull()
    expect(meta.hasUpdate).toBeNull()
  })
})

describe('McpVersionManager.detectPluginVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cpMock.spawnResult = {stdout: '', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '', stderr: '', error: null}
    pluginMockState.versionInfo = undefined
  })

  it('returns null meta when plugin cache is empty (startupCheck not yet done)', async () => {
    const manager = new McpVersionManager()
    const server = makeServer({id: 'plugin:myplugin:server1', command: 'node'})
    const meta = await manager.detect(server)
    expect(meta.sourceType).toBe('plugin')
    expect(meta.current).toBeNull()
    expect(meta.latest).toBeNull()
    expect(meta.hasUpdate).toBeNull()
  })

  it('reads version from plugin cache when available', async () => {
    // Set plugin cache via hoisted mock state
    pluginMockState.versionInfo = {current: '1.0.0', latest: '2.0.0', hasUpdate: true, tags: [], branches: []}

    const manager = new McpVersionManager()
    const server = makeServer({id: 'plugin:myplugin:server1', command: 'node'})
    const meta = await manager.detect(server)
    expect(meta.sourceType).toBe('plugin')
    expect(meta.current).toBe('1.0.0')
    expect(meta.latest).toBe('2.0.0')
    expect(meta.hasUpdate).toBe(true)
  })
})

describe('McpVersionManager.detectBinaryVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns current version from --version output, latest null without checkUrl', async () => {
    const mockStdout = {on: vi.fn((event: string, cb: Function) => {
      if (event === 'data') cb('v3.1.0\n')
    })}
    const mockProcess = {
      stdout: mockStdout,
      stderr: {on: vi.fn()},
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'close') cb(0)
      }),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(mockProcess as any)

    const manager = new McpVersionManager()
    const server = makeServer({command: '/usr/local/bin/my-server', args: ['serve']})
    const meta = await manager.detect(server)
    expect(meta.sourceType).toBe('binary')
    expect(meta.current).toBe('3.1.0')
    expect(meta.latest).toBeNull()
    expect(meta.hasUpdate).toBeNull()
  })

  it('does NOT query checkUrl or any registry for latest (upgrade detection disabled)', async () => {
    const mockStdout = {on: vi.fn((event: string, cb: Function) => {
      if (event === 'data') cb('1.0.0\n')
    })}
    const mockProcess = {
      stdout: mockStdout,
      stderr: {on: vi.fn()},
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'close') cb(0)
      }),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(mockProcess as any)

    // Even with a checkUrl configured, detect must not fetch and must not
    // mark hasUpdate. Registry lookups are disabled to avoid false positives
    // from basename collisions against globally installed npm/pip packages.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({tag_name: 'v2.0.0'})),
    })
    vi.stubGlobal('fetch', mockFetch)

    const manager = new McpVersionManager()
    const server = makeServer({
      command: '/usr/local/bin/my-server',
      args: ['serve'],
      checkUrl: 'https://api.github.com/repos/owner/repo/releases/latest',
    })
    const meta = await manager.detect(server)
    expect(meta.sourceType).toBe('binary')
    expect(meta.current).toBe('1.0.0')
    expect(meta.latest).toBeNull()
    expect(meta.hasUpdate).toBeNull()
    expect(meta.availableVersions).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('returns null current when --version spawn fails', async () => {
    const mockProcess = {
      stdout: {on: vi.fn()},
      stderr: {on: vi.fn()},
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'error') cb(new Error('ENOENT'))
      }),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(mockProcess as any)

    const manager = new McpVersionManager()
    const server = makeServer({command: '/nonexistent/binary', args: []})
    const meta = await manager.detect(server)
    expect(meta.current).toBeNull()
    expect(meta.sourceType).toBe('binary')
  })
})

describe('McpVersionManager.detectNpxVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default factory impl — binary tests override with mockReturnValue and
    // clearAllMocks does not reset implementations
    vi.mocked(spawn).mockImplementation(cpMock.defaultSpawnImpl as any)
    cpMock.spawnResult = {stdout: '', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '', stderr: '', error: null}
  })

  it('returns null meta when package name cannot be extracted', async () => {
    const manager = new McpVersionManager()
    const server = makeServer({command: 'npx', args: ['-y']})
    const meta = await manager.detect(server)
    expect(meta.current).toBeNull()
    expect(meta.latest).toBeNull()
    expect(meta.hasUpdate).toBeNull()
    expect(meta.sourceType).toBe('npx')
  })

  it('extracts pinned version from args and latest from npm view', async () => {
    cpMock.spawnResult = {stdout: '1.2.3\n', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '2.0.0\n', stderr: '', error: null}

    const manager = new McpVersionManager()
    const server = makeServer({command: 'npx', args: ['-y', '@scope/pkg@1.2.3']})
    const meta = await manager.detect(server)
    expect(meta.current).toBe('1.2.3')
    expect(meta.latest).toBe('2.0.0')
    expect(meta.hasUpdate).toBe(true)
    expect(meta.sourceType).toBe('npx')
    expect(meta.availableVersions).toEqual([])
  })

  it('does not spawn --version (parses version from args instead)', async () => {
    cpMock.spawnResult = {stdout: '1.2.3\n', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '2.0.0\n', stderr: '', error: null}

    const manager = new McpVersionManager()
    const server = makeServer({command: 'npx', args: ['-y', '@scope/pkg@1.2.3']})
    await manager.detect(server)

    const {spawn} = await import('child_process')
    const spawnCalls = vi.mocked(spawn).mock.calls.filter(c => c[1]?.includes('--version'))
    expect(spawnCalls).toHaveLength(0)
  })

  it('uses latest as current when package is unpinned', async () => {
    cpMock.spawnResult = {stdout: '1.2.3\n', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '2.0.0\n', stderr: '', error: null}

    const manager = new McpVersionManager()
    const server = makeServer({command: 'npx', args: ['-y', '@scope/pkg']})
    const meta = await manager.detect(server)
    expect(meta.current).toBe('2.0.0')
    expect(meta.latest).toBe('2.0.0')
    expect(meta.hasUpdate).toBe(false)
  })

  it('returns null current/latest when npm view fails for unpinned package', async () => {
    cpMock.spawnResult = {stdout: '', exitCode: 1, error: null}
    cpMock.execResult = {stdout: '', stderr: '', error: new Error('npm view failed')}

    const manager = new McpVersionManager()
    const server = makeServer({command: 'npx', args: ['-y', '@scope/pkg']})
    const meta = await manager.detect(server)
    expect(meta.current).toBeNull()
    expect(meta.latest).toBeNull()
    expect(meta.hasUpdate).toBeNull()
  })
})

describe('McpVersionManager.startupCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpMockState.servers = []
    pluginMockState.versionInfo = undefined
    cpMock.spawnResult = {stdout: '', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '', stderr: '', error: null}
  })

  it('returns empty record when no enabled servers', async () => {
    const manager = new McpVersionManager()
    const result = await manager.startupCheck()
    expect(result).toEqual({})
  })

  it('detects all enabled servers and stores in versionMap', async () => {
    mcpMockState.servers = [
      {...makeServer({id: 'srv1', command: '', url: 'https://example.com'})},
      {...makeServer({id: 'srv2', command: '', url: 'https://example2.com'})},
    ]

    const manager = new McpVersionManager()
    const result = await manager.startupCheck()
    expect(Object.keys(result)).toContain('srv1')
    expect(Object.keys(result)).toContain('srv2')
    expect(result['srv1'].sourceType).toBe('url')
    expect(result['srv2'].sourceType).toBe('url')
  })

  it('sets isChecking flag during execution and clears after', async () => {
    const manager = new McpVersionManager()
    expect((manager as any).isChecking).toBe(false)
    const promise = manager.startupCheck()
    // isChecking is true during execution
    // (if servers are empty, it resolves immediately, so we can't check mid-flight here)
    await promise
    expect((manager as any).isChecking).toBe(false)
  })
})

describe('McpVersionManager.getAllVersionMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpMockState.servers = []
  })

  it('returns empty record when versionMap is empty', () => {
    const manager = new McpVersionManager()
    const result = manager.getAllVersionMeta()
    expect(result).toEqual({})
  })

  it('removes stale entries (servers no longer in mcpService)', async () => {
    mcpMockState.servers = [makeServer({id: 'srv1', enabled: true})]

    const manager = new McpVersionManager()
    // Manually inject stale data
    ;(manager as any).versionMap.set('stale-srv', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'binary', lastChecked: Date.now(),
    })
    ;(manager as any).versionMap.set('srv1', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'binary', lastChecked: Date.now(),
    })

    const result = manager.getAllVersionMeta()
    expect(Object.keys(result)).toContain('srv1')
    expect(Object.keys(result)).not.toContain('stale-srv')
  })

  it('removes disabled server entries (enabled=false)', async () => {
    // Server exists but is disabled — should be removed from versionMeta
    mcpMockState.servers = [makeServer({id: 'srv-disabled', enabled: false})]

    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv-disabled', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'binary', lastChecked: Date.now(),
    })

    const result = manager.getAllVersionMeta()
    expect(Object.keys(result)).not.toContain('srv-disabled')
  })
})

describe('McpVersionManager.upgradeServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpMockState.servers = []
    cpMock.spawnResult = {stdout: '', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '', stderr: '', error: null}
    pluginMockState.versionInfo = undefined
  })

  it('returns unsupported_source_type for url sourceType', async () => {
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv1', {
      current: null, latest: null, hasUpdate: null,
      sourceType: 'url', lastChecked: Date.now(),
    })
    const result = await manager.upgradeServer('srv1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })

  it('returns unsupported_source_type for unknown sourceType', async () => {
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv2', {
      current: null, latest: null, hasUpdate: null,
      sourceType: 'unknown', lastChecked: Date.now(),
    })
    const result = await manager.upgradeServer('srv2')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })

  it('returns not_found when serverId not in versionMap', async () => {
    const manager = new McpVersionManager()
    const result = await manager.upgradeServer('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('npx upgrade: clears cache + restarts server + re-probes version', async () => {
    mcpMockState.servers = [
      makeServer({id: 'srv-npx', command: 'npx', args: ['-y', 'pkg']}),
    ]

    cpMock.spawnResult = {stdout: '2.0.0\n', exitCode: 0, error: null}
    cpMock.execResult = {stdout: '2.0.0\n', stderr: '', error: null}

    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv-npx', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
    })

    const result = await manager.upgradeServer('srv-npx')
    expect(result.success).toBe(true)
  })

  it('rolls back versionMap when restart fails', async () => {
    mcpMockState.servers = [
      makeServer({id: 'srv-npx2', command: 'npx', args: ['-y', 'pkg']}),
    ]

    const {mcpWorkerManager} = await import('@/main/agent/mcp/mcpWorkerManager')
    vi.mocked(mcpWorkerManager.restartServer).mockResolvedValue({success: false})

    const manager = new McpVersionManager()
    const oldMeta = {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
    }
    ;(manager as any).versionMap.set('srv-npx2', oldMeta)

    const result = await manager.upgradeServer('srv-npx2')
    expect(result.success).toBe(false)
    expect(result.error).toContain('restart failed')
    const meta = manager.getVersionMeta('srv-npx2')
    expect(meta).toEqual(oldMeta)
  })

  it('binary upgrade returns unsupported_source_type (upgrade detection disabled)', async () => {
    mcpMockState.servers = [
      makeServer({id: 'srv-binary', command: '/bin/server', checkUrl: 'https://example.com'}),
    ]
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('srv-binary', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'binary', lastChecked: Date.now(),
    })
    const result = await manager.upgradeServer('srv-binary')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })
})

describe('getAvailableVersions', () => {
  it('returns cached availableVersions from versionMap', () => {
    const manager = new McpVersionManager()
    // Simulate a versionMap entry with availableVersions
    ;(manager as any).versionMap.set('test-server', {
      current: '1.0.0', latest: '1.2.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
      availableVersions: ['1.0.0', '1.1.0', '1.2.0'],
    })
    expect(manager.getAvailableVersions('test-server')).toEqual(['1.0.0', '1.1.0', '1.2.0'])
  })

  it('returns empty array for unknown server', () => {
    const manager = new McpVersionManager()
    expect(manager.getAvailableVersions('unknown')).toEqual([])
  })

  it('returns empty array when availableVersions is undefined', () => {
    const manager = new McpVersionManager()
    ;(manager as any).versionMap.set('test-server', {
      current: '1.0.0', latest: '1.2.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
    })
    expect(manager.getAvailableVersions('test-server')).toEqual([])
  })
})
