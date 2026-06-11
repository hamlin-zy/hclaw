import {McpWatcher} from './mcpWatcher'
import {HookWatcher} from './hookWatcher'

let mcpWatcher: McpWatcher | null = null
let hookWatcher: HookWatcher | null = null

export function startConfigWatcher(): void {
    mcpWatcher = new McpWatcher()
    hookWatcher = new HookWatcher()
    mcpWatcher.start()
    hookWatcher.start()
}

export function stopConfigWatcher(): void {
    mcpWatcher?.stop()
    hookWatcher?.stop()
}
