import {ipcMain} from 'electron'
import {toolRepo} from './repositories/sqlite/toolRepository'
import {toolRegistry} from './agent/tools/registry'
import {ALWAYS_ON_TOOLS} from './agent/constants'
import {broadcastToOtherWindows} from './utils/windowBroadcast'

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

    ipcMain.handle('tool:setEnabled', async (event, id: string, enabled: boolean) => {
        if (ALWAYS_ON_TOOLS.has(id)) {
            return {success: false, error: `${id} 为能力驱动工具（图片/音频理解），不可手动禁用`}
        }
        const result = wrapVoid(() => toolRepo.setEnabled(id, enabled))
        if (result.success) broadcastToOtherWindows(event, 'tools-changed')
        return result
    })

    ipcMain.handle('tool:setEnabledBatch', async (event, updates: Array<{ id: string; enabled: boolean }>) => {
        if (updates.some(u => ALWAYS_ON_TOOLS.has(u.id))) {
            return {success: false, error: '包含能力驱动工具（analyze_image / speech_to_text），拒绝批量修改'}
        }
        const result = wrapVoid(() => toolRepo.setEnabledBatch(updates))
        if (result.success) broadcastToOtherWindows(event, 'tools-changed')
        return result
    })

    ipcMain.handle('tool:getTimeout', async (_, id: string) =>
        wrapSync(() => toolRepo.getTimeout(id)))

    ipcMain.handle('tool:setTimeout', async (event, id: string, timeout: number | null) => {
        const result = wrapVoid(() => toolRepo.setTimeout(id, timeout))
        if (result.success) broadcastToOtherWindows(event, 'tools-changed')
        return result
    })
}
