import {BrowserWindow} from 'electron'

/**
 * 广播事件给除发起窗口外的所有渲染窗口（跨窗口数据一致性）。
 *
 * 背景：配置窗口独立化后，各窗口持有独立 JS 堆与独立 store 实例。
 * 配置窗口写路径落库后，其他窗口（主窗口）的 store 需感知变更并重新
 * hydration。主进程各写路径 handler 成功后调用本函数广播。
 * 跳过发起窗口（发起窗口自身 store 已是最新，避免无谓重渲染）。
 */
export function broadcastToOtherWindows(event: Electron.IpcMainInvokeEvent, channel: string, payload?: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents !== event.sender) {
            // send(channel, undefined) 与 send(channel) 对渲染端等价，统一带 payload 参数即可
            win.webContents.send(channel, payload)
        }
    }
}

/**
 * 广播事件给所有渲染窗口（含发起窗口）。
 *
 * 用于发起窗口自身 store 不会主动更新的路径（如仓库版本切换/同步后红点状态），
 * 发起窗口需要靠推送刷新 updateMap。
 */
export function broadcastToAllWindows(channel: string, payload?: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send(channel, payload)
        }
    }
}
