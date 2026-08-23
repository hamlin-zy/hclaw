/**
 * 模板变量渲染引擎
 *
 * 渲染 Agent 系统提示词中的模板变量：
 * - {working_dir} — 当前工作目录
 * - {permission_mode} — 当前权限模式
 * - {agent_type} — Agent 类型名称
 * 支持 Agent 生态中的标准模板变量占位符（兼容 Claude Code 格式）。
 */

export interface RenderPromptParams {
  /** 当前权限模式 */
  permissionMode: string
  /** 工作目录 */
  workingDir: string
  /** Agent 类型 */
  agentType?: string
}

/**
 * 渲染系统提示词模板，替换所有模板变量占位符
 *
 * @param template 包含模板变量的提示词模板
 * @param params 渲染参数
 * @returns 渲染后的提示词
 */
export function renderSystemPrompt(
  template: string,
  params: RenderPromptParams,
): string {
    const {permissionMode, workingDir, agentType} = params

  let result = template
    .replace(/\{working_dir\}/g, workingDir)
    .replace(/\{permission_mode\}/g, permissionMode)

  if (agentType) {
    result = result.replace(/\{agent_type\}/g, agentType)
  }

  return result
}
