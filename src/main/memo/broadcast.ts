/**
 * memo_changed 跨窗口广播 — memoIPC 与内置工具 memo_tool 共用（spec §5/§9）
 */
import {BrowserWindow} from 'electron'

/** 向所有未销毁窗口广播备忘录变更 */
export function broadcastMemoChanged(workspacePath: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('memo_changed', {workspacePath})
    }
}
