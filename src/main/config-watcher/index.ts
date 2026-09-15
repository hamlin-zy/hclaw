import {McpWatcher} from './mcpWatcher'

let mcpWatcher: McpWatcher | null = null

export function startConfigWatcher(): void {
    // 重复调用安全：先停止旧 watcher，避免旧 fs.watch 句柄泄漏
    mcpWatcher?.stop()
    mcpWatcher = new McpWatcher()
    mcpWatcher.start()
}

export function stopConfigWatcher(): void {
    mcpWatcher?.stop()
}
