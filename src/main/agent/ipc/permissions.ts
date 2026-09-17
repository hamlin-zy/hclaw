/**
 * 权限模式 & 权限规则 IPC handlers
 */

import {ipcMain} from 'electron'
import {permissionEngine} from '../tools/permission'
import {agentManager} from '../manager'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {createConversationRepository} from '../../repositories'

export function registerHandlers(): void {
    // 获取权限模式
    ipcMain.handle('agent-get-permission-mode', async () => {
        return permissionEngine.getMode()
    })

    // 设置全局默认权限模式（新建会话默认值）。
    // 新语义：全局默认变更同步给「运行中且无会话级覆盖」的会话——
    //   - 用户在输入栏显式切过该会话（meta.permissionMode 存在）→ 不受影响，
    //     全局默认不得覆盖会话级覆盖；
    //   - 未显式覆盖的会话 → 实时更新其运行中 Worker（UPDATE_PERMISSION_MODE），
    //     否则用户改全局默认后，正在跑的会话仍按启动时模式判定（一直弹权限确认）。
    // 被同步的 convId 由 broadcastGlobalPermissionModeUpdate 内部经
    // permission-mode-synced 事件送到渲染进程，用于同步输入栏「安全/自动」显示
    // （渲染端只消费事件通道，IPC 返回体不再携带 syncedConvIds）。
    ipcMain.handle('agent-set-permission-mode', async (_event, mode: string) => {
        await permissionEngine.setMode(mode as any)
        agentManager.broadcastGlobalPermissionModeUpdate(mode as any)
        return {success: true}
    })

    // 设置会话级权限模式（方案B：安全模式会话级；写 meta + 广播目标 worker）
    // 子会话权限只读继承根会话：目标 convId 有 parentConvId 时直接拒绝，不做任何写入。
    ipcMain.handle('agent-set-conv-permission-mode', async (_event, convId: string, mode: string) => {
        if (mode !== 'safe' && mode !== 'auto') return {success: false, error: 'invalid mode'}

        let parentConvId: string | undefined
        try {
            const meta = createConversationRepository().readMeta(convId) as { parentConvId?: string } | null
            parentConvId = meta?.parentConvId
        } catch {
            parentConvId = undefined
        }
        if (parentConvId) return {success: false, error: 'inherited'}

        runtimeConfigManager.setConvPermissionMode(convId, mode as any)
        agentManager.broadcastConvPermissionMode(convId, mode as any)
        return {success: true}
    })

    // 获取所有权限规则
    ipcMain.handle('agent-get-permission-rules', async () => {
        return permissionEngine.getRules()
    })

    // 清理并保存权限规则（去重并更新文件）
    ipcMain.handle('agent-clean-permission-rules', async () => {
        await permissionEngine.cleanAndSave()
        // 规则已变更 → 通知运行中 Worker 重读（否则面板变更对运行中会话不生效）
        agentManager.broadcastPermissionRulesChanged()
        // 返回清理后的规则列表
        return permissionEngine.getRules()
    })

    // 添加权限规则
    ipcMain.handle('agent-add-permission-rule', async (_event, rule: any) => {
        await permissionEngine.addRule(rule)
        agentManager.broadcastPermissionRulesChanged()
        return {success: true}
    })

    // 删除权限规则
    ipcMain.handle('agent-remove-permission-rule', async (_event, toolName: string) => {
        await permissionEngine.removeRulesForTool(toolName)
        agentManager.broadcastPermissionRulesChanged()
        return {success: true}
    })
}
