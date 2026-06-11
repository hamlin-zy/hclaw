/**
 * 工具系统入口 — 注册所有内置工具并导出
 */

export { type Tool, type ToolContext, type ToolResult, type Artifact, type ToolDefinitionForLLM, toolToDefinition } from './types'
export { ToolRegistry, toolRegistry } from './registry'
export { PermissionEngine, permissionEngine } from './permission'
export { executeTool, type ExecuteToolCall, type ExecuteToolResult } from './executor'

import {toolRegistry} from './registry'

// 内置工具
import {analyzeImageTool} from './builtin/analyzeImageTool'
import {speechToTextTool} from './builtin/speechToTextTool'
import {bashTool} from './builtin/bashTool'
import {fileReadTool} from './builtin/fileReadTool'
import {fileWriteTool} from './builtin/fileWriteTool'
import {fileEditTool} from './builtin/fileEditTool'
import {globTool} from './builtin/globTool'
import {grepTool} from './builtin/grepTool'
import {webFetchTool} from './builtin/webFetchTool'
import {askUserTool} from './builtin/askUserTool'
import {agentTool} from './builtin/agentTool'
import {skillTool} from './builtin/skillTool'

import {taskCreateTool} from './builtin/taskCreateTool'
import {taskUpdateTool} from './builtin/taskUpdateTool'
import {taskListTool} from './builtin/taskListTool'

// 新增内置工具
import {channelListTool} from './builtin/channelListTool'
import {channelSendTool} from './builtin/channelSendTool'
import {schedulerManageTool} from './builtin/schedulerManageTool'
import {systemManageTool} from './builtin/systemManageTool'

import {loadSkillsFromDirectory} from '../skills'
import {skillRegistry} from '../skills/registry'

export { setAgentToolConfig } from './builtin/agentTool'

export {formatSkillListForPrompt} from './builtin/skillTool'

/** 注册所有内置工具到全局 registry */
export function registerBuiltinTools(): void {
  toolRegistry.registerAll([
      analyzeImageTool,
      speechToTextTool,
    bashTool,
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    globTool,
    grepTool,
    webFetchTool,
    askUserTool,
    agentTool,
      skillTool,

      taskCreateTool,
      taskUpdateTool,
      taskListTool,

      channelListTool,
      channelSendTool,
      schedulerManageTool,
      systemManageTool,
  ])
}

/** 初始化技能系统
 *
 * 注意：此函数仅加载本地技能（public/custom），不加载插件技能。
 * 插件技能由 PowerManager.initialize() 统一加载，避免重复加载导致 CPU 飙升。
 */
export async function initSkills(): Promise<number> {
    const loadedBuiltin = await loadSkillsFromDirectory()
    // 插件技能已由 PowerManager.initialize() 加载，此处不再重复加载
    const allSkills = skillRegistry.getAll()
    if (allSkills.length > 0) {
        const _skillList = allSkills.map(s => {
            const icon = s.enabled ? '✅' : '⏸️'
            const sourceTag = s.source === 'builtin' ? '[public]' : s.source === 'plugin' ? '[plugin]' : '[custom]'
            return `  ${icon} ${sourceTag} ${s.name} (${s.id}) v${s.version || '1.0.0'}`
        }).join('\n')
    }
    return loadedBuiltin
}
