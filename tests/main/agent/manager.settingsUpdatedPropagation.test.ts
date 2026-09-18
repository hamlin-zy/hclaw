/**
 * AgentManager.handleStreamEvent — settings-updated 走统一传播链（spec §6.6 / 验收 #8）
 *
 * 背景：system_manage 工具改了系统设置后，Worker 回传 `settings-updated` 流事件；
 * 主进程必须把它接入**统一写后传播**（src/main/settings/propagateSettings.ts），
 * 而不是各写各的：① 运行中会话收到 UPDATE_SETTINGS（Worker 内 currentSettings 生效）
 * ② 全局默认权限模式下发到 permissionEngine（否则新会话沿用旧模式）。
 *
 * 本用例守的就是这条接线本身：把 handleStreamEvent 里 settings-updated 分支的
 * propagateSystemSettings 调用摘掉/短路，本用例必须变红。
 *
 * 构造方式参照 manager.broadcastGlobalPermissionMode.test.ts（mock electron/config/
 * agentTool/repositories 后 new AgentManager() 并注入 workers Map）；
 * handleStreamEvent 为私有方法，按 manager.batchPersistGuard.test.ts 的类型桥手法调用。
 */
import {afterEach, describe, expect, it, vi} from 'vitest'

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
}))

vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: vi.fn(() => null), updateMeta: vi.fn()}),
    // manager.impl 间接引入 permissionEngine 单例，其初始化链路需要该工厂
    createPermissionRepository: () => ({getRules: () => [], saveRules: vi.fn(), addRule: vi.fn(), removeRule: vi.fn()}),
}))

import type {SystemSettings} from '@shared/types'
import {AgentManager} from '@/main/agent/manager.impl'
import {permissionEngine} from '@/main/agent/tools/permission'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'

/** 注入运行中会话（getRunningConversations() = workers.keys()） */
function makeManager(workers: Array<[string, unknown]>): AgentManager {
    const manager = new AgentManager()
    ;(manager as unknown as {workers: Map<string, unknown>}).workers = new Map(
        workers.map(([id, worker]) => [id, {worker}]),
    )
    return manager
}

/** 经类型桥调用私有 handleStreamEvent（对齐 batchPersistGuard.test 的手法是既有惯例） */
function callHandleStreamEvent(manager: AgentManager, event: unknown): Promise<void> {
    const impl = manager as unknown as {handleStreamEvent: (c: string, w: unknown, e: unknown) => Promise<void>}
    return impl.handleStreamEvent('conv-run', {}, event)
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('handleStreamEvent(settings-updated) — 统一传播链', () => {
    it('运行中会话收到 UPDATE_SETTINGS，且全局权限模式下发到 permissionEngine', async () => {
        const worker = {postMessage: vi.fn()}
        const manager = makeManager([['conv-run', worker]])
        const setMode = vi.spyOn(permissionEngine, 'setMode').mockResolvedValue(undefined)
        const settings = {agent: {defaultPermissionMode: 'auto'}} as unknown as SystemSettings

        await callHandleStreamEvent(manager, {type: 'settings-updated', settings})

        // ① 运行中会话收到全量设置（走 broadcastSettings 唯一出口）
        expect(worker.postMessage).toHaveBeenCalledWith({type: WORKER_MESSAGE_TYPES.UPDATE_SETTINGS, settings})
        // ② 全局默认权限模式下发（新会话/规则引擎随之换模式）
        expect(setMode).toHaveBeenCalledWith('auto')
    })
})
