/**
 * 模板变量渲染引擎
 *
 * 渲染 Agent 系统提示词中的模板变量：
 * - {working_dir} — 当前工作目录
 * - {permission_mode} — ⚠️ 已弃用（安全决策：权限模式不下发模型，见下）
 * - {agent_type} — Agent 类型名称
 * 支持 Agent 生态中的标准模板变量占位符（兼容 Claude Code 格式）。
 */

export interface RenderPromptParams {
  /**
   * 当前权限模式。★ 已弃用——安全决策：权限模式完全由本地 permissionEngine 兜底，
   * 不告知模型；字段仅保留以兼容调用方签名，任何分支都不得用它替换进提示词。
   */
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
    const {workingDir, agentType} = params

  let result = template
    .replace(/\{working_dir\}/g, workingDir)
    // ★ 安全决策：权限模式不下发模型（本地 permissionEngine 兜底），
    //   因此 {permission_mode} 不再被替换，模板里的该占位符保持原样。

  if (agentType) {
    result = result.replace(/\{agent_type\}/g, agentType)
  }

  return result
}
