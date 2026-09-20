import { ipcMain } from 'electron';

/**
 * 幂等注册 ipcMain.handle：同 channel 重复注册前先移除旧 handler（窗口重开 / 重复 init 场景）。
 * ★ 不能用 ipcMain.listenerCount 判定：ipcMain.handle 不写入 EventEmitter 的 listener
 *   列表，listenerCount 恒为 0 → 守卫恒真、无幂等效果，重复 init 会抛
 *   "Attempted to register a second handler for 'xxx'"。
 */
export function safeHandle(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
}
