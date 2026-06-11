/**
 * 本地安全沙盒实现
 *
 * 安全策略：
 * 1. 路径白名单 — 工具只能在用户选定的工作目录内操作
 * 2. 破坏性操作确认 — isDestructive 标记的工具需用户确认
 * 3. 操作审计日志 — 所有文件/命令操作记录到审计日志
 * 4. 命令黑名单 — 阻止高危命令 (rm -rf, format, del /s 等)
 *
 * 职责边界：
 * - LocalSandbox: 执行时的二次安全检查（高危命令拦截、路径限制）
 * - PermissionEngine: 决策层的权限检查（命令白名单、用户规则匹配）
 *
 * 架构原则：
 * - LocalSandbox 使用 PermissionEngine.isHighRisk() 复用高危检测
 * - 不重复定义危险命令模式，保持单一真相源
 */

import * as path from 'path'
import type {Sandbox, SandboxAuditEntry, SandboxCheckResult, SandboxOperation, SandboxPolicy,} from './types'
import {permissionEngine} from '../agent/tools/permission'

// ─── 默认策略 ──────────────────────────────────────────

const DEFAULT_DENIED_COMMANDS = [
    'rm -rf /',
    'rm -rf /*',
    'del /s /q C:\\',
    'format *',
    'mkfs.*',
    'dd if=',
    ':(){:|:&};:',      // fork bomb
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'systemctl stop',
    'net user * /delete',
    'reg delete',
    'regsvr32 /u',
]

const DEFAULT_POLICY: SandboxPolicy = {
    allowedPaths: [],
    deniedPaths: [
        '/etc',
        '/System',
        'C:\\Windows\\System32',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
    ],
    deniedCommands: DEFAULT_DENIED_COMMANDS,
    maxFileSize: 10 * 1024 * 1024, // 10 MB
    maxCommandTimeout: 120_000, // 2 分钟
}

// ─── LocalSandbox ──────────────────────────────────────

export class LocalSandbox implements Sandbox {
    private policy: SandboxPolicy
    private auditLog: SandboxAuditEntry[] = []
    private maxAuditEntries = 10_000

    constructor(initialPaths: string[] = []) {
        this.policy = {
            ...DEFAULT_POLICY,
            allowedPaths: [...initialPaths],
        }
    }

    // ─── 操作检查 ────────────────────────────────────────

    check(operation: SandboxOperation): SandboxCheckResult {
        switch (operation.type) {
            case 'file_read':
                return this.checkFileAccess(operation.path, 'read')

            case 'file_write':
                return this.checkFileAccess(operation.path, 'write')

            case 'file_delete':
                return this.checkFileAccess(operation.path, 'delete')

            case 'command_execute':
                return this.checkCommand(operation.command, operation.args)

            case 'network_request':
                return this.checkNetwork(operation.url)

            default:
                return {
                    allowed: false,
                    reason: `未知操作类型`,
                    riskLevel: 'high',
                }
        }
    }

    // ─── 审计日志 ────────────────────────────────────────

    audit(entry: Omit<SandboxAuditEntry, 'id' | 'timestamp'>): void {
        const fullEntry: SandboxAuditEntry = {
            id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            ...entry,
        }

        this.auditLog.push(fullEntry)

        // 超限时移除最早的
        if (this.auditLog.length > this.maxAuditEntries) {
            this.auditLog.shift()
        }
    }

    getAuditLog(limit = 100): SandboxAuditEntry[] {
        return this.auditLog.slice(-limit)
    }

    clearAuditLog(): void {
        this.auditLog = []
    }

    // ─── 策略管理 ────────────────────────────────────────

    getPolicy(): SandboxPolicy {
        return {...this.policy}
    }

    updatePolicy(updates: Partial<SandboxPolicy>): void {
        this.policy = {...this.policy, ...updates}
    }

    addAllowedPath(p: string): void {
        const normalized = path.normalize(p)
        if (!this.policy.allowedPaths.includes(normalized)) {
            this.policy.allowedPaths.push(normalized)
        }
    }

    removeAllowedPath(p: string): void {
        const normalized = path.normalize(p)
        this.policy.allowedPaths = this.policy.allowedPaths.filter(
            ap => ap !== normalized,
        )
    }

