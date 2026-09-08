/**
 * AgentManager.injectMessage — 三级路由回归测试
 *
 * 覆盖：
 * 1. 会话自身是运行中 Worker → 直接 postMessage（带 convId）
 * 2. 未命中 Workers → agentTool 注册表本地入队（injectChildMessage）
 * 3. 本地未命中但存在其他 Worker → 广播 INJECT_USER_MESSAGE（带 convId），
 *    由 worker 侧 routeInjectedUserMessage 路由到子会话队列
 * 4. 全部未命中 → 返回 false
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('electron', () => ({
    BrowserWindow: class {},
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

// manager.impl 仅从此模块导入 injectChildMessage，整体替换安全
vi.mock('@/main/agent/tools/builtin/agentTool', () => ({
    injectChildMessage: vi.fn(() => true),
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {injectChildMessage} from '@/main/agent/tools/builtin/agentTool'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'
import type {BrowserWindow} from 'electron'

function makeManager(workers: Array<[string, unknown]> = []) {
    const manager = new AgentManager()
    ;(manager as unknown as {workers: Map<string, {worker: {postMessage: ReturnType<typeof vi.fn>}}>; mainWindow: BrowserWindow | null}).workers = new Map(
        workers.map(([id, worker]) => [id, {worker: worker as {postMessage: ReturnType<typeof vi.fn>}}]),
    ) as never
    return manager
}

const fakeWorker = () => ({postMessage: vi.fn()})

describe('AgentManager.injectMessage — 三级路由', () => {
    it('路径 1：会话自身是运行中 Worker → 直接 postMessage，带 convId', () => {
        const w = fakeWorker()
        const manager = makeManager([['conv-a', w]])

        expect(manager.injectMessage('conv-a', '你好', 'inject-1')).toBe(true)
        expect(w.postMessage).toHaveBeenCalledTimes(1)
        const msg = w.postMessage.mock.calls[0][0] as Record<string, unknown>
        expect(msg.type).toBe(WORKER_MESSAGE_TYPES.INJECT_USER_MESSAGE)
        expect(msg.convId).toBe('conv-a')
        expect(msg.message).toEqual({content: '你好', id: 'inject-1'})
        expect(injectChildMessage).not.toHaveBeenCalled()
    })

    it('路径 1：未显式指定 messageId → 自动生成 inject- 前缀 id', () => {
        const w = fakeWorker()
        const manager = makeManager([['conv-a', w]])

        manager.injectMessage('conv-a', '你好')
        const msg = w.postMessage.mock.calls[0][0] as {message: {id: string}}
        expect(msg.message.id).toMatch(/^inject-\d+-[a-z0-9]{6}$/)
    })

    it('路径 2：目标不在 Workers（主进程内子会话）→ injectChildMessage 本地入队', () => {
        const w = fakeWorker()
        vi.mocked(injectChildMessage).mockClear().mockReturnValue(true)
        const manager = makeManager([['conv-a', w]])

        expect(manager.injectMessage('conv-child', '注入子会话', 'inject-2')).toBe(true)
        expect(injectChildMessage).toHaveBeenCalledWith('conv-child', '注入子会话', 'inject-2')
        // 不误伤其他 Worker
        expect(w.postMessage).not.toHaveBeenCalled()
    })

    it('路径 3：本地未命中但存在其他运行中 Worker → 广播（所有 Workers 收到同一消息）', () => {
        vi.mocked(injectChildMessage).mockClear().mockReturnValue(false)
        const w1 = fakeWorker()
        const w2 = fakeWorker()
        const manager = makeManager([['conv-a', w1], ['conv-b', w2]])

        expect(manager.injectMessage('conv-child', '广播测试', 'inject-3')).toBe(true)
        for (const w of [w1, w2]) {
            expect(w.postMessage).toHaveBeenCalledTimes(1)
            const msg = w.postMessage.mock.calls[0][0] as Record<string, unknown>
            expect(msg.type).toBe(WORKER_MESSAGE_TYPES.INJECT_USER_MESSAGE)
            expect(msg.convId).toBe('conv-child')
            expect(msg.message).toEqual({content: '广播测试', id: 'inject-3'})
        }
    })

    it('路径 4：无 Worker 命中且本地未命中 → 返回 false', () => {
        vi.mocked(injectChildMessage).mockClear().mockReturnValue(false)
        const manager = makeManager()

        expect(manager.injectMessage('conv-none', '无人接收')).toBe(false)
    })

    it('路径 2 优先于路径 3：子会话运行在主进程时不广播', () => {
        vi.mocked(injectChildMessage).mockClear().mockReturnValue(true)
        const w = fakeWorker()
        const manager = makeManager([['conv-a', w]])

        expect(manager.injectMessage('conv-child', '本地命中')).toBe(true)
        expect(w.postMessage).not.toHaveBeenCalled()
    })
})
