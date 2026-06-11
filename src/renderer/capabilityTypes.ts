/**
 * 前端可用的 CapabilityEntry 接口定义
 * 与 src/main/capability/types.ts 保持同步
 */

export interface CapabilityEntry {
    id: string
    name: string
    description: string
    type: 'skill' | 'agent' | 'command'
    source: 'builtin' | 'user' | 'plugin'
    pluginName?: string
    pluginEnabled?: boolean
    enabled: boolean
    content?: string
    allowedTools?: string[]
    hasArgs?: boolean
    searchText: string
}
