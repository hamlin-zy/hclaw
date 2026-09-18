// propagateSettings.ts —— 统一设置写后传播（spec §6.3）
//
// SCC 约束（勿回退）：本模块被 manager.impl.ts（SCC#1 成员）静态 import，
// 禁止 import agent/manager、agent/ipc 等回达 manager 的模块（否则并入 SCC#1，
// tests/main/deps/circularBoundary.test.ts 超限）；运行中会话查询、Worker 广播、
// 全局权限应用均通过 PropagationDeps 依赖注入。
import {BrowserWindow} from 'electron'
import type {SystemSettings} from '@shared/types'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {logger} from '../agent/logger'

export interface PropagationDeps {
    getRunningConversations: () => string[]
    broadcastSettings: (conversationId: string, settings: SystemSettings) => void
    applyGlobalPermissionMode: (mode: 'safe' | 'auto') => Promise<void>
}

/** 统一写后传播：全局权威键 → 运行中 Worker 广播 → 其余窗口通知 + 全局快捷键同步 */
export async function propagateSystemSettings(
    settings: SystemSettings,
    deps: PropagationDeps,
    opts: {excludeWebContentsId?: number} = {},
): Promise<void> {
    // ① 全局权威键：存在才写、无条件写（不做 prev===new 守卫——存量数据可能已达成
    //    prev===new 但同步链断裂，守卫会永久跳过修复；见 spec §6.3）
    const permMode = settings.agent?.defaultPermissionMode
    if (permMode) {
        try {
            await deps.applyGlobalPermissionMode(permMode)
        } catch (err) {
            logger.warn('[propagateSystemSettings] permission mode sync failed', {error: err instanceof Error ? err.message : String(err)})
        }
    }
    const dispMode = settings.agent?.defaultDisplayMode
    if (dispMode) {
        try {
            systemSettingsRepo.setJson('message-display-mode', {mode: dispMode})
        } catch (err) {
            logger.warn('[propagateSystemSettings] display mode sync failed', {error: err instanceof Error ? err.message : String(err)})
        }
    }

    // ② 运行中 Worker 广播（Worker 内 currentSettings 生效）
    for (const conversationId of deps.getRunningConversations()) {
        deps.broadcastSettings(conversationId, settings)
    }

    // ③ 其余窗口 settings-changed + 全局快捷键同步（动态 import 维持 config.ts 原行为）
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        if (opts.excludeWebContentsId !== undefined && win.webContents.id === opts.excludeWebContentsId) continue
        win.webContents.send('settings-changed', settings)
    }
    try {
        const {syncGlobalShortcuts} = await import('../shortcuts')
        const failures = syncGlobalShortcuts(settings.shortcuts?.overrides)
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('shortcuts-global-failures', failures)
        }
    } catch (err) {
        logger.warn('[propagateSystemSettings] global shortcuts sync failed', {error: err instanceof Error ? err.message : String(err)})
    }
}
