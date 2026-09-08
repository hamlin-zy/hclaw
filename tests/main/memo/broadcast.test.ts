import {describe, it, expect, vi, beforeEach} from 'vitest'

/**
 * broadcastMemoChanged 环境感知测试：
 * - 主进程（isMainThread=true）走 BrowserWindow 广播
 * - Worker 线程（isMainThread=false + parentPort）走 parentPort.postMessage，不抛异常
 */
const state = vi.hoisted(() => ({
    isMainThread: true,
    postMessage: vi.fn(),
    send: vi.fn(),
}))
vi.mock('worker_threads', () => ({
    get isMainThread() { return state.isMainThread },
    get parentPort() { return state.isMainThread ? null : {postMessage: state.postMessage} },
}))
vi.mock('electron', () => ({
    BrowserWindow: {getAllWindows: () => [{isDestroyed: () => false, webContents: {send: state.send}}]},
}))
vi.mock('../../../src/main/agent/logger', () => ({logger: {warn: vi.fn()}}))

async function loadBroadcast() {
    vi.resetModules()
    return await import('../../../src/main/memo/broadcast')
}

describe('broadcastMemoChanged', () => {
    beforeEach(() => {
        state.postMessage.mockClear()
        state.send.mockClear()
        state.isMainThread = true
    })

    it('主进程：走 BrowserWindow 广播 memo_changed', async () => {
        const {broadcastMemoChanged} = await loadBroadcast()
        broadcastMemoChanged('E:\\p')
        expect(state.send).toHaveBeenCalledWith('memo_changed', {workspacePath: 'E:\\p'})
        expect(state.postMessage).not.toHaveBeenCalled()
    })

    it('Worker 线程：走 parentPort.postMessage，不访问 electron', async () => {
        state.isMainThread = false
        const {broadcastMemoChanged} = await loadBroadcast()
        expect(() => broadcastMemoChanged('E:\\p')).not.toThrow()
        expect(state.postMessage).toHaveBeenCalledWith({type: 'memo_changed', workspacePath: 'E:\\p'})
        expect(state.send).not.toHaveBeenCalled()
    })
})
