import {ipcMain, BrowserWindow} from 'electron'
import {phraseStore} from './phraseStore'

function toError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'PHRASE_EMPTY') return '短语内容不能为空'
    if (message === 'PHRASE_NOT_FOUND') return '短语不存在'
    return message
}

function broadcastChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('phrase_changed', {})
    }
}

let registered = false

export function initPhraseIPC(): void {
    if (registered) return
    registered = true
    const wrap = <T>(fn: () => T) => {
        try {
            const data = fn()
            broadcastChanged()
            return {ok: true as const, data}
        } catch (err) {
            return {ok: false as const, error: toError(err)}
        }
    }
    ipcMain.handle('phrase:list', () => ({ok: true, data: phraseStore.list()}))
    ipcMain.handle('phrase:create', (_e, input) => wrap(() => {
        if (!input?.content?.trim()) throw new Error('PHRASE_EMPTY')
        return phraseStore.create(input)
    }))
    ipcMain.handle('phrase:update', (_e, {id, patch}) => wrap(() => phraseStore.update(id, patch)))
    ipcMain.handle('phrase:delete', (_e, id) => wrap(() => phraseStore.remove(id)))
    ipcMain.handle('phrase:touch', (_e, id) => wrap(() => phraseStore.touch(id)))
}

// 模块加载即注册（幂等），主进程启动时调用 initPhraseIPC() 兼容两种用法
initPhraseIPC()
