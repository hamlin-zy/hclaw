/**
 * Sandbox 核心类型定义
 */

// ─── 沙盒策略 ──────────────────────────────────────────

export interface SandboxPolicy {
    /** 允许访问的目录白名单 */
    allowedPaths: string[]
    /** 禁止访问的路径黑名单 */
    deniedPaths: string[]
    /** 禁止执行的命令黑名单模式 */
    deniedCommands: string[]
    /** 最大命令执行超时（毫秒） */
    maxCommandTimeout: number
}

// ─── 沙盒操作请求 ──────────────────────────────────────

export type SandboxOperation =
    | { type: 'file_read'; path: string }
    | { type: 'file_write'; path: string }
    | { type: 'command_execute'; command: string; args: string[] }

// ─── 沙盒检查结果 ──────────────────────────────────────

export interface SandboxCheckResult {
    allowed: boolean
    reason?: string
    /** 是否需要用户确认 */
    needsConfirmation?: boolean
    /** 确认消息 */
    confirmationMessage?: string
    /** 风险等级 */
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
}

// ─── 沙盒接口 ──────────────────────────────────────────

export interface Sandbox {
    /** 检查操作是否允许 */
    check(operation: SandboxOperation): SandboxCheckResult

    /** 获取当前策略 */
    getPolicy(): SandboxPolicy

    /** 更新策略 */
    updatePolicy(policy: Partial<SandboxPolicy>): void

    /** 添加允许路径 */
    addAllowedPath(path: string): void

    /** 移除允许路径 */
    removeAllowedPath(path: string): void
}
