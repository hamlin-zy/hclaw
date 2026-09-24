/**
 * AgentManager.broadcastGlobalPermissionModeUpdate — 全局默认权限模式同步筛选测试
 *
 * 覆盖：
 * 1. 无会话级覆盖的运行中会话 → 收到 UPDATE_PERMISSION_MODE，并入返回数组
 * 2. 有会话级覆盖（meta.permissionMode 存在）的运行中会话 → 不收消息、不入返回数组
 * 3. 返回数组只含被同步的 convId
 *
 * 构造方式参照 manager.injectMessage.test.ts（mock electron/config/agentTool 后
 * new AgentManager() 并注入 workers Map），配合 mock readMeta 控制会话级覆盖。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

const {mockReadMeta} = vi.hoisted(() => ({mockReadMeta: vi.fn()}))

vi.mock('electron', () => ({
    BrowserWindow: class {
        static getAllWindows = () => []
    },
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
    isSafePath: () => true,
    HCLAW_DIR: '/tmp/hclaw-test',
    getHclawDataDir: () => '/tmp/hclaw-test/data',
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

// manager.impl 仅从此模块导入 injectChildMessage，整体替换安全
vi.mock('@/main/agent/tools/builtin/agentTool', () => ({
    injectChildMessage: vi.fn(() => true),
    abortChildSession: vi.fn(() => false),
}))

// getConvModeOverride 经 repositories 读 conversation meta
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: mockReadMeta, updateMeta: vi.fn()}),
    // manager.impl 间接引入 permissionRule（permissionEngine 单例），其构造期需要该工厂
    createPermissionRepository: () => ({getRules: () => [], saveRules: vi.fn(), addRule: vi.fn(), removeRule: vi.fn()}),
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'

function makeManager(workers: Array<[string, unknown]> = []) {
    const manager = new AgentManager()
    ;(manager as unknown as {workers: Map<string, {worker: {postMessage: ReturnType<typeof vi.fn>}}>}).workers =
        new Map(workers.map(([id, worker]) => [id, {worker: worker as {postMessage: ReturnType<typeof vi.fn>}}])) as never
    return manager
}

const fakeWorker = () => ({postMessage: vi.fn()})

describe('AgentManager.broadcastGlobalPermissionModeUpdate — 仅同步无会话级覆盖的会话', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // 仅 conv-covered 有会话级覆盖（meta.permissionMode），其余无
        mockReadMeta.mockImplementation((convId: string) =>
            convId === 'conv-covered' ? {id: convId, permissionMode: 'safe'} : null,
        )
    })

    it('无覆盖会话收到 UPDATE_PERMISSION_MODE；有覆盖会话不受影响；返回数组只含无覆盖会话', () => {
        const wFresh = fakeWorker()
        const wCovered = fakeWorker()
        const manager = makeManager([
            ['conv-fresh', wFresh],
            ['conv-covered', wCovered],
        ])

        const synced = manager.broadcastGlobalPermissionModeUpdate('auto')

        // 无覆盖 → 收到全局默认变更
        expect(wFresh.postMessage).toHaveBeenCalledTimes(1)
        expect(wFresh.postMessage.mock.calls[0][0]).toEqual({
            type: WORKER_MESSAGE_TYPES.UPDATE_PERMISSION_MODE,
            permissionMode: 'auto',
        })
        // 有覆盖 → 完全不受影响
        expect(wCovered.postMessage).not.toHaveBeenCalled()
        // 返回数组只含被同步的会话
        expect(synced).toEqual(['conv-fresh'])
    })

    it('无运行中会话 → 返回空数组，不发任何消息', () => {
        const manager = makeManager([])
        expect(manager.broadcastGlobalPermissionModeUpdate('safe')).toEqual([])
    })
})
