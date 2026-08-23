// src/main/ipc/taskBatches.ts
import {ipcMain} from 'electron'
import {
    getActiveBatch,
    listBatches,
    deleteBatches,
    getTasksByBatchId,
    getConversationIdsByBatchIds,
} from '../repositories/sqlite/taskBatchRepository'
import {broadcastToOtherWindows} from '../utils/windowBroadcast'

/**
 * 任务批次查询/删除 IPC 通道（历史任务组窗口数据源）
 * - get-active：指定会话当前活跃批次（含任务明细）
 * - list：按会话分组的批次列表（支持 filter/conversationId/workspaceId 过滤，
 *   其中 workspaceId 实际取值为工作区路径，见 listBatches 注释）
 * - get-tasks：指定批次的任务明细（历史窗口展开行懒加载）
 * - delete：删除批次并返回实际删除数；成功后广播 task-batches-changed，
 *   其他窗口（主窗口）据此刷新 TodoStrip 残留的活跃批次态
 */
export function initTaskBatchIPC(): void {
    ipcMain.handle('task-batches:get-active', (_e, conversationId: string) =>
        getActiveBatch(conversationId),
    )

    ipcMain.handle('task-batches:list', (_e, opts?: Parameters<typeof listBatches>[0]) =>
        listBatches(opts),
    )

    ipcMain.handle('task-batches:get-tasks', (_e, batchId: string) =>
        getTasksByBatchId(batchId),
    )

    ipcMain.handle('task-batches:delete', (event, ids: string[]) => {
        const conversationIds = getConversationIdsByBatchIds(ids)
        const deleted = deleteBatches(ids)
        if (deleted > 0) {
            broadcastToOtherWindows(event, 'task-batches-changed', {conversationIds})
        }
        return {deleted}
    })
}
