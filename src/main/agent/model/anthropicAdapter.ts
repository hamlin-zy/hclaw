/**
 * Anthropic Claude 适配器
 *
 * 使用 @anthropic-ai/sdk 实现流式对话。
 * 支持 tool_use、extended thinking。
 * 支持多模态内容（图片）。
 *
 * 支持两种构造方式：
 * 1. 直接传入 config，内部创建客户端（传统方式）
 * 2. 注入已有的客户端实例（用于全局方案管理）
 */

import Anthropic from '@anthropic-ai/sdk'
import {logger} from '../logger'
import type {
    ChatMessage,
    ChatParams,
    ContentPart,
    ModelAdapter,
    ModelConfig,
    ModelInfo,
    StreamChunk,
    ToolDefinition,
} from './types'
import {injectAdditionalContext} from './utils'

export class AnthropicAdapter implements ModelAdapter {
  private client: Anthropic
  private model: string
  private features: ModelConfig['features'] = undefined

    constructor(config: ModelConfig, injectedClient?: Anthropic) {
        // 如果注入了客户端，直接使用；否则创建新客户端
        this.features = config.features
        if (injectedClient) {
            this.client = injectedClient
        } else {
            this.client = new Anthropic({
                apiKey: config.apiKey || '',
                baseURL: config.baseUrl || undefined,
            })
        }
    this.model = config.model
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
    const { messages, systemPrompt, tools, maxTokens, thinkingEffort, abortSignal, additionalContext, commandTemplate } = params

    let apiMessages = this.convertMessages(messages)

    const useContentBlocks = this.features?.systemContentBlocks

    // 注入 additionalContext 到最后一条 user 消息（Claude Code 规范）
    // 放在缓存点之后，最大化缓存命中
    if (additionalContext) {
      apiMessages = injectAdditionalContext(apiMessages, additionalContext)
    }

    // ★ 构建多块 system 数组：core prompt + command template（各块独立缓存）
    // type 和 cache_control 是精确字面量类型，push 到类型化数组时无需 as const
    const systemBlocks: Anthropic.TextBlockParam[] = []
    if (systemPrompt) {
        systemBlocks.push({ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } })
    }
    if (commandTemplate) {
        systemBlocks.push({ type: 'text', text: commandTemplate, cache_control: { type: 'ephemeral' } })
    }

    // system 参数：多块数组（缓存友好）或降级纯字符串
    const system: Anthropic.MessageCreateParamsStreaming['system'] = useContentBlocks
        ? (systemBlocks.length > 0 ? systemBlocks : undefined)
        : (systemPrompt || undefined)

