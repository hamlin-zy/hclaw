import {describe, it, expect, vi, beforeEach} from 'vitest'
import {buildNpxVersionArgs} from '@/main/agent/mcp/versionUtils'

// vi.hoisted for shared mock state
const {cpMock, mcpServiceMock, mcpWorkerManagerMock, pluginVersionManagerMock} = vi.hoisted(() => ({
  cpMock: {
    execAsync: vi.fn().mockResolvedValue({stdout: '2.0.0'}),
  },
  mcpServiceMock: {
    list: vi.fn(() => []),
    get: vi.fn(),
    update: vi.fn(),
  },
  mcpWorkerManagerMock: {
    restartServer: vi.fn(),
  },
  pluginVersionManagerMock: {
    getVersions: vi.fn(),
    switchVersion: vi.fn(),
  },
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn((_cmd: string, _opts: any, callback: Function) => {
    callback(null, cpMock.execAsync ? '' : '', '')
    return {} as any
  }),
}))
vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util')
  return {
    ...actual,
    promisify: () => () => cpMock.execAsync(),
  }
})
vi.mock('@/main/agent/mcp/mcpWorkerManager', () => ({mcpWorkerManager: mcpWorkerManagerMock}))
vi.mock('@/main/services/mcpService', () => ({mcpService: mcpServiceMock}))
vi.mock('@/main/plugin/versionManager', () => ({versionManager: pluginVersionManagerMock}))
vi.mock('@/main/agent/logger', () => ({createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn()})}))
vi.mock('@/main/agent/mcp/bootstrap', () => ({}))
vi.mock('@/main/config/mcpConfig', () => ({readMcpConfig: () => [], writeMcpConfig: () => true}))

import {McpVersionManager} from '@/main/agent/mcp/versionManager'

describe('buildNpxVersionArgs', () => {
  it('pins version on unpinned scoped package', () => {
    const args = ['-y', '@upstash/context7-mcp', '--api-key', 'xxx']
    const result = buildNpxVersionArgs(args, '@upstash/context7-mcp', '2.0.0')
    expect(result).toEqual(['-y', '@upstash/context7-mcp@2.0.0', '--api-key', 'xxx'])
  })

  it('replaces existing version pin on scoped package', () => {
    const args = ['-y', '@upstash/context7-mcp@1.0.0', '--api-key', 'xxx']
    const result = buildNpxVersionArgs(args, '@upstash/context7-mcp', '2.0.0')
    expect(result).toEqual(['-y', '@upstash/context7-mcp@2.0.0', '--api-key', 'xxx'])
  })

  it('pins version on unpinned unscoped package', () => {
    const args = ['-y', 'aigroup-mdtoword-mcp']
    const result = buildNpxVersionArgs(args, 'aigroup-mdtoword-mcp', '1.5.0')
    expect(result).toEqual(['-y', 'aigroup-mdtoword-mcp@1.5.0'])
  })

  it('throws if package not found in args', () => {
    const args = ['-y', '--quiet']
    expect(() => buildNpxVersionArgs(args, 'some-pkg', '1.0.0')).toThrow('Package some-pkg not found in args')
  })
})

