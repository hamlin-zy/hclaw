/**
 * HClaw 类型系统 — 统一入口（barrel 文件）
 *
 * 按领域拆分到子文件，此文件仅做整合重导出。
 * 所有现有 `import { X } from '@shared/types'` 无需修改。
 */

// ─── Layer 1 — zero internal deps ──────────────────────
export * from './types/message'
export * from './types/permissions'
export * from './types/settings'

// ─── Layer 1 — depends only on skillTypes (external) ───
export * from './types/infra'

// ─── Layer 2 — depends on message, permissions, infra ──
export * from './types/model'

// ─── Layer 3 — depends on message, model ───────────────
export * from './types/events'

// ─── Skill extension types ─────────────────────────────
export type {
  SkillExtensions,
  SkillReference,
  SkillScript,
  SkillTemplate,
  SkillExample,
  SkillScanResult,
  ScanOptions,
  SkillWithMeta,
  SkillFrontmatter,
} from './skillTypes'

// ─── Agent & Hooks (pre-existing modules) ──────────────
export * from './agent'
export * from './hooks'
