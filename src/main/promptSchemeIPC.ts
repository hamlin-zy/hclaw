import {ipcMain, IpcMainInvokeEvent} from 'electron'
import {promptSchemeRepo} from './repositories/sqlite/promptSchemeRepository'
import {promptResolver} from './agent/prompts/resolver'

/** 包装 IPC handler，自动处理 try-catch 并返回统一格式 */
function handle<T>(fn: (event: IpcMainInvokeEvent, ...args: any[]) => T) {
    return async (event: IpcMainInvokeEvent, ...args: any[]) => {
        try {
            const result = await fn(event, ...args)
            return result !== undefined ? {success: true, data: result} : {success: true}
        } catch (err) {
            console.error('[PromptSchemeIPC] handler error:', err)
            return {success: false, error: String(err)}
        }
    }
}

export function initPromptSchemeIPC(): void {

    ipcMain.handle('prompt-scheme:list', handle(() => promptSchemeRepo.list()))

    ipcMain.handle('prompt-scheme:get', handle((_, id: string) => promptSchemeRepo.getById(id)))

    ipcMain.handle('prompt-scheme:save', handle((_, scheme: any) => promptSchemeRepo.save(scheme)))

    ipcMain.handle('prompt-scheme:delete', handle((_, id: string) => promptSchemeRepo.delete(id)))

    ipcMain.handle('prompt-scheme:get-active-id', handle(() => promptSchemeRepo.getActiveId()))

    // 激活/切换提示词方案 - 更新 PromptResolver + 持久化
    ipcMain.handle('update-prompt-scheme', handle((_, schemeId: string | null) => {
        // 持久化到 system_settings
        promptSchemeRepo.setActiveId(schemeId)

        const scheme = schemeId ? promptSchemeRepo.getById(schemeId) : null
        if (scheme) {
            promptResolver.loadScheme(scheme)
        } else {
            promptResolver.reset() // 无激活方案或无此 ID 时，用代码兜底
        }
    }))

}
