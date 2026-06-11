/**
 * Permission system types.
 * 
 * Layer 1 — no internal sub-file dependencies.
 */

/**
 * 运行模式
 */
export type RunMode = 'safe' | 'auto'

/**
 * 权限规则（简化版，单一来源）
 */
export interface PermissionRule {
  /** 工具名称，支持glob，如 'bash:git*', 'file_*' */
  tool: string

  /** 动作 */
  action: 'allow' | 'deny' | 'ask'

  /** 创建时间 */
  createdAt?: number
}

/**
 * 扩展权限上下文（简化版，多值单一来源）
 */
export interface ToolPermissionContext {
  /** 当前运行模式 */
  mode: RunMode

  /** 进入plan模式前的模式，退出时恢复 */
  prePlanMode?: RunMode

  /** Auto模式下的备份，退出auto时恢复 */
  strippedDangerousRules?: PermissionRule[]

  /** 权限规则（单一来源，位于 ~/.hclaw/permission-rules.json */
  rules: PermissionRule[]

  /** 额外工作目录 */
  additionalWorkingDirectories?: string[]

  /** bypassPermissions模式是否可用（LingShu暂不支持，保留接口） */
  isBypassPermissionsModeAvailable?: boolean

  /** auto模式是否可用 */
  isAutoModeAvailable?: boolean
}

/**
 * 权限更新操作（简化版）
 */
export type PermissionUpdate =
  | { type: 'setMode'; mode: RunMode }
  | { type: 'addRule'; rule: PermissionRule }
  | { type: 'removeRule'; tool: string }
  | { type: 'setRules'; rules: PermissionRule[] }

/**
 * 危险权限信息
 */
export interface DangerousPermissionInfo {
  rule: PermissionRule
  reason: string  // 如"Bash(python:*) 权限过于宽泛"
}

/**
 * 探索等级（Explore Agent）
 */
export type ExploreThoroughness = 'quick' | 'medium' | 'very thorough'
