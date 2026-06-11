/**
 * Sandbox 核心类型定义
 */

// ─── 沙盒策略 ──────────────────────────────────────────

export interface SandboxPolicy {
    /** 允许访问的目录白名单 */
    allowedPaths: string[]
    /** 禁止访问的路径黑名单 */
    deniedPaths: string[]
    /** 允许执行的命令白名单模式 */
    allowedCommands?: string[]
    /** 禁止执行的命令黑名单模式 */
    deniedCommands: string[]
    /** 最大文件大小（字节） */
    maxFileSize: number
    /** 最大命令执行超时（毫秒） */
    maxCommandTimeout: number
    /** 禁止的网络目标 */
    deniedNetworkTargets?: string[]
}

// ─── 沙盒操作请求 ──────────────────────────────────────

export type SandboxOperation =
    | { type: 'file_read'; path: string }
    | { type: 'file_write'; path: string; size: number }
    | { type: 'file_delete'; path: string }
    | { type: 'command_execute'; command: string; args: string[] }
    | { type: 'network_request'; url: string }

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

// ─── 沙盒审计记录 ──────────────────────────────────────

export interface SandboxAuditEntry {
    id: string
    timestamp: number
    operation: SandboxOperation
    result: 'allowed' | 'denied' | 'confirmed' | 'failed'
    reason?: string
    conversationId?: string
    agentId?: string
}

// ─── 沙盒接口 ──────────────────────────────────────────

export interface Sandbox {
    /** 检查操作是否允许 */
    check(operation: SandboxOperation): SandboxCheckResult

    /** 记录审计日志 */
    audit(entry: Omit<SandboxAuditEntry, 'id' | 'timestamp'>): void

    /** 获取审计日志 */
    getAuditLog(limit?: number): SandboxAuditEntry[]

    /** 清空审计日志 */
    clearAuditLog(): void

    /** 获取当前策略 */
    getPolicy(): SandboxPolicy

    /** 更新策略 */
    updatePolicy(policy: Partial<SandboxPolicy>): void

    /** 添加允许路径 */
    addAllowedPath(path: string): void

    /** 移除允许路径 */
    removeAllowedPath(path: string): void
}