    const requestParams: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: maxTokens || 8192,
      messages: apiMessages,
      ...(system ? { system } : {}),
      ...(tools?.length ? { tools: this.convertTools(tools) } : {}),
      stream: true,
    }

    // 推理/思考模式：使用 thinkingEffort 控制强度（undefined=禁用）
    // 使用 adaptive thinking（SDK 推荐替代 enabled）+ output_config.effort
    if (thinkingEffort) {
        requestParams.thinking = {
            type: 'adaptive',
        }
        // 手动指定 effort 值（auto 时不传，让模型自动决定）
        // SDK MessageCreateParamsStreaming 已定义 output_config?.effort 为 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        if (thinkingEffort !== 'auto') {
            requestParams.output_config = { effort: thinkingEffort }
        }
    }

    const stream = this.client.messages.stream(requestParams)
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => stream.abort(), { once: true })
    }

    const collectedToolCalls: Map<number, { id: string; name: string; inputJson: string; reason?: string }> = new Map()
    let streamStopReason: string = 'end_turn'

    try {
      for await (const event of stream) {
        if (abortSignal?.aborted) break

        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            // 提取 text 字段作为 reason（模型解释为什么要调用此工具）
            const reason = (event.content_block as any).text
            collectedToolCalls.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
              reason: reason || undefined,
            })
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text }
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking', content: event.delta.thinking }
          } else if (event.delta.type === 'input_json_delta') {
            const tc = collectedToolCalls.get(event.index)
            if (tc) {
              tc.inputJson += event.delta.partial_json
            }
          }
        } else if (event.type === 'content_block_stop') {
          const toolCall = collectedToolCalls.get(event.index)
          if (toolCall) {
            try {
              const input = JSON.parse(toolCall.inputJson || '{}')
              yield {
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input,
                reason: toolCall.reason,
              }
            } catch (err) {
              // JSON 解析失败：不要 yield error 触发 loop 重试（LLM 重试大概率生成同样的非法 JSON）。
              // 跳过这个 tool_use 并发出警告事件，让 LLM 在下一轮看到错误消息并有机会修复参数。
              logger.warn('[AnthropicAdapter] 工具参数 JSON 解析失败，已跳过该工具调用', {
                toolId: toolCall.id,
                toolName: toolCall.name,
                error: err instanceof Error ? err.message : String(err),
                partialJson: toolCall.inputJson?.slice(0, 300) || 'empty',
              })
              // 继续处理后续事件，不抛异常，不触发重试循环
            }
          }
        } else if (event.type === 'message_delta') {
          if ((event as any).delta?.stop_reason) {
            streamStopReason = (event as any).delta.stop_reason
          }
            // 捕获 extended thinking 签名（后续请求必须回传）
            const signature = (event as any).delta?.signature
            if (signature) {
                yield { type: 'thinking_signature', signature }
            }
            const deltaUsage = (event as any).usage
            if (deltaUsage) {
                yield* yieldUsageChunk(deltaUsage)
            }
        } else if (event.type === 'message_stop') {
            const stopUsage = (event as any).message?.usage
            if (stopUsage) {
                yield* yieldUsageChunk(stopUsage)
            }
        }
      }

      if (streamStopReason === 'tool_use') {
        yield { type: 'done', stopReason: 'tool_use' }
      } else if (streamStopReason === 'max_tokens') {
        yield { type: 'done', stopReason: 'max_tokens' }
      } else {
        yield { type: 'done', stopReason: 'end_turn' }
      }
    } catch (err: any) {
      if (abortSignal?.aborted) return
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
    }

      /** 从 Anthropic usage 对象生成统一的 usage chunk */
      function* yieldUsageChunk(usage: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number
      }): Generator<StreamChunk> {
          yield {
              type: 'usage',
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheReadTokens: usage.cache_read_input_tokens || undefined,
              cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
          }
      }
  }

  getModelInfo(): ModelInfo {
    const modelMeta: Record<string, { maxContext: number; thinking: boolean }> = {
      'claude-sonnet-4-20250514': { maxContext: 200000, thinking: true },
      'claude-opus-4-20250514': { maxContext: 200000, thinking: true },
      'claude-3-7-sonnet-20250219': { maxContext: 200000, thinking: true },
      'claude-3-5-sonnet-20241022': { maxContext: 200000, thinking: false },
      'claude-3-5-haiku-20241022': { maxContext: 200000, thinking: false },
    }
    const meta = modelMeta[this.model] || { maxContext: 200000, thinking: false }
    return {
      provider: 'anthropic',
      model: this.model,
      maxContextTokens: meta.maxContext,
      supportsTools: true,
      supportsThinking: meta.thinking,
    }
  }

  // ─── 内部方法 ──────────────────────────────────────

  private convertMessages(messages: readonly ChatMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = []

      const validToolUseIds = new Set<string>()
      const presentToolResultIds = new Set<string>()
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.toolCalls) {
            for (const tc of msg.toolCalls) {
                validToolUseIds.add(tc.id)
            }
        } else if (msg.role === 'tool' && msg.toolCallId) {
            presentToolResultIds.add(msg.toolCallId)
        }
    }

      for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          if (msg.role === 'system') continue

      if (msg.role === 'user') {
          const content = this.convertUserContent(msg.content)
          result.push({role: 'user', content: content as any})
      } else if (msg.role === 'assistant') {
        // 构建 assistant 消息的内容块数组
        const contentBlocks: Anthropic.ContentBlockParam[] = []

        // 如果有 thinking 内容，必须放在 text 之前（Anthropic API 要求）
        // 同时需要回传 signature（必须，API 要求 thinking 块携带 signature）
        // 兼容：当 reasoningContent 存在而 thinking 不存在时（跨供应商消息），将其作为 thinking 内容
        const thinkingText = msg.thinking || (msg as any).reasoningContent
        if (thinkingText) {
            // signature 是 Anthropic API 的必需字段，缺失会导致 400 错误
            // 若确实无 signature（如跨供应商消息），降级为纯文本，跳过 thinking 块
            if (!msg.thinkingSignature) {
                logger.warn('[AnthropicAdapter] assistant 消息有 thinking 内容但无 signature，降级为纯文本', {
                    thinkingLength: String(thinkingText).length,
                })
            } else {
                contentBlocks.push({
                    type: 'thinking' as const,
                    thinking: thinkingText,
                    signature: msg.thinkingSignature,
                })
            }
        }

        const assistantContent = typeof msg.content === 'string' ? msg.content : ''

        if (msg.toolCalls?.length) {
          // 有 tool_calls：包含 text + thinking + tool_use
          // 只包含有对应 tool_result 的 tool_use（Anthropic API 要求每个 tool_use 必须紧跟 tool_result）
          if (assistantContent) {
              contentBlocks.push({type: 'text', text: assistantContent})
          }
          let hasValidToolUse = false
          for (const tc of msg.toolCalls) {
              if (presentToolResultIds.has(tc.id)) {
                  contentBlocks.push({
                      type: 'tool_use',
                      id: tc.id,
                      name: tc.name,
                      input: tc.arguments,
                  } as Anthropic.ToolUseBlockParam)
                  hasValidToolUse = true
              } else {
                  logger.warn(`[AnthropicAdapter] 跳过无对应 tool_result 的 tool_use`, {id: tc.id, name: tc.name})
              }
          }
          if (hasValidToolUse) {
              result.push({ role: 'assistant', content: contentBlocks })
          } else if (contentBlocks.length > 0) {
              // 有 text/thinking 但所有 tool_use 都被跳过 → 纯文本消息
              result.push({ role: 'assistant', content: contentBlocks })
          }
        } else {
          // 没有 tool_calls
          if (msg.thinking) {
              // 有 thinking 内容：必须用 content block 数组形式
              if (assistantContent) {
                  contentBlocks.push({type: 'text', text: assistantContent})
              }
              result.push({role: 'assistant', content: contentBlocks})
          } else {
              // 无 thinking：简单字符串形式（兼容旧格式）
              result.push({role: 'assistant', content: assistantContent})
          }
        }
      } else if (msg.role === 'tool') {
          // 批处理：将所有连续的 tool 消息合并为单个 user 消息中的多个 tool_result 块
          // Anthropic API 要求所有 tool_use 的 tool_result 必须在同一条 user 消息中
          // system 消息（如 skill 工具的 injectMessage）会被跳过，不打断 tool 消息的合并
          const toolBlocks: Anthropic.ToolResultBlockParam[] = []
          while (i < messages.length && (messages[i].role === 'tool' || messages[i].role === 'system')) {
              const toolMsg = messages[i]
              // system 消息在外部循环中已被跳过，但会打断 tool 消息的连续合并；此处一并跳过
              if (toolMsg.role === 'system') {
                  i++
                  continue
              }
              const toolUseId = toolMsg.toolCallId || ''
              if (toolUseId && !validToolUseIds.has(toolUseId)) {
                  i++
                  continue
              }
              toolBlocks.push({
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: toolMsg.toolResult || '',
                  is_error: toolMsg.isError || false,
              } as Anthropic.ToolResultBlockParam)
              i++
          }
          if (toolBlocks.length > 0) {
              result.push({ role: 'user', content: toolBlocks })
          }
          i-- // 补偿外层 for 循环的 i++
      }
    }

    return result
  }

    private convertUserContent(content: string | ContentPart[]): Anthropic.ContentBlockParam[] {
        if (typeof content === 'string') {
            return [{type: 'text', text: content}]
        }

        const blocks: Anthropic.ContentBlockParam[] = []
        for (const part of content) {
            if (part.type === 'text') {
                blocks.push({type: 'text', text: part.text})
            } else if (part.type === 'image_url') {
                const url = part.image_url.url
                if (url.startsWith('data:')) {
                    blocks.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: this.extractMediaType(url),
                            data: this.extractBase64Data(url),
                        },
                    } as any)
                } else if (url.startsWith('http://') || url.startsWith('https://')) {
                    blocks.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/jpeg',
                            data: url,
                        },
                    } as any)
                }
            }
        }

        return blocks.length > 0 ? blocks : [{type: 'text', text: ''}]
    }

    private extractMediaType(dataUrl: string): string {
        const match = dataUrl.match(/data:([^;]+);base64/)
        if (match) {
            const mimeType = match[1]
            if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
                return mimeType
            }
        }
        return 'image/jpeg'
    }

    private extractBase64Data(dataUrl: string): string {
        const match = dataUrl.match(/data:[^;]+;base64,(.+)/)
        return match ? match[1] : dataUrl
    }

  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    const result: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        ...t.inputSchema,
        type: 'object' as const,
      },
    }))
    // 提示词缓存优化：tools 位于前缀最前，给最后一块打 cache_control
    // 可缓存整个工具数组，降低重复发送工具定义的开销
    if (this.features?.systemContentBlocks && result.length > 0) {
      result[result.length - 1].cache_control = { type: 'ephemeral' }
    }
    return result
  }
}
