/**
 * 配置变更广播 — 定时任务域通知渲染层的**唯一出口**。
 *
 * 两条触发路径都收敛到这里，所以它们广播的口径必然一致（通道 / 载荷 / 接收方三者相同）：
 * - 界面路径：scheduleIPC 的写通道（create / update / delete / pause / resume）
 * - 工具路径：scheduler_manage 工具 → context.onEvent → agent manager 转发到此
 *
 * 历史偏差：工具路径只发给主窗口，IPC 路径发给所有窗口；同一件事两个口径。
 * 合并后统一发给**所有未销毁的窗口**——定时任务窗口是 ConfigDialogWindow，不是主窗口，
 * 只发主窗口会让工具路径的改动在配置窗口里不可见。
 *
 * 不新增 IPC 通道：载荷走既有 `schedules-changed` 通道。
 */
import {BrowserWindow} from 'electron'
import type {ScheduleChangePayload} from '@shared/types/schedule'

/** 向所有窗口广播一次配置变更（载荷是可区分的 created / updated / deleted） */
export function broadcastSchedulesChanged(change: ScheduleChangePayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('schedules-changed', change)
  }
}
