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
import {loadImageTool} from './builtin/loadImageTool'
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
import {describeSkillsTool} from './builtin/describeSkillsTool'
import {listAgentsTool} from './builtin/listAgentsTool'
import {callMcpTool} from './builtin/callMcpTool'

import {taskCreateTool} from './builtin/taskCreateTool'
import {taskUpdateTool} from './builtin/taskUpdateTool'
import {taskListTool} from './builtin/taskListTool'

// 新增内置工具
import {channelListTool} from './builtin/channelListTool'
import {channelSendTool} from './builtin/channelSendTool'
import {schedulerManageTool} from './builtin/schedulerManageTool'
import {systemManageTool} from './builtin/systemManageTool'
import {sessionHandoffTool} from './builtin/sessionHandoffTool'
import {memoTool} from './builtin/memoTool'
import {hclawDbQueryTool} from './builtin/hclawDbQueryTool'

export { setAgentToolConfig } from './builtin/agentTool'

/** 注册所有内置工具到全局 registry */
export function registerBuiltinTools(): void {
  toolRegistry.registerAll([
      analyzeImageTool,
      loadImageTool,
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
      describeSkillsTool,
      listAgentsTool,
      callMcpTool,

      taskCreateTool,
      taskUpdateTool,
      taskListTool,

      channelListTool,
      channelSendTool,
      schedulerManageTool,
      systemManageTool,
      sessionHandoffTool,
      memoTool,
      hclawDbQueryTool,
  ])
}
