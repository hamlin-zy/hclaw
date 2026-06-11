/**
 * 多模型适配层核心类型定义
 *
 * 统一 Anthropic / OpenAI / Google / Ollama 四家的流式调用接口，
 * 上层 Agent Loop 只依赖 ModelAdapter，不感知具体 Provider。
 */

import type {ContentBlock} from '@shared/types'

// ─── 多模态内容类型 ─────────────────────────────────────

/**
 * 多模态内容块
 * 用于支持图片等非文本内容
 */
export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
    | { type: 'input_audio'; input_audio: { data: string; format: string } }

/**
 * 图片附件信息
 * 用于在消息中携带图片元数据
 */
export interface ImageAttachment {
    /** 图片唯一标识 */
    id: string
    /** 图片名称 */
    name: string
    /** 图片 MIME 类型 */
    type: string
    /** 数据来源类型 */
    source: 'local' | 'url'
    /** 本地路径（source=local 时使用） */
    localPath?: string
    /** 网络 URL（source=url 时使用） */
    url?: string
    /** Base64 编码数据（可选，用于缓存） */
    base64?: string
    /** 是否已加载（本地文件是否已读取为 base64） */
    loaded?: boolean
}

// ─── 消息类型 ─────────────────────────────────────────

export interface ChatMessage {
    id?: string
  role: 'system' | 'user' | 'assistant' | 'tool' | 'context'
    /** 消息内容：纯文本或多模态内容块数组 */
    content: string | ContentPart[]
    /** Anthropic extended thinking 内容（仅 reasoning 模型使用时存在，需在后续请求中回传） */
    thinking?: string
    /** Anthropic extended thinking 签名（API 要求回传，与 thinking 成对出现） */
    thinkingSignature?: string
    /**
     * OpenAI/DeepSeek 推理模型的 reasoning_content（如 DeepSeek R1 的 reasoning_content）
     * 与 Anthropic thinking 不同，此字段用于 OpenAI 兼容 API 的推理内容回传。
     * 两种思考类型的区分是为了避免跨供应商时格式混淆。
     */
    reasoningContent?: string
  /** assistant 消息携带的工具调用 */
  toolCalls?: ToolCallRequest[]
    /** assistant 消息携带的计划执行命令列表 */
    plannedCommands?: string[]
  /** tool 消息携带的工具结果 */
  toolCallId?: string
  /** 工具调用结果内容 */
  toolResult?: string
  /** 工具调用是否出错 */
  isError?: boolean
  /** 工具名称（Gemini functionResponse.name 需要函数名而非 toolCallId） */
  functionName?: string
    /** 有序内容块数组（仅 assistant 消息，用于交错文本/工具调用/媒体） */
    contentBlocks?: ContentBlock[]
    /** 图片附件列表（仅 user 消息支持） */
    images?: ImageAttachment[]
    /** 消息元数据（用于存储命令模板等信息） */
    metadata?: Record<string, unknown>
    /** LLM 调用统计信息 */
    llmStats?: {
        inputTokens: number;
        outputTokens: number;
        provider: string;
        model: string;
        duration: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number
    }[]
}

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** 工具执行状态（仅从 DB 恢复时携带） */
  status?: string
}

// ─── 工具定义（给 LLM 看的） ──────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

// ─── 流式响应块 ────────────────────────────────────────

export type StreamChunk =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; reason?: string }
  /** Anthropic extended thinking 内容（需与 thinkingSignature 一起回传） */
  | { type: 'thinking'; content: string }
  /** OpenAI/DeepSeek 推理模型的 reasoning_content（流中返回的推理内容，回传时用 reasoningContent 字段） */
  | { type: 'reasoning'; content: string }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
  | { type: 'error'; error: Error }
    | {
    type: 'usage';
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number
}
    /** Anthropic extended thinking 签名，必须与 thinking 内容一起回传 */
    | { type: 'thinking_signature'; signature: string }

// ─── 调用参数 ──────────────────────────────────────────

export interface ChatParams {
  messages: readonly ChatMessage[]
  systemPrompt?: string
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  /**
   * 推理/思考强度（undefined=禁用，auto=默认高强度）
   * low/medium/high: 基础强度
   * xhigh/max: 高强度（DeepSeek/Anthropic 支持，OpenAI 会降级为 high）
   */
  thinkingEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  abortSignal?: AbortSignal
  /**
   * Hook 额外上下文
   * 来自 SessionStart/UserPromptSubmit hook 的 additionalContext
   * 会注入到最后一条 user 消息的 content 末尾（Claude Code 规范）
   * 不会作为消息持久化，仅在本次 LLM 调用中生效
   */
  additionalContext?: string
  /**
   * skill/agent 命令模板
   * 作为 system 参数的独立 TextBlock 发送（Anthropic 多块缓存用）
   * 非 Anthropic 适配器会将此拼接回 systemPrompt
   */
  commandTemplate?: string
}

// ─── 模型信息 ──────────────────────────────────────────

export interface ModelInfo {
  provider: string
  model: string
  /** 模型支持的最大上下文 token */
  maxContextTokens: number
  /** 是否支持 tool_use */
  supportsTools: boolean
  /** 是否支持 extended thinking */
  supportsThinking: boolean
}

// ─── 模型配置（从 llmStore 传入，使用 shared/types.ts 中的定义） ──────────────────────

export type {ModelConfig} from '@shared/types'

// ─── 适配器接口 ────────────────────────────────────────

export interface ModelAdapter {
  /** 流式调用 LLM */
  chat(params: ChatParams): AsyncGenerator<StreamChunk>

  /** 获取当前模型信息 */
  getModelInfo(): ModelInfo
}
