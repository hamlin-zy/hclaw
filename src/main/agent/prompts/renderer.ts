/**
 * 提示词渲染模块
 * 实现动态提示词生成（模板占位符替换）
 */

import type {RenderPromptParams} from '@shared/agent'

/**
 * 替换占位符
 */
export function renderSystemPrompt(
  template: string,
  params: RenderPromptParams
): string {
  if (!template) {
    return ''
  }

  let result = template

  // 替换 {{availableTools}}
  result = result.replace(/\{\{availableTools\}\}/gi, () => {
    if (params.availableTools.length === 0) {
      return '（无可用工具限制）'
    }
    return `可用工具：\n${params.availableTools.map(t => `- ${t}`).join('\n')}`
  })

  // 替换 {{permissionMode}}
  result = result.replace(/\{\{permissionMode\}\}/gi, () => {
    const modeMap: Record<string, string> = {
      'auto': '自动模式',
      'safe': '安全模式'
    }
    return modeMap[params.permissionMode] || params.permissionMode
  })

  // 替换 {{workingDir}}
  result = result.replace(/\{\{workingDir\}\}/gi, params.workingDir)

  // 替换 {{agentType}}
  result = result.replace(/\{\{agentType\}\}/gi, params.agentType || 'unknown')

  return result
}

/**
 * 从 Agent 定义渲染系统提示词
 */
export function renderAgentSystemPrompt(
  template: string,
  agentType: string,
  availableTools: string[],
  permissionMode: 'auto' | 'safe',
  workingDir: string,
): string {
  return renderSystemPrompt(template, {
    availableTools,
    permissionMode,
    workingDir,
    agentType,
  })
}
