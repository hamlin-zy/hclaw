/**
 * 技能扩展系统类型定义
 */

import type { Skill } from './types'

// 重新导出 Skill 类型，方便其他模块统一从 skillTypes 导入
export type { Skill } from './types'

// ─── 扩展资源类型 ─────────────────────────────────────

/** 扩展资源定义 */
export interface SkillExtensions {
  /** 参考文档列表 */
  references: SkillReference[]
  /** 脚本列表 */
  scripts: SkillScript[]
  /** 模板列表 */
  templates?: SkillTemplate[]
  /** 示例列表 */
  examples?: SkillExample[]
}

export interface SkillReference {
  name: string
  filePath: string
  category?: string
}

export interface SkillScript {
  name: string
  filePath: string
  language: 'bash' | 'python' | 'javascript' | 'typescript' | 'other'
}

export interface SkillTemplate {
  name: string
  filePath: string
  description?: string
}

export interface SkillExample {
  name: string
  filePath: string
  description?: string
}

// ─── 扫描结果类型 ─────────────────────────────────────

export interface SkillScanResult {
  skills: Skill[]
  conditionalSkills: Skill[]
  errors: Array<{ path: string; error: string }>
}

// ─── 扫描选项 ─────────────────────────────────────────

export interface ScanOptions {
  paths: string[]
  includeProject?: boolean
  cwd?: string
}

// ─── 带元数据的技能 ───────────────────────────────────

export interface SkillWithMeta extends Skill {
  skillDir: string
  filePath: string
  extensions?: SkillExtensions
}

// ─── Frontmatter 类型 ───────────────────────────────────

export interface SkillFrontmatter {
  name: string
  description: string
  user_description?: string
  when_to_use?: string
  /** 触发条件列表（when_to_use 的别名，支持字符串或字符串数组） */
  triggers?: string | string[]
  version: string
  enabled?: boolean
  context?: 'inline' | 'fork'
  model?: string
  allowed_tools?: string[]
  paths?: string[]
  license?: string
  category?: string
  metadata?: Record<string, unknown>
}
