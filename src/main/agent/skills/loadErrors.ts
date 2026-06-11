/**
 * 技能加载错误收集器
 *
 * 在技能扫描过程中捕获并累积解析错误，
 * 通过 IPC 传递给前端展示给用户。
 *
 * 解决场景：用户手动创建的 SKILL.md 中 YAML frontmatter 格式错误，
 * 导致技能被静默跳过，用户无任何反馈。
 */

import {createLoadErrorCollector} from '../loadErrorCollector'

// ─── 类型 ─────────────────────────────────────────────

export interface SkillLoadError {
  /** 技能目录路径（如 ~/.hclaw/skills/custom/shopping-assistant） */
  skillDir: string
  /** SKILL.md 文件路径 */
  filePath: string
  /** 错误描述 */
  error: string
  /** 错误发生时间戳 */
  timestamp: number
}

// ─── 收集器 ─────────────────────────────────────────

const collector = createLoadErrorCollector<SkillLoadError>()

/** 添加一个技能加载错误 */
export const addLoadError = (skillDir: string, filePath: string, error: string): void =>
    collector.add({skillDir, filePath, error})

/** 获取并清空所有累积的错误 */
export const getAndClearLoadErrors = collector.getAndClear

/** 在 skillRegistry.clear() 时调用，清空旧的错误数据 */
export const resetLoadErrors = collector.reset
