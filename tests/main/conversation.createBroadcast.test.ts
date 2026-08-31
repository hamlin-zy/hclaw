/**
 * 修复回归测试：渲染端（含 MCP 独立窗口等 dialog 窗口）经 conversation-create IPC
 * 创建会话后，主进程必须向「除发送方外」的所有窗口广播 conversation-created
 * （带 source: 'renderer-create'），否则主窗口侧栏列表感知不到新会话。
 *
 * 背景：MCP「帮我检查」迁独立窗口后，handleHelp 在独立窗口 JS 堆内建会话并
 * 关闭自身，主窗口既看不到会话条目、左下角却提示「会话运行中」。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const {ipcMainHandle} = vi.hoisted(() => ({ipcMainHandle: vi.fn()}))

vi.mock('electron', () => {
    const makeWC = () => ({send: vi.fn()})
    return {
        ipcMain: {handle: ipcMainHandle},
        BrowserWindow: {getAllWindows: vi.fn()},
    }
})

const convRepoCreate = vi.fn(() => true)
const convRepoDelete = vi.fn(() => true)
const convRepoDeleteBatch = vi.fn(() => true)
vi.mock('../../src/main/repositories', () => ({
    createConversationRepository: () => ({create: convRepoCreate, delete: convRepoDelete, deleteBatch: convRepoDeleteBatch}),
    createMessageBlockRepository: () => ({}),
}))

vi.mock('../../src/main/window', () => ({getMainWindow: vi.fn()}))

import {BrowserWindow} from 'electron'
import {initConversationIPC} from '../../src/main/conversation'

function makeWindow(id: number) {
    const webContents = {send: vi.fn()}
    return {id, webContents, isDestroyed: () => false}
}

describe('conversation-delete 跨窗口广播', () => {
    let handler: (e: any, ...args: any[]) => Promise<boolean>

    beforeEach(() => {
        vi.clearAllMocks()
        initConversationIPC()
        const call = ipcMainHandle.mock.calls.find(c => c[0] === 'conversation-delete')
        expect(call).toBeTruthy()
        handler = call![1]
    })

    it('单删成功后，向其他窗口广播 conversation-deleted（含 ids）', async () => {
        const dialogWin = makeWindow(2)
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any, dialogWin as any])
        convRepoDelete.mockReturnValue(true)

        const ok = await handler({sender: dialogWin.webContents}, 'conv-del')

        expect(ok).toBe(true)
        expect(mainWin.webContents.send).toHaveBeenCalledWith('conversation-deleted', {ids: ['conv-del']})
        expect(dialogWin.webContents.send).not.toHaveBeenCalled()
    })

    it('删除失败时不广播', async () => {
        const dialogWin = makeWindow(2)
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any, dialogWin as any])
        convRepoDelete.mockReturnValue(false)

        const ok = await handler({sender: dialogWin.webContents}, 'conv-del')

        expect(ok).toBe(false)
        expect(mainWin.webContents.send).not.toHaveBeenCalled()
    })
})

describe('conversation-delete-batch 跨窗口广播', () => {
    let handler: (e: any, ids: string[]) => Promise<boolean>

    beforeEach(() => {
        vi.clearAllMocks()
        initConversationIPC()
        const call = ipcMainHandle.mock.calls.find(c => c[0] === 'conversation-delete-batch')
        expect(call).toBeTruthy()
        handler = call![1]
    })

    it('批量删除成功后，向其他窗口广播 conversation-deleted（含全部 ids）', async () => {
        const dialogWin = makeWindow(2)
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any, dialogWin as any])
        convRepoDeleteBatch.mockReturnValue(true)

        const ok = await handler({sender: dialogWin.webContents}, ['a', 'b'])

        expect(ok).toBe(true)
        expect(mainWin.webContents.send).toHaveBeenCalledWith('conversation-deleted', {ids: ['a', 'b']})
        expect(dialogWin.webContents.send).not.toHaveBeenCalled()
    })

    it('空数组不删除不广播', async () => {
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any])
        convRepoDeleteBatch.mockReturnValue(false)

        const ok = await handler({sender: mainWin.webContents}, [])

        expect(ok).toBe(false)
        expect(mainWin.webContents.send).not.toHaveBeenCalled()
    })
})

describe('conversation-create 跨窗口广播', () => {
    let handler: (e: any, convId: string, meta: Record<string, unknown>) => Promise<boolean>

    beforeEach(() => {
        vi.clearAllMocks()
        convRepoCreate.mockReturnValue(true)
        initConversationIPC()
        const createCall = ipcMainHandle.mock.calls.find(c => c[0] === 'conversation-create')
        expect(createCall).toBeTruthy()
        handler = createCall![1]
    })

    it('独立窗口创建会话后，向其他窗口广播 conversation-created（含 source 标记）', async () => {
        const dialogWin = makeWindow(2)
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any, dialogWin as any])

        const ok = await handler({sender: dialogWin.webContents}, 'conv-test', {
            id: 'conv-test',
            title: '新对话',
            workspacePath: 'E:/ws',
        })

        expect(ok).toBe(true)
        expect(mainWin.webContents.send).toHaveBeenCalledWith('conversation-created', expect.objectContaining({
            id: 'conv-test',
            source: 'renderer-create',
        }))
        // 发送方自身不重复收到
        expect(dialogWin.webContents.send).not.toHaveBeenCalled()
    })

    it('主窗口自己创建会话时，不向任何窗口广播（发送方排除后无其他窗口）', async () => {
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any])

        await handler({sender: mainWin.webContents}, 'conv-test2', {id: 'conv-test2'})

        expect(mainWin.webContents.send).not.toHaveBeenCalled()
    })

    it('广播 payload 必须携带 meta 中的 createdAt/updatedAt（缺省则主窗口侧栏时间显示 Invalid Date）', async () => {
        const dialogWin = makeWindow(2)
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any, dialogWin as any])

        await handler({sender: dialogWin.webContents}, 'conv-ts', {
            id: 'conv-ts',
            title: 'MCP 检查 - universal-email',
            workspacePath: 'E:/ws',
            createdAt: 1700000000000,
            updatedAt: 1700000000001,
        })

        expect(mainWin.webContents.send).toHaveBeenCalledWith('conversation-created', expect.objectContaining({
            id: 'conv-ts',
            title: 'MCP 检查 - universal-email',
            createdAt: 1700000000000,
            updatedAt: 1700000000001,
        }))
    })

    it('创建失败时不广播', async () => {
        const mainWin = makeWindow(1)
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mainWin as any])
        convRepoCreate.mockReturnValue(false)

        const ok = await handler({sender: mainWin.webContents}, 'conv-fail', {id: 'conv-fail'})

        expect(ok).toBe(false)
        expect(mainWin.webContents.send).not.toHaveBeenCalled()
    })
})
