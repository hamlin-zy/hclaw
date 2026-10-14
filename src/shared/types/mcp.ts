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
    /** 只读守卫白名单：与 denyList 同口径的 MCP 原始工具名，命中即视为只读 */
    readOnlyTools?: string[]
    /** 只读守卫黑名单：与 denyList 同口径的 MCP 原始工具名，命中即视为写工具 */
    writeTools?: string[]
    /** 未知工具的判定策略，缺省=拦（fail-closed）；缺省不落盘，以区分「未配置」与「显式 deny」 */
    unknownPolicy?: 'allow' | 'deny'
    /** Remote version check URL (optional, for local binary servers). Supports GitHub releases API or custom JSON endpoint. */
    checkUrl?: string
}
