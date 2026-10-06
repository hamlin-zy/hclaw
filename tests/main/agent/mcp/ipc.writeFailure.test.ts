/**
 * MCP IPC 写盘失败端到端透传回归面（P1-1）
 *
 * 背景：mcpService.add / delete / setEnabled 与 mcpConfig.setMcpPluginOverride 都已实现
 * 「写盘失败 → 回滚内存 → 返回 false」，但主进程 IPC handler 曾丢弃返回值恒返回 ok()，
 * 使渲染层 `if (setResult && !setResult.success)` 的回滚分支在真实链路中不可达 ——
 * 写盘失败时 UI 仍乐观显示成功，形成内存/磁盘漂移。
 *
 * 本文件锁定：
 * 1. 底层返回 false → handler 必须返回 {success:false, error}，且不得调用 syncConfigs；
 * 2. 底层返回 true → 仍返回 {success:true}（回归护栏）；
 * 3. 判定必须用 `=== false`：测试替身/将来签名返回 undefined 时不得误判为失败
 *    （与 mcpService 内部判定约定一致）。
 *
 * ⚠️ 全部 mocked：不触碰真实 mcp.json，不启动 Worker，不做网络请求。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {ipcMain} from 'electron'

const mocks = vi.hoisted(() => ({
    setMcpPluginOverride: vi.fn((): boolean | undefined => true),
    add: vi.fn((): boolean | undefined => true),
    del: vi.fn((): boolean | undefined => true),
    setEnabled: vi.fn((): boolean | undefined => true),
    get: vi.fn((): any => undefined),
    list: vi.fn((): any[] => []),
    updateStatus: vi.fn(),
    syncConfigs: vi.fn(),
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
}))

vi.mock('electron', () => ({ipcMain: {handle: vi.fn()}}))

vi.mock('@/main/agent/logger', () => ({
    logger: mocks.logger,
    createLogger: () => mocks.logger,
}))

vi.mock('@/main/agent/mcp/client', () => ({mcpClient: {testConnection: vi.fn()}}))

vi.mock('@/main/agent/mcp/mcpWorkerManager', () => ({
    mcpWorkerManager: {syncConfigs: mocks.syncConfigs},
}))

vi.mock('@/main/agent/mcp/versionManager', () => ({
    mcpVersionManager: {
        getAllVersionMeta: () => ({}),
        startupCheck: vi.fn(async () => ({})),
        upgradeServer: vi.fn(async () => ({success: true})),
        getAvailableVersions: vi.fn(() => []),
        switchVersion: vi.fn(async () => ({success: true})),
    },
}))

vi.mock('@/main/services/mcpService', () => ({
    mcpService: {
        list: mocks.list,
        get: mocks.get,
        add: mocks.add,
        delete: mocks.del,
        setEnabled: mocks.setEnabled,
        updateStatus: mocks.updateStatus,
    },
}))

vi.mock('@/main/config/mcpConfig', () => ({
    setMcpPluginOverride: mocks.setMcpPluginOverride,
}))

vi.mock('@/main/plugin/registry', () => ({
    PluginRegistry: {getInstance: () => ({get: () => undefined})},
}))

vi.mock('@/main/utils/windowBroadcast', () => ({broadcastToAllWindows: vi.fn()}))

import {registerMCPIPC} from '@/main/agent/mcp/ipc'

type Handler = (...args: any[]) => Promise<any>

function getHandler(channel: string): Handler {
    const calls = (ipcMain.handle as unknown as {mock: {calls: any[][]}}).mock.calls
    const entry = calls.find(([ch]) => ch === channel)
    expect(entry).toBeDefined()
    return entry![1] as Handler
}

describe('MCP IPC 写盘失败透传（P1-1）', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // get 可能与「提前 return、未走到缓存同步」的失败用例共用 once 队列，
        // 遗留的 mockReturnValueOnce 会污染后续用例 → 此处显式复位实现。
        mocks.get.mockReset().mockReturnValue(undefined)
        registerMCPIPC()
    })

    describe('mcp:set-enabled — 用户 MCP（mcpService.setEnabled）', () => {
        it('底层返回 false → {success:false}，且不触发 syncConfigs', async () => {
            mocks.setEnabled.mockReturnValueOnce(false)

            const result = await getHandler('mcp:set-enabled')({}, 'srv-1', false)

            expect(mocks.setEnabled).toHaveBeenCalledWith('srv-1', false)
            expect(result.success).toBe(false)
            expect(result.error).toBeTruthy()
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('底层返回 true → {success:true}，并 syncConfigs 一次（回归护栏）', async () => {
            mocks.setEnabled.mockReturnValueOnce(true)

            const result = await getHandler('mcp:set-enabled')({}, 'srv-1', true)

            expect(result).toEqual({success: true})
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })

        it('底层返回 undefined（测试替身/签名变化）不视为失败', async () => {
            mocks.setEnabled.mockReturnValueOnce(undefined)

            const result = await getHandler('mcp:set-enabled')({}, 'srv-1', true)

            expect(result).toEqual({success: true})
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })
    })

    describe('mcp:set-enabled — 插件 MCP（setMcpPluginOverride）', () => {
        it('override 写盘返回 false → {success:false}，不写缓存、不 syncConfigs', async () => {
            mocks.setMcpPluginOverride.mockReturnValueOnce(false)

            const result = await getHandler('mcp:set-enabled')({}, 'plugin:foo', true)

            expect(mocks.setMcpPluginOverride).toHaveBeenCalledWith('plugin:foo', {enabled: true})
            expect(result.success).toBe(false)
            expect(result.error).toBeTruthy()
            expect(mocks.get).not.toHaveBeenCalled()
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('override 写盘返回 true → {success:true}，缓存 enabled 同步为新值', async () => {
            const cached = {id: 'plugin:foo', enabled: false}
            mocks.get.mockReturnValueOnce(cached)
            mocks.setMcpPluginOverride.mockReturnValueOnce(true)

            const result = await getHandler('mcp:set-enabled')({}, 'plugin:foo', true)

            expect(result).toEqual({success: true})
            expect(cached.enabled).toBe(true)
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })
    })

    describe('mcp:save-server', () => {
        it('用户 MCP：add 写盘返回 false → {success:false}，不 syncConfigs', async () => {
            mocks.add.mockReturnValueOnce(false)

            const result = await getHandler('mcp:save-server')({}, {id: 'srv-2', name: 'srv-2'})

            expect(mocks.add).toHaveBeenCalledTimes(1)
            expect(result.success).toBe(false)
            expect(result.error).toBeTruthy()
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('用户 MCP：add 返回 true → {success:true} 且 syncConfigs 一次', async () => {
            mocks.add.mockReturnValueOnce(true)

            const result = await getHandler('mcp:save-server')({}, {id: 'srv-2', name: 'srv-2'})

            expect(result).toEqual({success: true})
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })

        it('插件 MCP：override 写盘返回 false → {success:false}，缓存不被同步', async () => {
            mocks.setMcpPluginOverride.mockReturnValueOnce(false)

            const result = await getHandler('mcp:save-server')({}, {id: 'plugin:bar', name: 'new-name'})

            expect(result.success).toBe(false)
            expect(result.error).toBeTruthy()
            // 写盘失败必须提前返回：不得读取/覆盖 mcpService 缓存
            expect(mocks.get).not.toHaveBeenCalled()
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('插件 MCP：override 写盘返回 true → {success:true}，缓存同步生效', async () => {
            const cached: any = {id: 'plugin:bar', name: 'old-name'}
            mocks.get.mockReturnValueOnce(cached)
            mocks.setMcpPluginOverride.mockReturnValueOnce(true)

            const result = await getHandler('mcp:save-server')({}, {id: 'plugin:bar', name: 'new-name'})

            expect(result).toEqual({success: true})
            expect(cached.name).toBe('new-name')
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })
    })

    describe('mcp:delete / mcp:remove-server', () => {
        it('mcp:delete：写盘返回 false → {success:false}，不 syncConfigs', async () => {
            mocks.del.mockReturnValueOnce(false)

            const result = await getHandler('mcp:delete')({}, 'srv-3')

            expect(mocks.del).toHaveBeenCalledWith('srv-3')
            expect(result.success).toBe(false)
            expect(result.error).toBeTruthy()
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('mcp:delete：写盘返回 true → {success:true}（回归护栏）', async () => {
            mocks.del.mockReturnValueOnce(true)

            const result = await getHandler('mcp:delete')({}, 'srv-3')

            expect(result).toEqual({success: true})
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })

        it('mcp:remove-server（alias）：写盘返回 false → {success:false}', async () => {
            mocks.del.mockReturnValueOnce(false)

            const result = await getHandler('mcp:remove-server')({}, 'srv-4')

            expect(mocks.del).toHaveBeenCalledWith('srv-4')
            expect(result.success).toBe(false)
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })
    })

    describe('mcp:start-server / mcp:stop-server（同样经 setEnabled 落盘）', () => {
        it('start-server：setEnabled 返回 false → {success:false}，状态落 error、不 syncConfigs', async () => {
            mocks.setEnabled.mockReturnValueOnce(false)

            const result = await getHandler('mcp:start-server')({}, {id: 'srv-5', name: 'srv-5'})

            expect(mocks.setEnabled).toHaveBeenCalledWith('srv-5', true)
            expect(mocks.updateStatus).toHaveBeenCalledWith('srv-5', 'error', expect.any(String))
            expect(result.success).toBe(false)
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('stop-server：setEnabled 返回 false → {success:false}，不 syncConfigs', async () => {
            mocks.setEnabled.mockReturnValueOnce(false)

            const result = await getHandler('mcp:stop-server')({}, 'srv-6')

            expect(mocks.setEnabled).toHaveBeenCalledWith('srv-6', false)
            expect(result.success).toBe(false)
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('stop-server：setEnabled 抛错 → 状态落 error（不留僵尸 stopping）+ {success:false}', async () => {
            // P2-a：catch 分支必须与 start-server 的 catch 对称，把首行置位的 'stopping' 收尾为 'error'
            mocks.setEnabled.mockImplementationOnce(() => {
                throw new Error('写盘炸了')
            })

            const result = await getHandler('mcp:stop-server')({}, 'srv-7')

            expect(mocks.updateStatus).toHaveBeenCalledWith('srv-7', 'stopping')
            expect(mocks.updateStatus).toHaveBeenCalledWith('srv-7', 'error', '写盘炸了')
            expect(result.success).toBe(false)
            expect(mocks.syncConfigs).not.toHaveBeenCalled()
        })

        it('start-server：setEnabled 返回 true → {success:true}（回归护栏）', async () => {
            mocks.setEnabled.mockReturnValueOnce(true)

            const result = await getHandler('mcp:start-server')({}, {id: 'srv-5', name: 'srv-5'})

            expect(result).toEqual({success: true})
            expect(mocks.syncConfigs).toHaveBeenCalledTimes(1)
        })
    })
})
