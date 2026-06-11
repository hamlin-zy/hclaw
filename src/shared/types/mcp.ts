export interface McpServer {
    id: string
    name: string
    transport: string
    command: string
    args: string[]
    env: Record<string, string>
    url: string
    headers?: Record<string, string>
    userDescription: string
    enabled: boolean
    /** 工作目录（stdio 模式） */
    cwd?: string
    /** 工具调用超时（毫秒），默认 60000 */
    timeout?: number
    /** 自动批准的工具名称列表 */
    autoApprove?: string[]
    /** 拒绝调用的工具名称列表 */
    denyList?: string[]
}
