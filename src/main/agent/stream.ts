/**
 * 流式事件类型定义
 *
 * Worker Thread → 主进程 → 渲染进程 的统一事件格式。
 */

import type {ToolResult} from './tools/types'
import type {IntentAnalysisResult, ToolCallInfo} from '@shared/types'

export type {ToolCallInfo} from '@shared/types'

export type AgentStreamEvent =
  | { type: 'begin' }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; toolCall: ToolCallInfo }
  | { type: 'tools_start'; toolCount: number }
  | { type: 'tool_start'; toolCall: ToolCallInfo }
  | { type: 'tool_progress'; toolCallId: string; progress: string }
  | { type: 'tool_result'; toolCallId: string; toolName: string; skillName?: string; result: ToolResult }
  | { type: 'tool_denied'; toolCallId: string; reason: string }
  | { type: 'permission_confirm'; question: string; requestId?: string }
  | { type: 'done'; reason: 'completed' | 'aborted' | 'error' }
  | { type: 'error'; error: string }
  | { type: 'ask_user'; question: string; options?: string[]; multiSelect?: boolean; requestId?: string }
  | { type: 'subagent_start'; taskId: string; description: string; toolCallId?: string }
  | {
    type: 'subagent_progress';
    taskId: string;
    subAgentEvent: string;
    progress?: string;
    subAgentStreamEvent?: AgentStreamEvent;
    toolCallId?: string
  }
  | { type: 'subagent_done'; taskId: string; success: boolean; output: string; error?: string; toolCallId?: string }
  | { type: 'intent_analyzed'; result: IntentAnalysisResult }
  | {
    type: 'agent_progress';
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens: number;
    toolUseCount: number;
    currentTool?: string;
    currentActivity?: string;
  }
  | {
    type: 'tool_detail';
    toolCallId: string;
    toolName: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    progress?: number;
    eta?: number;
  }
  | { type: 'mode_change'; mode: 'auto' }
  | { type: 'plan_generated'; plan: string }
  | { type: 'skill_matched'; skillId: string; skillName: string; score: number; reason: string }
  | { type: 'hook_result'; event: string; hookName: string; success: boolean; error?: string }
  | {
    type: 'llm_call_done';
    conversationTitle: string;
    provider: string;
    model: string;
    duration: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    inputContent: string;
    outputContent: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        input: Record<string, any>;
        output?: string;
        success?: boolean;
    }>;
    messages?: Array<{
        role: string;
        content: string;
        toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
        toolCallId?: string;
        toolResult?: string;
    }>;
    systemPrompt?: string;
  }
  | {
    type: 'context_compacted';
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    compactedMessages: number;
    preservedInfo: string[];
    message: string;
  }
  | { type: 'compact_status'; compactStatus: 'waiting' | 'compacting' | 'completed' }
    | {
    type: 'compact_persist';
    messages: import('./model/types').ChatMessage[];
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    compactedMessages: number;
    message: string;
}
    | {
    type: 'compact_persisted';
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    compactedMessages: number;
    message: string;
}
  | { type: 'permission-rules-updated' }
  | { type: 'tasks_update'; tasks: import('../../shared/types').Task[] }
    | {
    type: 'agent_start';
    agentType: string;
    agentId: string;
    model: string;
    provider?: string;
    tools: string[];
    isolation?: string
}
  // Command 相关事件
  | { type: 'command_start'; commandId: string; commandName: string; commandArgs?: string }
  // Skill 相关事件
  | { type: 'skill_start'; skillId: string; skillName: string; }
  | { type: 'skill_phase'; skillId: string; skillName: string; phase: string }
  | { type: 'skill_reference_loaded'; skillId: string; skillName: string; references: { loaded: string[]; pending?: string[] } }
  | { type: 'skill_script_start'; skillId: string; skillName: string; script: { name: string } }
  // 模型降级/配置警告
  | { type: 'warning'; message: string }
  | { type: 'skill_script_output'; skillId: string; skillName: string; output: string }
  | { type: 'skill_script_done'; skillId: string; skillName: string; script: { name: string; status: 'pending' | 'running' | 'done' | 'error'; output?: string } }
  | { type: 'skill_log'; skillId: string; skillName: string; level: 'info' | 'warn' | 'error' | 'output' | 'debug'; message: string }
  | { type: 'skill_end'; skillId: string; skillName: string; status: 'done' | 'error'; result?: { type: 'inline' | 'script_output' | 'reference'; content?: string }; error?: { phase: string; message: string } }
  | { type: 'plan_generated'; plan: string }
  // 系统配置更新事件
  | { type: 'settings-updated'; settings: Record<string, any> }
  // 定时任务变更事件（工具修改后通知前端刷新）
  | { type: 'schedules-changed' }
  // 应用重启事件
  | { type: 'app-restart' }
  /** 用户消息注入完成，需结束当前 assistant 消息并开启新消息 */
  | { type: 'user_message_injected' }
  /** Agent 结束后残留的注入消息，由主进程保存到会话并通知渲染层启动新 Agent */
  | { type: 'user_message_injected_after_exit'; messages: Array<{ content: string; id: string }> }

/** 终端环境信息（用于传递给前端渲染） */
export interface TerminalInfo {
  name: string     // 'powershell' | 'cmd' | 'bash' | 'sh'
  platform: string // 'windows' | 'macos' | 'linux'
}
