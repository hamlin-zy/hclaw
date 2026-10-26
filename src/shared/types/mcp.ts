/**
 * MCP 工具调用「不限时」哨兵值（毫秒）：2^31-1 ≈ 24.8 天。
 *
 * 语义：MCP 工具调用**默认不设超时**。理由是 MCP 工具的耗时完全由对端 server
 * 决定（逆向分析、浏览器抓取、大模型推理都可能是分钟级以上），固定 60s 会把
 * 合法长调用判成失败；且失败后 Agent 往往重试同一调用，反而更慢。
 *
 * 为什么不是 `Infinity` / 0：Node 的 `setTimeout` 只接受有限 delay，
 * `Infinity` 与 >2^31-1 都会被 clamp 成 1ms → **立即**触发超时（静默反向生效）。
 * 故取定时器上限本身作哨兵：对所有真实调用等价于「不超时」。
 *
 * 单一真源（缺一即某一层仍按 60s 杀调用）：
 *
 * 计时层（4 处，任一漏改即该层按 60s 杀调用）：
 *   1. main/agent/mcp/client.ts        — SDK 运行期请求超时
 *   2. main/agent/mcp/discovery.ts     — proxy.execute 内层 withToolTimeout
 *   3. main/config/mcpConfig.ts 等     — 配置缺省值（未显式配置的 server）
 *   4. renderer/components/dialogs/MCPEditCard.tsx — UI 默认值/上限
 *
 * 配置映射点（漏任一处即某通道重回 60s）：
 *   - main/config/mcpConfig.ts                     — 解析 / 序列化 / 插件覆盖
 *   - main/agent/mcp/pluginServers.ts              — 插件 server 映射
 *   - main/config/migrateMcpHookFromSqlite.ts      — 存量迁移
 *   - renderer/lib/sqliteStorage.ts                — 渲染层持久化
 *   - renderer/stores/mcpStore.ts                  — store 字段透传
 *
 * ⚠️ executor 的外层 withToolTimeout 对 MCP 工具**整体跳过**（见 SKIP_OUTER_TIMEOUT_TOOLS
 *    的动态判定），不经本常量 —— 外层跳过后由 discovery 内层与 SDK 层共同承担。
 */
export const MCP_TOOL_TIMEOUT_NO_LIMIT_MS = 2_147_483_647

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
    /**
     * 工具调用超时（毫秒）。
     * 缺省 = MCP_TOOL_TIMEOUT_NO_LIMIT_MS（不限时，见该常量说明）。
     * 显式配置更小值即可为单个 server 收紧超时。
     */
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
