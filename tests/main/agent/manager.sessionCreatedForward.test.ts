/**
 * AgentManager Worker 消息转发回归测试 — session_created 必须透传 handoffFromConvId
 *
 * 背景：session_handoff 工具运行在 Worker 中，session_created 消息经 parentPort
 * 到达主进程后由 createMessageHandler 转发给渲染进程。此前转发时重建 payload
 * 只保留 id/title/workspacePath，丢失 handoffFromConvId，导致交接后新会话
 * 不显示「←前会话」按钮（重启后从 SQLite meta 加载才恢复）。
 */
import {describe, expect, it, vi} from 'vitest'

// ── electron 空壳：manager.impl 仅用 BrowserWindow 类型/null 检查 ──
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

import {AgentManager} from '@/main/agent/manager.impl'
import type {BrowserWindow} from 'electron'

function makeManagerWithFakeWindow() {
    const manager = new AgentManager()
    const send = vi.fn()
    const fakeWin = {
        isDestroyed: () => false,
        webContents: {send},
    } as unknown as BrowserWindow
    // 绕过 setMainWindow（其内部 setAgentManagerRef 有额外副作用，本测试不需要）
    ;(manager as unknown as { mainWindow: BrowserWindow | null }).mainWindow = fakeWin
    return {manager, send}
}

async function invokeSessionCreated(manager: AgentManager, workerMsg: Record<string, unknown>) {
    const handler = (manager as unknown as {
        createMessageHandler: (convId: string, worker: unknown) => (msg: unknown) => Promise<void>
    }).createMessageHandler('conv-source', {})
    await handler({type: 'session_created', conversationId: '', ...workerMsg})
}

describe('AgentManager createMessageHandler — session_created 转发', () => {
    it('透传 handoffFromConvId 到渲染进程（回归：交接后「←前会话」不显示）', async () => {
        const {manager, send} = makeManagerWithFakeWindow()

        await invokeSessionCreated(manager, {
            convId: 'conv-new',
            title: '交接新会话',
            workspacePath: '/ws',
            handoffFromConvId: 'conv-source',
        })

        expect(send).toHaveBeenCalledWith('session_created', expect.objectContaining({
            id: 'conv-new',
            title: '交接新会话',
            workspacePath: '/ws',
            handoffFromConvId: 'conv-source',
        }))
    })

    it('无来源会话时 handoffFromConvId 为 undefined，不影响其余字段', async () => {
        const {manager, send} = makeManagerWithFakeWindow()

        await invokeSessionCreated(manager, {
            convId: 'conv-new',
            title: '普通新会话',
            workspacePath: '/ws',
        })

        const payload = send.mock.calls[0][1] as Record<string, unknown>
        expect(payload.id).toBe('conv-new')
        expect(payload.handoffFromConvId).toBeUndefined()
    })
})
