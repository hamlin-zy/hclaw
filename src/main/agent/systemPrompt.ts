/**
 * 系统提示词构建器
 *
 * 组装完整的系统提示词，包含：
 * - 角色定义（支持自定义）
 * - 统一任务路由（精简）
 * - 核心规则 + 记忆指南（去重）
 * - 环境信息
 */

import type {AgentTemplate, HClawAgentType} from '@shared/types'
import type {ToolDefinitionForLLM} from './tools/types'
import {getShellInfo, getTerminalDisplayName} from './tools/builtin/bashTool'
import {isMcpToolName} from '@shared/utils/mcpShortId'
import {promptResolver, type PromptResolver} from './prompts/resolver'
import {getAgentTemplate} from './prompts/agentTemplates'
import {getHclawDir} from '../config'


export interface SystemPromptContext {
    workingDir: string
    tools: ToolDefinitionForLLM[]
    /**
     * 权限模式。★ 缓存稳定化（决策）：不再拼入 system 文本——权限策略完全由
     * 本地 permissionEngine 兜底，模型无感知。字段保留仅为兼容调用方签名，
     * 任何分支都不得把它写进提示词。
     */
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
- **工作目录**: ${ctx.workingDir}`)

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

  if (ctx.customInstructions) {
    sections.push(`## 自定义指令

${ctx.customInstructions}`)
  }

  return sections.join('\n\n')
}

function buildRoutingSection(_ctx: SystemPromptContext, r: PromptResolver): string {
    // routing 段落无条件常驻（能力索引已迁出，段落字节恒定利于 prompt cache）
    return r.resolve('system.routing')
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