    // ─── 内部检查方法 ────────────────────────────────────

    private checkFileAccess(
        filePath: string,
        mode: 'read' | 'write' | 'delete',
    ): SandboxCheckResult {
        const normalized = path.normalize(filePath)

        // 检查黑名单
        for (const denied of this.policy.deniedPaths) {
            if (isWithin(normalized, denied)) {
                return {
                    allowed: false,
                    reason: `路径在黑名单中: ${denied}`,
                    riskLevel: 'high',
                }
            }
        }

        // 检查白名单
        if (this.policy.allowedPaths.length > 0) {
            const isAllowed = this.policy.allowedPaths.some(ap => isWithin(normalized, ap))
            if (!isAllowed) {
                return {
                    allowed: false,
                    reason: `路径不在白名单中: ${normalized}`,
                    riskLevel: 'medium',
                }
            }
        }

        // 删除操作需要确认
        if (mode === 'delete') {
            return {
                allowed: true,
                needsConfirmation: true,
                confirmationMessage: `确认删除文件: ${normalized}?`,
                riskLevel: 'high',
            }
        }

        // 写入操作标记中风险
        if (mode === 'write') {
            return {
                allowed: true,
                riskLevel: 'medium',
            }
        }

        return {
            allowed: true,
            riskLevel: 'low',
        }
    }

    private checkCommand(
        command: string,
        _args: string[],
    ): SandboxCheckResult {
        const fullCommand = command.toLowerCase().trim()

        // 1. 高危命令硬拦截（使用 permissionEngine 的共享检测）
        // 职责分离：PermissionEngine 定义"什么是高危"，LocalSandbox 执行二次检查
        if (permissionEngine.isHighRisk(command)) {
            return {
                allowed: false,
                reason: `极度危险的操作：系统已硬性拦截此命令以防止不可逆的破坏。`,
                riskLevel: 'critical',
            }
        }

        // 2. 检查动态配置黑名单（LocalSandbox 特有配置）
        for (const denied of this.policy.deniedCommands) {
            if (fullCommand.includes(denied.toLowerCase())) {
                return {
                    allowed: false,
                    reason: `命令被安全策略禁止: ${denied}`,
                    riskLevel: 'high',
                }
            }
        }

        // 3. 高危命令需要确认（LocalSandbox 特有的确认规则）
        const highRiskPatterns = [
            /rm\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)/,
            /del\s+(\/[sqf]*[sqf]*[sqf]*)/i,
            /rd\s+(\/s)/i,
            /rmdir\s+(\/s)/i,
            /chmod\s+(-R|000|777)/,
            /chown\s+(-R)/,
            /git\s+(push\s+--force|reset\s+--hard|clean\s+-fd)/,
            /npm\s+publish/,
            /docker\s+(rm|system\s+prune|rmi|kill|stop)/,
            /pip\s+uninstall/,
            /apt-get\s+(remove|purge)/,
            /yum\s+(remove|erase)/,
        ]

        for (const pattern of highRiskPatterns) {
            if (pattern.test(fullCommand)) {
                return {
                    allowed: true,
                    needsConfirmation: true,
                    confirmationMessage: `确认执行高危命令: ${command}?`,
                    riskLevel: 'high',
                }
            }
        }

        return {
            allowed: true,
            riskLevel: 'low',
        }
    }

    private checkNetwork(url: string): SandboxCheckResult {
        // 检查网络目标黑名单
        if (this.policy.deniedNetworkTargets) {
            for (const denied of this.policy.deniedNetworkTargets) {
                if (url.includes(denied)) {
                    return {
                        allowed: false,
                        reason: `网络目标被禁止: ${denied}`,
                        riskLevel: 'medium',
                    }
                }
            }
        }

        return {
            allowed: true,
            riskLevel: 'low',
        }
    }
}

// ─── 工具函数 ──────────────────────────────────────────

/** 检查 childPath 是否在 parentPath 目录下 */
function isWithin(childPath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, childPath)
    return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** 全局单例 */
export const localSandbox = new LocalSandbox()
