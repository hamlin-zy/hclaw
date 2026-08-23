import {McpWatcher} from './mcpWatcher'

let mcpWatcher: McpWatcher | null = null

export function startConfigWatcher(): void {
    mcpWatcher = new McpWatcher()
    mcpWatcher.start()
}

export function stopConfigWatcher(): void {
    mcpWatcher?.stop()
}
