import {describe, it, expect, vi, beforeEach} from 'vitest'

type IpcHandler = (e: unknown, ...args: unknown[]) => Record<string, unknown>

const mocks = vi.hoisted(() => ({
    handle: {} as Record<string, IpcHandler>,
    send: vi.fn(),
}))
vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: IpcHandler) => { mocks.handle[ch] = fn }},
    BrowserWindow: {getAllWindows: () => [{isDestroyed: () => false, webContents: {send: mocks.send}}]},
}))
vi.mock('../../../src/main/memo/memoStore', () => ({
    memoStore: {
        list: vi.fn(() => []),
        create: vi.fn(() => ({id: 'memo-1'})),
        update: vi.fn(() => ({id: 'memo-1'})),
        remove: vi.fn(),
        uploadAttachment: vi.fn(),
        discardPending: vi.fn(),
        createSessionFromMemo: vi.fn(async () => ({convId: 'conv-1'})),
        findById: vi.fn(() => ({workspacePath: 'E:\\p', attachments: []})),
    },
}))

import '../../../src/main/memo/memoIPC'

describe('memoIPC', () => {
    beforeEach(() => { mocks.send.mockClear() })

    it('注册全部通道', () => {
        for (const ch of ['memo:list', 'memo:create', 'memo:update', 'memo:delete',
            'memo:uploadAttachment', 'memo:discardPending', 'memo:createSession']) {
            expect(mocks.handle[ch]).toBeDefined()
        }
    })

    it('create: 标题为空 → 返回结构化错误（文案涵盖标题）', async () => {
        const result = await mocks.handle['memo:create']({}, {workspacePath: 'E:\\p', title: '  ', content: 'c', attachments: []})
        expect(result.ok).toBe(false)
        expect(result.error).toContain('标题不能为空')
    })

    it('create: content 与 attachments 同时为空 → 返回结构化错误', async () => {
        const result = await mocks.handle['memo:create']({}, {workspacePath: 'E:\\p', title: 'T', content: '  ', attachments: []})
        expect(result.ok).toBe(false)
        expect(result.error).toContain('正文与附件不可同时为空')
    })

    it('createSession 成功 → 广播 memo_changed（携带 workspacePath）+ 返回 convId', async () => {
        const result = await mocks.handle['memo:createSession']({}, 'memo-1')
        expect(result).toEqual({ok: true, data: {convId: 'conv-1'}})
        expect(mocks.send).toHaveBeenCalledWith('memo_changed', expect.objectContaining({workspacePath: 'E:\\p'}))
    })

    it('memoId 不存在 → 结构化错误而非 throw', async () => {
        const {memoStore} = await import('../../../src/main/memo/memoStore')
        vi.mocked(memoStore.createSessionFromMemo).mockRejectedValueOnce(new Error('MEMO_NOT_FOUND'))
        const result = await mocks.handle['memo:createSession']({}, 'memo-none')
        expect(result.ok).toBe(false)
    })
})
