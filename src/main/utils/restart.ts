import { app } from 'electron';
import { mcpWorkerManager } from '../agent/mcp/mcpWorkerManager';

/**
 * 优雅重启：依次执行 relaunch 标记 → MCP 服务关闭 → 进程退出。
 * 调用前应确保所有需要持久化的状态已刷盘。
 */
export async function gracefulRestart(): Promise<void> {
    app.relaunch();
    try {
        await mcpWorkerManager.shutdown();
    } finally {
        app.exit(0);
    }
}
