/**
 * Hook 事件定义表 - 配置化注册
 *
 * 包含所有支持的 Hook 事件及其元数据
 */

import type { HookEventDefinition, HookEvent, HookType } from './types'

export const HOOK_EVENT_DEFINITIONS: HookEventDefinition[] = [
  // ─── Session ─────────────────────────────────────
  {
    event: 'SessionStart',
    name: '会话开始',
    description: '会话启动或恢复时触发',
    category: 'session',
    supportedTypes: ['command', 'prompt', 'http', 'agent'],
    supportsMatcher: false,
    contextParams: ['sessionId'],
  },
  {
    event: 'SessionEnd',
    name: '会话结束',
    description: '会话终止时触发',
    category: 'session',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['sessionId'],
  },
  {
    event: 'UserPromptSubmit',
    name: '用户提交',
    description: '用户输入提交后、Claude 处理前触发',
    category: 'session',
    supportedTypes: ['command', 'prompt', 'agent'],
    supportsMatcher: false,
    contextParams: ['prompt'],
  },
  {
    event: 'UserPromptExpansion',
    name: '命令展开',
    description: '用户命令展开为 prompt 前触发，可阻塞展开',
    category: 'session',
    supportedTypes: ['command', 'prompt'],
    supportsMatcher: true,
    contextParams: ['prompt'],
  },
  {
    event: 'InstructionsLoaded',
    name: '指令加载',
    description: 'CLAUDE.md 或规则文件加载时触发',
    category: 'session',
    supportedTypes: ['command', 'http'],
    supportsMatcher: true,
    contextParams: ['filePath'],
  },
  {
    event: 'ConfigChange',
    name: '配置变更',
    description: '配置文件变更时触发',
    category: 'session',
    supportedTypes: ['command', 'http'],
    supportsMatcher: true,
    contextParams: ['configKey', 'configValue'],
  },
  {
    event: 'CwdChanged',
    name: '工作目录变更',
    description: 'cd 命令变更目录时触发',
    category: 'session',
    supportedTypes: ['command'],
    supportsMatcher: false,
    contextParams: ['cwd'],
  },

  // ─── Context Retrieval ──────────────────────────
  {
    event: 'ContextRetrieval',
    name: '上下文检索',
    description: 'LLM 调用前执行，用于查询外部知识库并返回结果注入到消息中（需配置 captureOutput: true）',
    category: 'session',
    supportedTypes: ['command'],
    supportsMatcher: false,
    contextParams: ['prompt'],
  },

  // ─── Think ─────────────────────────────────────
  {
    event: 'ThinkStart',
    name: 'LLM 开始思考',
    description: 'LLM 调用开始时触发',
    category: 'session',
    supportedTypes: ['command', 'function', 'http'],
    supportsMatcher: false,
    contextParams: ['sessionId'],
  },
  {
    event: 'ThinkEnd',
    name: 'LLM 思考结束',
    description: 'LLM 响应完成时触发（含工具调用和文本）',
    category: 'session',
    supportedTypes: ['command', 'function', 'http'],
    supportsMatcher: false,
    contextParams: ['sessionId'],
  },

  // ─── Tool ─────────────────────────────────────
  {
    event: 'PreToolUse',
    name: '工具执行前',
    description: '工具调用前触发，可拦截或修改参数',
    category: 'tool',
    supportedTypes: ['command', 'prompt', 'agent'],
    supportsMatcher: true,
    contextParams: ['toolName', 'args'],
  },
  {
    event: 'PostToolUse',
    name: '工具执行后',
    description: '工具成功执行后触发',
    category: 'tool',
    supportedTypes: ['command', 'http', 'prompt'],
    supportsMatcher: true,
    contextParams: ['toolName', 'result'],
  },
  {
    event: 'PostToolUseFailure',
    name: '工具执行失败',
    description: '工具执行异常后触发',
    category: 'tool',
    supportedTypes: ['command', 'http'],
    supportsMatcher: true,
    contextParams: ['toolName', 'error'],
  },
  {
    event: 'PermissionRequest',
    name: '权限请求',
    description: '权限对话框显示时触发',
    category: 'permission',
    supportedTypes: ['command', 'prompt'],
    supportsMatcher: true,
    contextParams: ['toolName'],
  },
  {
    event: 'PermissionDenied',
    name: '权限拒绝',
    description: '工具被自动模式拒绝时触发，可返回 retry: true 重试',
    category: 'permission',
    supportedTypes: ['command', 'prompt'],
    supportsMatcher: true,
    contextParams: ['toolName'],
  },

  // ─── Agent ─────────────────────────────────────
  {
    event: 'SubagentStart',
    name: '子 Agent 启动',
    description: '子 Agent 开始执行时触发',
    category: 'agent',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['taskId', 'taskName'],
  },
  {
    event: 'SubagentStop',
    name: '子 Agent 停止',
    description: '子 Agent 完成时触发',
    category: 'agent',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['taskId', 'result'],
  },
  {
    event: 'TeammateIdle',
    name: '队友空闲',
    description: 'Agent team 队友空闲时触发 [未实现]',
    category: 'agent',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['teammateId'],
  },
  {
    event: 'TaskCreated',
    name: '任务创建',
    description: 'TaskCreate 创建任务时触发',
    category: 'task',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['taskId', 'taskName'],
  },
  {
    event: 'TaskCompleted',
    name: '任务完成',
    description: '任务标记完成时触发',
    category: 'task',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['taskId', 'taskName'],
  },

  // ─── MCP ─────────────────────────────────────
  {
    event: 'Elicitation',
    name: 'MCP 请求输入',
    description: 'MCP 服务请求用户输入时触发 [未实现]',
    category: 'mcp',
    supportedTypes: ['command', 'prompt'],
    supportsMatcher: false,
    contextParams: ['elicitationRequest'],
  },
  {
    event: 'ElicitationResult',
    name: 'MCP 输入结果',
    description: '用户响应 MCP 请求后触发 [未实现]',
    category: 'mcp',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['elicitationResult'],
  },

  // ─── File ─────────────────────────────────────
  {
    event: 'FileChanged',
    name: '文件变更',
    description: '监控的文件发生变化时触发',
    category: 'file',
    supportedTypes: ['command', 'http'],
    supportsMatcher: true,
    contextParams: ['filePath'],
  },

  // ─── Worktree ─────────────────────────────────────
  {
    event: 'WorktreeCreate',
    name: '创建 Worktree',
    description: '创建 git worktree 时触发 [未实现]',
    category: 'session',
    supportedTypes: ['command'],
    supportsMatcher: false,
    contextParams: ['worktreeName', 'worktreePath'],
  },
  {
    event: 'WorktreeRemove',
    name: '移除 Worktree',
    description: '移除 git worktree 时触发 [未实现]',
    category: 'session',
    supportedTypes: ['command'],
    supportsMatcher: false,
    contextParams: ['worktreeName', 'worktreePath'],
  },

  // ─── Response ─────────────────────────────────────
  {
    event: 'Stop',
    name: '响应结束',
    description: 'Claude 响应完成时触发',
    category: 'response',
    supportedTypes: ['command', 'http', 'agent'],
    supportsMatcher: false,
    contextParams: ['sessionId'],
  },
  {
    event: 'StopFailure',
    name: '响应失败',
    description: 'API 错误导致响应终止时触发',
    category: 'response',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: ['error'],
  },

  // ─── Compact ─────────────────────────────────────
  {
    event: 'PreCompact',
    name: '压缩前',
    description: '上下文压缩前触发',
    category: 'session',
    supportedTypes: ['command', 'prompt'],
    supportsMatcher: false,
    contextParams: [],
  },
  {
    event: 'PostCompact',
    name: '压缩后',
    description: '上下文压缩后触发',
    category: 'session',
    supportedTypes: ['command', 'http'],
    supportsMatcher: false,
    contextParams: [],
  },

  // ─── Notification ─────────────────────────────────────
  {
    event: 'Notification',
    name: '通知',
    description: '发送通知时触发 [未实现]',
    category: 'session',
    supportedTypes: ['command', 'http'],
    supportsMatcher: true,
    contextParams: ['message'],
  },
]

/**
 * 获取事件定义
 */
export function getHookEventDefinition(event: HookEvent): HookEventDefinition | undefined {
  return HOOK_EVENT_DEFINITIONS.find((d) => d.event === event)
}

/**
 * 按分类获取事件
 */
export function getHookEventsByCategory(category: HookEventDefinition['category']): HookEventDefinition[] {
  return HOOK_EVENT_DEFINITIONS.filter((d) => d.category === category)
}

/**
 * 获取所有事件
 */
export function getAllHookEvents(): HookEventDefinition[] {
  return HOOK_EVENT_DEFINITIONS
}

/**
 * 验证 Hook 类型是否支持事件
 */
export function isHookTypeSupported(event: HookEvent, type: HookType): boolean {
  const def = getHookEventDefinition(event)
  return def?.supportedTypes.includes(type) ?? false
}