describe('McpVersionManager.switchVersion', () => {
  let manager: McpVersionManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new McpVersionManager()
    // Pre-populate versionMap for npx test
    ;(manager as any).versionMap.set('mcp-npx', {
      current: '1.0.0', latest: '2.0.0', hasUpdate: true,
      sourceType: 'npx', lastChecked: Date.now(),
      availableVersions: ['1.0.0', '1.5.0', '2.0.0'],
    })
    ;(manager as any).versionMap.set('mcp-plugin', {
      current: 'v1.0', latest: 'v2.0', hasUpdate: true,
      sourceType: 'plugin', lastChecked: Date.now(),
      availableVersions: ['v1.0', 'v1.5', 'v2.0'],
    })
  })

  it('switches npx server by modifying args and restarting', async () => {
    mcpServiceMock.get.mockReturnValue({
      id: 'mcp-npx', name: 'context7', command: 'npx',
      args: ['-y', '@upstash/context7-mcp', '--api-key', 'xxx'],
      enabled: true, transport: 'stdio', tools: [], status: 'connected',
    })
    mcpServiceMock.update.mockReturnValue(true)
    mcpWorkerManagerMock.restartServer.mockResolvedValue({success: true})

    const result = await manager.switchVersion('mcp-npx', '1.5.0')

    expect(result.success).toBe(true)
    // Verify args were modified
    expect(mcpServiceMock.update).toHaveBeenCalledWith('mcp-npx', expect.objectContaining({
      args: expect.arrayContaining(['@upstash/context7-mcp@1.5.0']),
    }))
    // Verify restart was called
    expect(mcpWorkerManagerMock.restartServer).toHaveBeenCalledWith('mcp-npx')
    // Verify versionMap reflects the re-probed state (detect mock: pinned current, latest from execAsync stdout)
    const meta = (manager as any).versionMap.get('mcp-npx')
    expect(meta.current).toBe('1.5.0')
    expect(meta.latest).toBe('2.0.0')
  })

  it('returns failure on restart failure (rolls back args)', async () => {
    mcpServiceMock.get.mockReturnValue({
      id: 'mcp-npx', name: 'context7', command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      enabled: true, transport: 'stdio', tools: [], status: 'connected',
    })
    mcpServiceMock.update.mockReturnValue(true)
    mcpWorkerManagerMock.restartServer.mockResolvedValue({success: false})
    const oldMeta = {...(manager as any).versionMap.get('mcp-npx')}

    const result = await manager.switchVersion('mcp-npx', '2.0.0')

    expect(result.success).toBe(false)
    expect(result.error).toContain('restart')
    // Verify args were rolled back
    expect(mcpServiceMock.update).toHaveBeenCalledTimes(2)
    const secondCall = mcpServiceMock.update.mock.calls[1]
    expect(secondCall[1].args).toEqual(['-y', '@upstash/context7-mcp'])
    // Verify versionMap restored to pre-switch state
    expect((manager as any).versionMap.get('mcp-npx')).toEqual(oldMeta)
  })

  it('returns success with optimistic versionMap state when re-probe fails', async () => {
    mcpServiceMock.get.mockReturnValue({
      id: 'mcp-npx', name: 'context7', command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      enabled: true, transport: 'stdio', tools: [], status: 'connected',
    })
    mcpServiceMock.update.mockReturnValue(true)
    mcpWorkerManagerMock.restartServer.mockResolvedValue({success: true})
    const detectSpy = vi.spyOn(manager, 'detect').mockRejectedValue(new Error('probe failed'))

    const result = await manager.switchVersion('mcp-npx', '2.0.0')

    expect(result.success).toBe(true)
    // No rollback write — args stay at the new pinned args (only the initial update call)
    expect(mcpServiceMock.update).toHaveBeenCalledTimes(1)
    expect(mcpServiceMock.update).toHaveBeenCalledWith('mcp-npx', expect.objectContaining({
      args: expect.arrayContaining(['@upstash/context7-mcp@2.0.0']),
    }))
    // versionMap reflects optimistic state: pinned version, no update available
    const meta = (manager as any).versionMap.get('mcp-npx')
    expect(meta.current).toBe('2.0.0')
    expect(meta.hasUpdate).toBe(false)
    expect(meta.availableVersions).toEqual(['1.0.0', '1.5.0', '2.0.0'])
    detectSpy.mockRestore()
  })

  it('delegates plugin switch to pluginVersionManager', async () => {
    mcpServiceMock.get.mockReturnValue({
      id: 'plugin:ecc:github', name: 'github', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
      enabled: true, transport: 'stdio', tools: [], status: 'connected',
    })
    pluginVersionManagerMock.switchVersion.mockResolvedValue({
      success: true, versionInfo: {tags: ['v1.0', 'v2.0'], branches: [], latest: 'v2.0', current: 'v2.0', hasUpdate: false},
    })
    pluginVersionManagerMock.getVersions.mockReturnValue({current: 'v2.0', latest: 'v2.0', hasUpdate: false, tags: ['v1.0', 'v2.0']})

    const result = await manager.switchVersion('mcp-plugin', 'v2.0')

    expect(result.success).toBe(true)
    expect(pluginVersionManagerMock.switchVersion).toHaveBeenCalledWith('ecc', 'v2.0')
    // Verify versionMap reflects pluginVersionManager cache
    const meta = (manager as any).versionMap.get('mcp-plugin')
    expect(meta.current).toBe('v2.0')
    expect(meta.latest).toBe('v2.0')
    expect(meta.hasUpdate).toBe(false)
    expect(meta.sourceType).toBe('plugin')
    expect(meta.availableVersions).toEqual(['v1.0', 'v2.0'])
  })

  it('rejects url sourceType', async () => {
    ;(manager as any).versionMap.set('mcp-url', {
      current: null, latest: null, hasUpdate: null,
      sourceType: 'url', lastChecked: Date.now(), availableVersions: [],
    })
    const result = await manager.switchVersion('mcp-url', '1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })

  it('rejects binary sourceType (upgrade detection disabled)', async () => {
    ;(manager as any).versionMap.set('mcp-binary', {
      current: null, latest: null, hasUpdate: null,
      sourceType: 'binary', lastChecked: Date.now(), availableVersions: [],
    })
    const result = await manager.switchVersion('mcp-binary', '1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsupported_source_type')
  })

  it('returns error for unknown server', async () => {
    const result = await manager.switchVersion('unknown', '1.0.0')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })
})
