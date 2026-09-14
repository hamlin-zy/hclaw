/**
 * 批 4 · #17 mcp:restart-server 错误透传（controller 终审修复波补录 DoD#6）
 *
 * 变异验证记录（批 4 · P6）
 * #17 变异：`ipc.ts` restart handler 的 `result.error ?? '重启失败'` 改回固定 `'重启失败'`
 *      → ✅实测红：#17（AssertionError：fail/updateStatus 收到固定 '重启失败' 而非 'X'）
 *      控制器实测：仅 #17 红，其余 10 绿。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'
import {ipcMain, BrowserWindow} from 'electron'

// Mock mcpVersionManager
const mockVersionMeta = vi.hoisted(() => ({
  getAllResult: {} as Record<string, any>,
  startupResult: {} as Record<string, any>,
  upgradeResult: {success: true} as any,
  availableVersions: [] as string[],
  switchResult: {success: true} as any,
}))

const mockMcpService = vi.hoisted(() => ({
  list: vi.fn(() => [] as any[]),
  get: vi.fn(() => undefined as any),
  updateStatus: vi.fn(),
}))

const mockMcpWorkerManager = vi.hoisted(() => ({
  restartServer: vi.fn((_serverId: string) =>
    Promise.resolve({success: true} as {success: boolean; error?: string})),
}))

vi.mock('@/main/agent/mcp/versionManager', () => ({
  mcpVersionManager: {
    getAllVersionMeta: () => mockVersionMeta.getAllResult,
    startupCheck: () => Promise.resolve(mockVersionMeta.startupResult),
    upgradeServer: (id: string) => Promise.resolve(mockVersionMeta.upgradeResult),
    inferSourceType: () => 'binary',
    getVersionMeta: () => null,
    getAvailableVersions: (id: string) => mockVersionMeta.availableVersions,
    switchVersion: vi.fn((id: string, version: string) => Promise.resolve(mockVersionMeta.switchResult)),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}))

vi.mock('@/main/services/mcpService', () => ({
  mcpService: mockMcpService,
}))

vi.mock('@/main/utils/windowBroadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

vi.mock('@/main/agent/logger', () => ({
  logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
}))

vi.mock('@/main/agent/mcp/mcpWorkerManager', () => ({
  mcpWorkerManager: mockMcpWorkerManager,
}))

vi.mock('@/main/plugin/versionManager', () => ({
  versionManager: {getVersions: () => undefined},
}))

vi.mock('@/main/plugin/registry', () => ({
  PluginRegistry: {getInstance: () => ({get: () => undefined})},
}))

vi.mock('@/main/plugin/installer', () => ({
  PluginInstaller: class {},
}))

vi.mock('@/main/config/mcpConfig', () => ({
  setMcpPluginOverride: vi.fn(),
}))

import {broadcastToAllWindows} from '@/main/utils/windowBroadcast'

import {registerMCPIPC} from '@/main/agent/mcp/ipc'

describe('MCP IPC version handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers mcp:get-version-meta handler', () => {
    registerMCPIPC()
    expect(ipcMain.handle).toHaveBeenCalledWith('mcp:get-version-meta', expect.any(Function))
  })

  it('registers mcp:check-versions handler', () => {
    registerMCPIPC()
    expect(ipcMain.handle).toHaveBeenCalledWith('mcp:check-versions', expect.any(Function))
  })

  it('registers mcp:upgrade-server handler', () => {
    registerMCPIPC()
    expect(ipcMain.handle).toHaveBeenCalledWith('mcp:upgrade-server', expect.any(Function))
  })

  it('mcp:get-version-meta returns a bare record (F-A regression)', async () => {
    registerMCPIPC()
    mockVersionMeta.getAllResult = {
      'srv-1': {current: '1.0.0', latest: '2.0.0', hasUpdate: true, sourceType: 'npx', lastChecked: 0},
    }
    const calls = (ipcMain.handle as any).mock.calls
    const entry = calls.find(([channel]: any[]) => channel === 'mcp:get-version-meta')
    expect(entry).toBeDefined()
    const result = await entry![1]()
    // Regression guard: F-A bug was returning {success:true, data:{...}} which made
    // createUpdateStore.refreshFromCache treat the wrapper as the record.
    expect(result).toEqual(mockVersionMeta.getAllResult)
    expect(result).not.toHaveProperty('success')
    expect(result).not.toHaveProperty('data')
    expect(result['srv-1']).toBeDefined()
  })

  it('registers mcp:get-available-versions handler', () => {
    registerMCPIPC()
    expect(ipcMain.handle).toHaveBeenCalledWith('mcp:get-available-versions', expect.any(Function))
  })

  it('registers mcp:switch-version handler', () => {
    registerMCPIPC()
    expect(ipcMain.handle).toHaveBeenCalledWith('mcp:switch-version', expect.any(Function))
  })
})

describe('mcp:get-available-versions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerMCPIPC()
  })

  function getHandler() {
    const calls = (ipcMain.handle as any).mock.calls
    const entry = calls.find(([channel]: any[]) => channel === 'mcp:get-available-versions')
    expect(entry).toBeDefined()
    return entry![1]
  }

  it('returns available versions from manager', async () => {
    mockVersionMeta.availableVersions = ['1.0.0', '2.0.0']
    const handler = getHandler()
    const result = await handler({}, 'srv-1')
    expect(result).toEqual(['1.0.0', '2.0.0'])
  })
})

describe('mcp:switch-version', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerMCPIPC()
  })

  function getHandler() {
    const calls = (ipcMain.handle as any).mock.calls
    const entry = calls.find(([channel]: any[]) => channel === 'mcp:switch-version')
    expect(entry).toBeDefined()
    return entry![1]
  }

  it('calls switchVersion and broadcasts status update', async () => {
    mockVersionMeta.switchResult = {success: true}
    mockVersionMeta.getAllResult = {'srv-1': {current: '2.0.0'}}
    const handler = getHandler()
    const result = await handler({}, 'srv-1', '2.0.0')
    expect(result).toEqual({success: true})
    expect(broadcastToAllWindows).toHaveBeenCalledWith('mcp:status-update', mockVersionMeta.getAllResult)
  })

  it('returns error for missing serverId', async () => {
    const handler = getHandler()
    const result = await handler({}, '', '2.0.0')
    expect(result).toEqual({success: false, error: 'serverId and version are required'})
    expect(broadcastToAllWindows).not.toHaveBeenCalled()
  })

  it('returns error when switchVersion throws', async () => {
    const vm = await import('@/main/agent/mcp/versionManager')
    ;(vm.mcpVersionManager.switchVersion as any).mockRejectedValueOnce(new Error('boom'))
    const handler = getHandler()
    const result = await handler({}, 'srv-1', '2.0.0')
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('boom')
  })
})

describe('mcp:restart-server 错误透传（批 4 · #17）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerMCPIPC()
  })

  function getHandler() {
    const calls = (ipcMain.handle as any).mock.calls
    const entry = calls.find(([channel]: any[]) => channel === 'mcp:restart-server')
    expect(entry).toBeDefined()
    return entry![1]
  }

  it('#17 失败时把 Worker 的 error 透传给 updateStatus 与 fail（前缀用 toContain）', async () => {
    mockMcpService.get.mockReturnValue({id: 's1', name: 's1'})
    mockMcpWorkerManager.restartServer.mockResolvedValueOnce({success: false, error: 'X'})

    const handler = getHandler()
    const result = await handler({}, 's1')

    expect(mockMcpService.updateStatus).toHaveBeenCalledWith('s1', 'error', 'X')
    expect(result.success).toBe(false)
    // ipc.ts:18 的 fail = String(err) → 'Error: X'，故用 toContain 而非全等
    expect(String(result.error)).toContain('X')
  })
})
