/**
 * 系统提示词构建器
 *
 * 组装完整的系统提示词，包含：
 * - 角色定义（支持自定义）
 * - 统一任务路由（精简）
 * - 核心规则 + 记忆指南（去重）
 * - 环境信息
 * - 统一能力索引（Skill / Agent / Command 统一展示）
 */

import type {AgentTemplate, HClawAgentType} from '@shared/types'
import type {ToolDefinitionForLLM} from './tools/types'
import {getShellInfo, getTerminalDisplayName} from './tools/builtin/bashTool'
import {isMcpToolName} from '@shared/utils/mcpShortId'
import {promptResolver, type PromptResolver} from './prompts/resolver'
import {getAgentTemplate} from './prompts/agentTemplates'
import {agentRegistry} from './agentRegistry'
import {skillRegistry} from './skills'
import {getHclawDir} from '../config'
import {CommandDispatcher} from '../plugin/commands'


export interface SystemPromptContext {
    workingDir: string
    tools: ToolDefinitionForLLM[]
    permissionMode: string
    customInstructions?: string
    userHints?: string[]
    agentType?: HClawAgentType
    agentTemplates?: AgentTemplate[]
    /** 当前任务描述，用于预取相关记忆 */
    taskDescription?: string
}

export async function buildSystemPrompt(
    ctx: SystemPromptContext,
    resolver?: PromptResolver
): Promise<string> {
  const sections: string[] = []
  const shellInfo = getShellInfo()
  const terminalName = getTerminalDisplayName()
    const r = resolver || promptResolver

  if (ctx.agentType && ctx.agentType !== 'General') {
    sections.push(getAgentTemplate(ctx.agentType))
  } else {
      sections.push(r.resolve('system.intro'))
  }

    // ★ 角色定义后紧跟当前环境
  sections.push(`## 当前环境

- **平台**: HClaw (本地 Agent)
- **终端**: ${terminalName} (${shellInfo.shell})
- **操作系统**: ${displayOS(shellInfo.os)}
- **Node.js**: ${process.version}
- **工作目录**: ${ctx.workingDir}
- **权限模式**: ${ctx.permissionMode}`)

    // 系统目录结构（配置目录/数据目录说明）
    const dirsSection = r.resolve('system.directories')
        .replace(/\{\{hclawDir\}\}/g, getHclawDir())
    if (dirsSection.trim()) {
        sections.push(dirsSection)
    }

    const routing = buildRoutingSection(ctx, r)
  if (routing) sections.push(routing)

    sections.push(r.resolve('system.rules'))
    sections.push(r.resolve('system.workflow'))
    sections.push(r.resolve('system.output'))

    sections.push(buildImageHandlingSection(ctx, r))
    sections.push(buildMediaSection(r))
    sections.push(buildMemorySection(r))

  if (ctx.userHints?.length) {
    sections.push(`### 用户提示
${ctx.userHints.map(h => `- ${h}`).join('\n')}`)
  }

    // 统一能力索引（取代独立的 skill 列表 + agent 列表 + MCP 准则）
  const capabilitySection = buildCapabilityIndex(ctx)
  if (capabilitySection) sections.push(capabilitySection)

  if (ctx.customInstructions) {
    sections.push(`## 自定义指令

${ctx.customInstructions}`)
  }

  return sections.join('\n\n')
}

function buildRoutingSection(_ctx: SystemPromptContext, r: PromptResolver): string {
    const hasCapabilities =
        skillRegistry.getEnabled().length > 0 ||
        agentRegistry.getEnabled().length > 0

    if (!hasCapabilities) return ''

    return r.resolve('system.routing')
}

function buildCapabilityIndex(_ctx: SystemPromptContext): string {
  const seen = new Set<string>()
  const entries: Array<{
    name: string
    type: '技能' | '代理' | '命令'
    description: string
    trigger: string
    sortOrder: number
  }> = []

  // Skills
  for (const skill of skillRegistry.getEnabled()) {
    if (!skill.enabled) continue
    const desc = skill.userDescription || skill.description || ''
    const trigger = skill.whenToUse || ''
    if (!desc.trim() && !trigger.trim()) continue
    const key = `skill:${skill.name}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      name: skill.name,
      type: '技能' as const,
      description: desc,
      trigger,
      sortOrder: 0,
    })
  }

  // Agent Templates（跳过命令注册的 cmd: 条目，由下面 Commands 节处理）
  for (const agent of agentRegistry.getEnabled()) {
    if (!agent.enabled) continue
    if (agent.id.startsWith('cmd:')) continue  // 跳过命令伪 Agent
    const desc = agent.userDescription || agent.description || ''
    const trigger = agent.whenToUse || ''
    if (!desc.trim() && !trigger.trim()) continue
    const key = `agent:${agent.name}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      name: agent.name,
      type: '代理' as const,
      description: desc,
      trigger,
      sortOrder: 1,
    })
  }

  // Commands
  try {
    const dispatcher = CommandDispatcher.getInstance()
    const {pluginGroups, userCommands} = dispatcher.getAllCommands()
    for (const cmd of userCommands) {
      const desc = cmd.description || ''
      if (!desc.trim()) continue
      const cmdName = cmd.name || cmd.id
      if (!cmdName) continue
      const key = `cmd:${cmd.id}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        name: cmdName,
        type: '命令' as const,
        description: desc,
        trigger: '',
        sortOrder: 2,
      })
    }
    for (const [, commands] of pluginGroups) {
      for (const cmd of commands) {
        const desc = cmd.description || ''
        if (!desc.trim()) continue
        const cmdName = cmd.name || cmd.id.split(':').pop() || cmd.id
        const key = `pcmd:${cmd.id}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({
          name: cmdName,
          type: '命令' as const,
          description: desc,
          trigger: '',
          sortOrder: 2,
        })
      }
    }
  } catch { /* 命令系统尚未就绪，跳过 */ }

  if (entries.length === 0) return ''

  // 按类型分组后按名称排序
  entries.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.name.localeCompare(b.name)
  })

  // 渲染表格
  const rows = entries.map(e => {
    const desc = e.description.replace(/\n/g, ' ')
    return `| ${e.name} | ${e.type} | ${desc} | ${e.trigger} |`
  })

  return `## 可用能力

以下列出当前所有可用的技能、代理和命令。
- 匹配**名称**和**触发条件**列，优先委派给匹配的能力
- 触发条件为空时，参考**描述**列

| 名称 | 类型 | 描述 | 触发条件 |
|------|------|------|----------|
${rows.join('\n')}

`
}

function buildImageHandlingSection(ctx: SystemPromptContext, r: PromptResolver): string {
  const hasMcpOcr = ctx.tools?.some(t =>
    isMcpToolName(t.name) &&
    (t.name.includes('ocr') || t.name.includes('image') || t.name.includes('vision') || t.name.includes('screenshot'))
  ) || false

    return r.resolve('system.image').replace('{{mcpOcrStatus}}',
        hasMcpOcr ? '优先调用对应 MCP 工具提取内容' : '当前无可用 MCP 图片工具')
}

function buildMediaSection(r: PromptResolver): string {
    return r.resolve('system.media')
}

function buildMemorySection(r: PromptResolver): string {
    return r.resolve('system.memory')
}

function displayOS(os: string): string {
  if (os === 'windows') return 'Windows'
  if (os === 'macos') return 'macOS'
  return 'Linux'
}
