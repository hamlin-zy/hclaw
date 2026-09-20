/** 从 name 哈希派生稳定 id（各配置文件共用同算法，前缀由调用方拼，如 'mcp' / 'companion'） */
export function hashName(prefix: string, name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        const char = name.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
    }
    return `${prefix}-${Math.abs(hash).toString(36)}`
}
