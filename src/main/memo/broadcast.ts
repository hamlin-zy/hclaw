/**
 * memo_changed 跨窗口广播 — memoIPC 与内置工具 memo_tool 共用（spec §5/§9）
 *
 * 环境感知双路径：
 * - 主进程（memoIPC 调用方）：直接遍历 BrowserWindow 广播到渲染端
 * - Worker 线程（内置工具 memo_tool）：electron 的 BrowserWindow 不可用（运行时为 undefined），
 *   经 parentPort.postMessage 发送 'memo_changed'，由主进程 AgentManager 转发广播
 *
 * 说明：electron 仍为顶层 import（memoTool 本就经本模块间接引入 electron，worker 内可解析，
 * 仅 BrowserWindow 运行时不可用），通过 isMainThread 分支保证 worker 绝不触碰 BrowserWindow。
 * 顶层 try/catch 兜底：任何环境下广播失败都不影响工具执行结果。
 */
import {BrowserWindow} from 'electron'
import {isMainThread, parentPort} from 'worker_threads'
import {logger} from '../agent/logger'

/** 向所有未销毁窗口广播备忘录变更（任何环境下都不抛异常影响调用方） */
export function broadcastMemoChanged(workspacePath: string): void {
    try {
        if (isMainThread) {
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send('memo_changed', {workspacePath})
            }
            return
        }
        // Worker 线程：转发给主进程统一广播
        parentPort?.postMessage({type: 'memo_changed', workspacePath})
    } catch (err) {
        // 广播失败不影响工具执行结果，仅记日志
        logger.warn(`[memo] broadcastMemoChanged 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
}
