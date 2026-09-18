/**
 * 进程树终止工具（内存泄漏 B 批 Task 1 起：调度脚本任务、技能脚本执行器共用）
 *
 * 为什么需要「树杀」而不是 Node 内建的 child.kill()：
 * 内建 kill 只结束**根进程**。Windows 上根进程一退出，`taskkill /F /T` 就再也遍历不到
 * 它的子孙（树已经断开），由中继/解释器拉起的子进程因此成为孤儿——继续持有句柄、占着
 * 内存（参见 src/main/agent/mcp/client.ts 里同源的注释）。所以取消/超时路径必须在
 * **根进程仍然存活**时按 PID 树杀，再等 child 的 `close` 事件结算。
 *
 * 范围：只服务本批的两个新接点（scheduler 的脚本任务、skills/scriptExecutor）；
 * 既有的局部树杀实现（MCP transport、shellPool、versionManager 等）保持不动。
 */
import {execSync} from 'child_process'

/**
 * 强制终止 pid 及其全部子孙进程。
 *
 * 同步语义：调用方要的是「杀完再等 close」，异步化只会把同一次等待拆到两处；
 * 2s 超时兜底保证 taskkill 自身异常/无响应时不会挂住调用方。
 * 进程已退出（taskkill 返回非 0）、pid 缺失（spawn 尚未落地）都视为目标状态已达成。
 */
export function killProcessTree(pid: number | undefined): void {
    if (!pid) return
    try {
        if (process.platform === 'win32') {
            // stdio 全忽略：taskkill 的失败输出（「没有找到进程」）不需要回显到宿主 stderr
            execSync(`taskkill /F /T /PID ${pid}`, {timeout: 2000, windowsHide: true, stdio: 'ignore'})
        } else {
            // POSIX 无 PID 树遍历能力：退化为只杀根进程（与改造前 child.kill 同等效力）
            process.kill(pid, 'SIGKILL')
        }
    } catch {
        // 静默：非 0 退出 = 进程已不存在（Windows taskkill / POSIX ESRCH），没有可补救的动作
    }
}
