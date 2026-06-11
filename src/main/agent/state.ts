/**
 * Agent Loop 状态管理
 *
 * 跨迭代携带的可变状态，包含：
 * - 消息历史
 * - 工具调用累积
 * - Token 使用统计
 * - 循环控制
 */

import type {ChatMessage, ToolCallRequest} from './model/types'

export type {ChatMessage} from './model/types'

import {logger} from './logger'

export interface LoopState {
  /** 对话消息历史（只读数组，防止意外修改） */
  readonly messages: ReadonlyArray<ChatMessage>
  /** 当前轮次（每轮 = 一次 LLM 调用） */
  turnCount: number
  /** 累积 token 使用量 */
  tokenUsage: TokenUsage
  /** 是否已中止 */
  aborted: boolean
}

/**
 * 向 LoopState 添加新消息（不可变操作）
 * @returns 新的 LoopState 实例，原实例保持不变
 */
export function addMessage(state: LoopState, message: ChatMessage): LoopState {
  return Object.freeze({
    ...state,
    messages: Object.freeze([...state.messages, message])
  })
}

/**
 * 移除指定索引的消息（不可变操作）
 * @returns 新的 LoopState 实例，原实例保持不变
 */
export function removeMessage(state: LoopState, index: number): LoopState {
  return Object.freeze({
    ...state,
    messages: Object.freeze([
      ...state.messages.slice(0, index),
      ...state.messages.slice(index + 1)
    ])
  })
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** 上下文中估算的总 token 数 */
  estimatedContextTokens: number
}

export function createLoopState(messages: ChatMessage[]): LoopState {
  return Object.freeze({
    messages: Object.freeze([...messages]),
    turnCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, estimatedContextTokens: 0 },
    aborted: false,
  })
}

/** 创建工具结果消息 */
export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  result: { success: boolean; output: any; error?: string },
): ChatMessage {
    // 失败时：确保 LLM 能同时看到错误原因和输出内容
    const isError = !result.success
    let toolResult: string

    if (isError) {
      // 失败情况：组合错误信息和输出内容，确保 LLM 能获得完整的错误上下文
      const errorPart = result.error ? `[ERROR] ${result.error}` : ''
      const outputPart = typeof result.output === 'string' && result.output
        ? result.output
        : typeof result.output !== 'undefined'
          ? JSON.stringify(result.output, null, 2)
          : ''

      // 组合错误和输出：先显示错误，再显示输出
      toolResult = errorPart + (errorPart && outputPart ? '\n' : '') + outputPart
    } else {
      // 成功情况：只显示输出
      if (typeof result.output === 'string') {
        toolResult = result.output
      } else {
        toolResult = JSON.stringify(result.output, null, 2)
      }
    }

  return {
    role: 'tool',
    toolCallId,
    content: '',
      toolResult,
      isError,
      functionName: toolName,
  }
}

/**
 * 归一化消息历史：为孤立的 tool_use 注入合成的 error tool_result
 *
 * Anthropic API 要求每个 tool_use 必须在后续消息中有对应的 tool_result。
 * 当中断或上下文压缩导致部分 tool_use 缺失 tool_result 时，此函数插入
 * 合成的 error result，确保消息顺序完整性，让 LLM 能理解工具被中断。
 *
 * 幂等安全：已存在 tool_result 的 tool_use 不会被重复插入。
 */
export function normalizeToolCallMessages(messages: ReadonlyArray<ChatMessage> | ChatMessage[]): ChatMessage[] {
    const result = [...messages]

    // 1. 收集所有 tool_use ID → { name, arguments }
    const allToolUseMap = new Map<string, { name: string; args: Record<string, unknown> }>()
    for (const msg of result) {
        if (msg.role === 'assistant' && msg.toolCalls) {
            for (const tc of msg.toolCalls) {
                if (!allToolUseMap.has(tc.id)) {
                    allToolUseMap.set(tc.id, { name: tc.name, args: tc.arguments })
                }
            }
        }
    }

    // 2. 收集已有 tool_result ID
    const existingResultIds = new Set<string>()
    for (const msg of result) {
        if (msg.role === 'tool' && msg.toolCallId) {
            existingResultIds.add(msg.toolCallId)
        }
    }

    // 3. 遍历 assistant 消息，查找孤立的 tool_use
    let inserted = 0
    for (let i = 0; i < result.length; i++) {
        const msg = result[i]
        if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue

        const orphaned = msg.toolCalls.filter(tc => !existingResultIds.has(tc.id))
        if (orphaned.length === 0) continue

        // 找到插入位置：在所有连续的 tool 消息之后
        let insertAt = i + 1
        while (insertAt < result.length && result[insertAt].role === 'tool') {
            insertAt++
        }

        // 从后往前插入，保证 tool_use 顺序与 tool_result 顺序一致
        const insertions: ChatMessage[] = []
        for (const tc of orphaned) {
            insertions.push({
                role: 'tool',
                toolCallId: tc.id,
                content: '',
                toolResult: `[INTERRUPTED] 工具调用被中断，未获取到执行结果（tool: ${tc.name}）`,
                isError: true,
            })
            existingResultIds.add(tc.id)
            inserted++
        }
        result.splice(insertAt, 0, ...insertions)
    }

    if (inserted > 0) {
        logger.warn(`[normalizeToolCallMessages] injected synthetic tool_result(s) for orphaned tool_use(s)`, {count: inserted})
    }

    return result
}

/** 创建助手消息（含工具调用、计划命令和可选的 thinking 内容） */
export function createAssistantMessage(
  textContent: string,
  toolCalls: ToolCallRequest[],
  plannedCommands?: string[],
  llmStats?: {
      inputTokens: number;
      outputTokens: number;
      provider: string;
      model: string;
      duration: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number
  },
  /** Anthropic extended thinking 内容，需在后续请求中原样回传 */
  thinkingContent?: string,
  /** Anthropic extended thinking 签名（与 thinking 成对出现） */
  thinkingSignature?: string,
  /** OpenAI/DeepSeek reasoning_content（推理模型回传必需，与 Anthropic thinking 互斥） */
  reasoningContent?: string,
): ChatMessage {
  return {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    role: 'assistant',
    content: textContent,
    thinking: thinkingContent,
    thinkingSignature: thinkingSignature,
    reasoningContent: reasoningContent !== undefined ? reasoningContent : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      plannedCommands: plannedCommands && plannedCommands.length > 0 ? plannedCommands : undefined,
      llmStats: llmStats ? [llmStats] : undefined,
  }
}
