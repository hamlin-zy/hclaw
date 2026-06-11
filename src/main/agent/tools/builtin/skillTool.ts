/**
 * SkillTool — 技能调用工具
 *
 * LLM 通过此工具调用技能，技能指导内容会自动注入到系统提示词。
 */

import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {skillRegistry} from '../../skills'
import {skillActivator} from '../../skills/activator'
import {buildGuidance, buildPreview} from '../../skills/guidance'
import type {SkillDefinition} from '../../skills/types'
import type {Skill} from '@shared/types'

// ─── 类型转换 ─────────────────────────────────────────

const toSharedSkill = (def: SkillDefinition): Skill => ({
  id: def.id,
  name: def.name,
  description: def.description,
  userDescription: def.userDescription,
  enabled: def.enabled,
  version: def.version ?? '1.0.0',
  source: def.source,
  pluginName: def.pluginName,
  allowedTools: def.allowedTools,
  content: def.content,
  filePath: def.filePath,
  skillDir: def.skillDir,
  extensions: def.extensions,
  paths: def.paths,
  context: def.context,
  model: def.model,
  category: def.category,
  license: def.license,
})

export const SKILL_TOOL_NAME = 'skill'

const inputSchema = z.object({
  skill: z.string().describe('技能名称，如 "code-simplifier" 或 "scrapling-official"'),
})

type SkillToolInput = z.infer<typeof inputSchema>

export interface SkillToolOutput {
  success: boolean
  skillName: string
  skillDir?: string
  guidance?: string
  guidancePreview?: string
  extensions?: {
    scripts: Array<{name: string; path: string}>
    references: Array<{name: string; path: string}>
    templates?: string[]
    agents?: string[]
  }
  error?: string
}

// ─── 初始化 ─────────────────────────────────────────

export function initializeSkillSystem(operatedFiles?: string[]): void {
  const conditionalSkills = skillRegistry.getConditionalSkills().map(toSharedSkill)
  skillActivator.setConditionalSkills(conditionalSkills)
  if (operatedFiles?.length) skillActivator.activateForPaths(operatedFiles, '')
}

// ─── 辅助函数 ─────────────────────────────────────────

const MAX_DESC_CHARS = 200

/** 格式化技能列表（用于系统提示词） */
export function formatSkillListForPrompt(skills: SkillDefinition[]): string {
  const entries = skills
    .filter(s => s.enabled)
    .map(skill => {
      let desc = skill.userDescription || skill.description || ''
      if (skill.whenToUse) desc = desc ? `${desc} - ${skill.whenToUse}` : skill.whenToUse
      if (desc.length > MAX_DESC_CHARS) desc = desc.slice(0, MAX_DESC_CHARS - 1) + '…'

      let extInfo = ''
      if (skill.extensions) {
        if (skill.extensions.scripts?.length) extInfo += ' [脚本]'
        if (skill.extensions.references?.length) extInfo += ` [${skill.extensions.references.length}个引用]`
      }
      return `- ${skill.name}: ${desc}${extInfo}`
    })
  return entries.join('\n')
}

/** 查找技能（支持模糊匹配） */
function findSkill(nameOrId: string): SkillDefinition | undefined {
  const skills = skillRegistry.getAll()
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, '')

  return (
    skills.find(s => s.id === nameOrId) ||
    skills.find(s => s.name === nameOrId) ||
    skills.find(s => normalize(s.name) === normalize(nameOrId)) ||
    skills.find(s => normalize(s.id.split(':').pop() || s.id) === normalize(nameOrId)) ||
    skills.find(s => normalize(s.id) === normalize(nameOrId))
  )
}

// buildGuidance 和 buildPreview 已移至 skills/guidance.ts

// ─── 工具定义 ─────────────────────────────────────────

export const skillTool: Tool<SkillToolInput, SkillToolOutput> = {
  name: SKILL_TOOL_NAME,
  description: '调用技能来执行特定任务。当用户请求匹配技能时使用此工具。',
  inputSchema,

  async execute(args: SkillToolInput, _context: ToolContext): Promise<ToolResult<SkillToolOutput>> {
    const skill = findSkill(args.skill)
    if (!skill) return { success: false, output: { success: false, skillName: args.skill, error: `未找到技能: ${args.skill}` } }
    if (!skill.enabled) return { success: false, output: { success: false, skillName: skill.name, error: `技能已禁用: ${skill.name}` } }

    const guidance = buildGuidance(skill)
    const extensions = skill.extensions ? {
      scripts: skill.extensions.scripts.map(s => ({ name: s.name, path: `${skill.skillDir}/scripts/${s.name}` })),
      references: skill.extensions.references.map(r => ({ name: r.name, path: `${skill.skillDir}/references/${r.name}.md` })),
    } : undefined

    return {
      success: true,
      output: buildPreview(skill),
      // 结构化数据保留给 tool_result 事件使用（skillName 等）
      _skillMeta: { skillName: skill.name, skillDir: skill.skillDir, guidancePreview: buildPreview(skill), extensions },
      injectMessage: { role: 'system', content: guidance },
    } as any
  },
}

/** 设置当前 Agent 的技能工具配置（无参版本 - 从 Registry 读取） */
export function setSkillToolConfig(): void {
    // 预留：当前实现无需额外配置，保留函数签名以保持与 loop.ts 的接口一致
}

export default skillTool
