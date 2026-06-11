/**
 * Skills 模块入口
 *
 * 支持 DeerFlow 风格的扩展目录结构：
 * - references/: 参考文档（按需加载）
 * - scripts/: 可执行脚本
 * - templates/: 输出模板
 * - agents/: Agent 定义
 * - assets/: 静态资源
 */

// 重新导出共享类型
export type {
  SkillExtensions,
  SkillReference,
  SkillScript,
  SkillTemplate,
  SkillExample,
} from '@shared/skillTypes'

export type {
  SkillDefinition,
  SkillFrontmatter,
  SkillRegistry,
  SkillExecutionMode,
  SkillExtensionType,
  ReferenceFile,
  ScriptFile,
  TemplateFile,
  AgentDefFile,
  SkillPhase,
  SkillStatus,
  ReferenceRef,
  ScriptCall,
  SkillLogEntry,
  ScriptResult,
  SkillStreamEvent,
} from './types'

export { skillRegistry } from './registry'
export { loadSkillsFromDirectory, loadSkillsFromPlugins, loadSkillsFromPluginDirectory } from './loader'
export { serializeSkill, serializeSkills } from './loader'
export { applySkillOverrides, writeSkillOverride, writeSkillOverrides, readSkillOverridesSync } from './loader'
export { skillMatcher, SkillMatcher } from './matcher'
export type { SkillMatch } from './matcher'
export { skillEventBus } from './eventBus'
export type { SkillEvent, SkillEventType, SkillEventCallback } from './eventBus'

// 扫描器与解析器
export { parseSkillMarkdown } from './parser'
export {
  scanSkillExtensions,
  getSupportedScriptExtensions,
  isSupportedScript
} from './extensions'

// 参考解析与脚本执行
export {
  extractReferences,
  extractScriptCalls,
  parseScriptArgs,
  resolveReferencePath,
  resolveScriptPath,
  loadReferenceContent,
  getReferenceInfo,
  formatReferenceList,
  validateReferences,
  referenceExists,
  listReferences,
} from './referenceResolver'



// 条件激活器
export { skillActivator } from './activator'
