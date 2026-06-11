/**
 * MCP 进程工具函数
 *
 * 从旧 StdioTransport 中提取，用于 PID 追踪和进程清理。
 * 被 MCPClient.stopServer() 和 MCPWorkerManager 引用。
 */

/** PID 确认轮询间隔（毫秒） */
const PID_VERIFY_POLL_MS = 200

/** PID 确认总超时（毫秒） */
const PID_VERIFY_TIMEOUT = 5_000

/**
 * 检查指定 PID 的进程是否仍在运行
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询确认进程已完全退出
 * @returns true = 进程已退出, false = 超时仍未退出
 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs: number = PID_VERIFY_TIMEOUT,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true
    }
    await new Promise(r => setTimeout(r, PID_VERIFY_POLL_MS))
  }
  return !isProcessRunning(pid)
}
