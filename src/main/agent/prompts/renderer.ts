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

  // ★ 安全决策：权限模式不下发模型（本地 permissionEngine 兜底），
  //   因此 {{permissionMode}} 不再被替换，模板里的该占位符保持原样。

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
  permissionMode: 'auto' | 'safe',
  workingDir: string,
): string {
  return renderSystemPrompt(template, {
    permissionMode,
    workingDir,
    agentType,
  })
}
