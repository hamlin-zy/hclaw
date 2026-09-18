/**
 * AgentManager.broadcastPermissionRulesChanged — 规则变更广播测试
 *
 * 覆盖：权限面板增删规则后，所有运行中 Worker 都收到 PERMISSION_RULES_CHANGED，
 * 以便重读 permission_rules、刷新启动快照（否则面板变更对运行中会话不生效）。
 *
 * 构造方式参照 manager.broadcastGlobalPermissionMode.test.ts。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

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

vi.mock('@/main/agent/tools/builtin/agentTool', () => ({
    injectChildMessage: vi.fn(() => true),
}))

vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: vi.fn(), updateMeta: vi.fn()}),
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

describe('AgentManager.broadcastPermissionRulesChanged', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('所有运行中 Worker 都收到 PERMISSION_RULES_CHANGED', () => {
        const w1 = fakeWorker()
        const w2 = fakeWorker()
        const manager = makeManager([
            ['conv-1', w1],
            ['conv-2', w2],
        ])

        manager.broadcastPermissionRulesChanged()

        const expected = {type: WORKER_MESSAGE_TYPES.PERMISSION_RULES_CHANGED}
        expect(w1.postMessage).toHaveBeenCalledTimes(1)
        expect(w1.postMessage.mock.calls[0][0]).toEqual(expected)
        expect(w2.postMessage).toHaveBeenCalledTimes(1)
        expect(w2.postMessage.mock.calls[0][0]).toEqual(expected)
    })

    it('无运行中会话 → 不发任何消息，不抛异常', () => {
        const manager = makeManager([])
        expect(() => manager.broadcastPermissionRulesChanged()).not.toThrow()
    })
})
