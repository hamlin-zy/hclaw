/**
 * Memo IPC — 通道注册 + memo_changed 跨窗口广播（spec §5/§9）
 * 返回约定：{ok: true, data} | {ok: false, error}（渲染层 toast）
 */
import {ipcMain, BrowserWindow} from 'electron'
import {memoStore} from './memoStore'

function toError(err: unknown): string {
    const message = err instanceof Error ? err.message : err
    if (message === 'MEMO_EMPTY') return '标题不能为空，且正文与附件不可同时为空'
    if (message === 'MEMO_NOT_FOUND') return '备忘录不存在'
    return String(message)
}

function broadcastChanged(workspacePath: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('memo_changed', {workspacePath})
    }
}

let registered = false

export function initMemoIPC(): void {
    if (registered) return
    registered = true
    const wrap = <T>(workspacePath: string | undefined, fn: () => T) => {
        try {
            const data = fn()
            if (workspacePath) broadcastChanged(workspacePath)
            return {ok: true as const, data}
        } catch (err) {
            return {ok: false as const, error: toError(err)}
        }
    }
    // wrap 的异步版：同步 wrap 传入返回 Promise 的 fn 时，Promise 会被嵌入 data 报 "An object could not be cloned"
    const wrapAsync = async <T>(fn: () => T | Promise<T>) => {
        try {
            return {ok: true as const, data: await fn()}
        } catch (err) {
            return {ok: false as const, error: toError(err)}
        }
    }

    ipcMain.handle('memo:list', (_e, workspacePath: string) => ({ok: true, data: memoStore.list(workspacePath)}))
    ipcMain.handle('memo:create', (_e, input) => wrap(input.workspacePath, () => {
        // 空标题 / 空内容+空附件前置校验（memoStore 亦有同样校验，双保险保证结构化错误）
        if (!input.title?.trim() || (!input.content?.trim() && !(input.attachments?.length))) throw new Error('MEMO_EMPTY')
        return memoStore.create(input)
    }))
    ipcMain.handle('memo:getById', (_e, id: string) => {
        try {
            const item = memoStore.findById(id)
            if (!item) throw new Error('MEMO_NOT_FOUND')
            return {ok: true as const, data: item}
        } catch (err) {
            return {ok: false as const, error: toError(err)}
        }
    })
    ipcMain.handle('memo:update', (_e, {id, patch}) => wrap(memoStore.findById(id)?.workspacePath, () => memoStore.update(id, patch)))
    ipcMain.handle('memo:delete', (_e, id: string) => wrap(memoStore.findById(id)?.workspacePath, () => memoStore.remove(id)))
    // uploadAttachment / discardPending 无需广播，走 wrapAsync（同步 wrap 会把 Promise 嵌入 data 导致 clone 失败）
    ipcMain.handle('memo:uploadAttachment', (_e, input) => wrapAsync(() => memoStore.uploadAttachment(input)))
    ipcMain.handle('memo:discardPending', (_e, ids: string[]) => wrapAsync(() => memoStore.discardPending(ids)))
    ipcMain.handle('memo:createSession', (e, id: string) => wrapAsync(async () => {
        const data = await memoStore.createSessionFromMemo(id)
        broadcastChanged(memoStore.findById(id)?.workspacePath ?? '')
        return data
    }))
}

// 模块加载即注册（幂等），主进程启动时调用 initMemoIPC() 兼容两种用法
initMemoIPC()
