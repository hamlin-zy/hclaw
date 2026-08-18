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
import {formatToolResult, interruptedToolResult} from '@shared/utils/toolResult'

/** 分块持久化追加结构 — append 时共享前面所有满块，仅复制最后一个不满块 */
const CHUNK_SIZE = 32

export class ChunkedMessages {
  private chunks: ReadonlyArray<ChatMessage>[]

  constructor(messages: ChatMessage[] = []) {
    this.chunks = []
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      this.chunks.push(Object.freeze(messages.slice(i, i + CHUNK_SIZE)))
    }
  }

  /** 追加一条消息 — 仅复制块索引数组与最后一个不满块 */
  append(msg: ChatMessage): ChunkedMessages {
    const result = new ChunkedMessages()
    result.chunks = [...this.chunks]
    const last = result.chunks[result.chunks.length - 1]
    if (last && last.length < CHUNK_SIZE) {
      result.chunks[result.chunks.length - 1] = Object.freeze([...last, msg])
    } else {
      result.chunks.push(Object.freeze([msg]))
    }
    return result
  }

  /** O(n) 扁平化 — 仅在需要完整数组时调用 */
  toArray(): ChatMessage[] {
    if (this.chunks.length === 0) return []
    if (this.chunks.length === 1) return [...this.chunks[0]]
    const total = this.length
    const result: ChatMessage[] = new Array(total)
    let offset = 0
    for (const c of this.chunks) {
      for (const m of c) result[offset++] = m
    }
    return result
  }

  get length(): number {
    let n = 0
    for (const c of this.chunks) n += c.length
    return n
  }
}

export interface LoopState {
  /** 对话消息历史（只读数组，防止意外修改） */
  readonly messages: ReadonlyArray<ChatMessage>
  /** 当前轮次（每轮 = 一次 LLM 调用） */
  turnCount: number
  /** 累积 token 使用量 */
  tokenUsage: TokenUsage
  /** 是否已中止 */
  aborted: boolean
  /** 分块持久化存储（内部结构共享，追加 O(块)） */
  readonly _chunked: ChunkedMessages
}

/**
 * 向 LoopState 添加新消息（不可变操作）
 * @returns 新的 LoopState 实例，原实例保持不变
 */
export function addMessage(state: LoopState, message: ChatMessage): LoopState {
  const next = state._chunked.append(message)
  return Object.freeze({
    ...state,
    messages: Object.freeze(next.toArray()),
    _chunked: next,
  })
}

/**
 * 移除指定索引的消息（不可变操作）
 * @returns 新的 LoopState 实例，原实例保持不变
 */
export function removeMessage(state: LoopState, index: number): LoopState {
  const next = new ChunkedMessages([
    ...state.messages.slice(0, index),
    ...state.messages.slice(index + 1),
  ])
  return Object.freeze({
    ...state,
    messages: Object.freeze([...next.toArray()]),
    _chunked: next,
  })
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** 上下文中估算的总 token 数 */
  estimatedContextTokens: number
}

export function createLoopState(messages: ChatMessage[]): LoopState {
  const chunked = new ChunkedMessages(messages)
  return Object.freeze({
    messages: Object.freeze([...messages]),
    _chunked: chunked,
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
  return {
    role: 'tool',
    toolCallId,
    content: '',
    toolResult: formatToolResult(result),
    isError: !result.success,
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
                toolResult: interruptedToolResult(tc.name),
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

/**
 * 判定消息是否为 normalize 注入的合成 error tool 结果。
 *
 * 不能用 isError 单独判定：真实失败结果（createToolResultMessage，
 * isError = !result.success）也是 isError: true。合成消息的精确特征：
 * content 为空 + toolResult 以 [INTERRUPTED] 开头。
 */
export function isSyntheticToolResult(msg: ChatMessage): boolean {
    return msg.role === 'tool' && msg.isError === true
        && msg.content === ''
        && typeof msg.toolResult === 'string'
        && msg.toolResult.startsWith('[INTERRUPTED]')
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
      ttftMs?: number;
      decodeMs?: number;
      tokensPerSecond?: number
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
