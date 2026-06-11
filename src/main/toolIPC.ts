import {ipcMain} from 'electron'
import {toolRepo} from './repositories/sqlite/toolRepository'
import {toolRegistry} from './agent/tools/registry'

// ─── IPC 结果包装工具 ─────────────────────────────────

type SyncResult<T> = { success: true; data: T } | { success: false; error: string }
type VoidResult = { success: true } | { success: false; error: string }

function wrapSync<T>(fn: () => T): SyncResult<T> {
    try {
        return {success: true, data: fn()}
    } catch (err) {
        return {success: false, error: String(err)}
    }
}

function wrapVoid(fn: () => void): VoidResult {
    try {
        fn();
        return {success: true}
    } catch (err) {
        return {success: false, error: String(err)}
    }
}

// ─── IPC Handlers ──────────────────────────────────────

/**
 * 注册工具管理的 IPC handlers
 */
export function initToolIPC(): void {
    ipcMain.handle('tool:list', async () => {
        try {
            const allTools = toolRegistry.getAll()
            const dbTools = toolRepo.list()
            const dbMap = new Map(dbTools.map(t => [t.id, t]))
            const tools = allTools.map(tool => ({
                id: tool.name,
                name: tool.name,
                description: tool.description,
                enabled: dbMap.get(tool.name)?.enabled ?? true,
                timeout: dbMap.get(tool.name)?.timeout ?? null,
            }))
            return {success: true, data: tools}
        } catch (err) {
            return {success: false, error: String(err)}
        }
    })

    ipcMain.handle('tool:setEnabled', async (_, id: string, enabled: boolean) =>
        wrapVoid(() => toolRepo.setEnabled(id, enabled)))

    ipcMain.handle('tool:setEnabledBatch', async (_, updates: Array<{ id: string; enabled: boolean }>) =>
        wrapVoid(() => toolRepo.setEnabledBatch(updates)))

    ipcMain.handle('tool:getTimeout', async (_, id: string) =>
        wrapSync(() => toolRepo.getTimeout(id)))

    ipcMain.handle('tool:setTimeout', async (_, id: string, timeout: number | null) =>
        wrapVoid(() => toolRepo.setTimeout(id, timeout)))
}
