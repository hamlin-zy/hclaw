/**
 * 权限模式 & 权限规则 IPC handlers
 */

import {ipcMain} from 'electron'
import {permissionEngine} from '../tools/permission'
import {agentManager} from '../manager'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'
import {logger} from '../logger'

export function registerHandlers(): void {
    // 获取权限模式
    ipcMain.handle('agent-get-permission-mode', async () => {
        return permissionEngine.getMode()
    })

    // 设置权限模式
    ipcMain.handle('agent-set-permission-mode', async (_event, mode: string) => {
        await permissionEngine.setMode(mode as any)
        // 广播到所有运行中的 Worker
        agentManager.broadcastPermissionModeUpdate(mode as any)
        return {success: true}
    })

    // 获取所有权限规则
    ipcMain.handle('agent-get-permission-rules', async () => {
        return permissionEngine.getRules()
    })

    // 清理并保存权限规则（去重并更新文件）
    ipcMain.handle('agent-clean-permission-rules', async () => {
        await permissionEngine.cleanAndSave()
        // 返回清理后的规则列表
        return permissionEngine.getRules()
    })

    // 添加权限规则
    ipcMain.handle('agent-add-permission-rule', async (_event, rule: any) => {
        await permissionEngine.addRule(rule)
        return {success: true}
    })

    // 删除权限规则
    ipcMain.handle('agent-remove-permission-rule', async (_event, toolName: string) => {
        await permissionEngine.removeRulesForTool(toolName)
        return {success: true}
    })
}
