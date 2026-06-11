/**
 * OpenAI GPT 适配器
 *
 * 使用 openai SDK 实现流式对话。
 * 支持 tool_calls（function calling）。
 * 同时兼容任何 OpenAI 兼容 API（Ollama、vLLM 等共用此类也可）。
 * 支持多模态内容（图片）。
 *
 * 支持两种构造方式：
 * 1. 直接传入 config，内部使用缓存创建客户端（传统方式）
 * 2. 注入已有的客户端实例（用于全局方案管理）
 */

import OpenAI from 'openai'
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
import {logger} from '../logger'

export class OpenAIAdapter implements ModelAdapter {
  private client: OpenAI
  private model: string
  private providerName: string

    constructor(config: ModelConfig, injectedClient?: OpenAI) {
        if (injectedClient) {
            this.client = injectedClient
        } else {
            if (!config.apiKey || config.apiKey.trim() === '') {
                throw new Error('API Key is required for OpenAI adapter')
            }
            // 规范化 baseURL：确保包含 /v1 后缀
            // OpenAI SDK 将路径拼接为 {baseURL}/chat/completions
            // 若用户配置了 https://openrouter.ai/api 缺少 /v1，
            // 实际请求会变成 /api/chat/completions（错误）而非 /api/v1/chat/completions（正确）
            let normalizedUrl = config.baseUrl
            if (normalizedUrl) {
                normalizedUrl = normalizedUrl.replace(/\/+$/, '') // 移除尾部斜杠
                if (!normalizedUrl.endsWith('/v1')) {
                    normalizedUrl += '/v1'
                }
            }
            this.client = new OpenAI({
                apiKey: config.apiKey,
                baseURL: normalizedUrl || undefined,
            })
        }
    this.model = config.model
        this.providerName = config._providerName || 'openai'
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
    const { messages, systemPrompt, tools, maxTokens, temperature, thinkingEffort, abortSignal, additionalContext } = params

    let apiMessages = this.convertMessages(messages, systemPrompt)

    // 注入 additionalContext 到最后一条 user 消息（Claude Code 规范）
    // 放在缓存点之后，最大化缓存命中
    if (additionalContext) {
      apiMessages = injectAdditionalContext(apiMessages, additionalContext)
    }

      // MiniMax 不支持 stream_options: { include_usage: true }，会导致无法获取 usage
      const providerName = this.providerName?.toLowerCase()
      const supportsStreamOptions = providerName !== 'minimax'

    const requestParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: apiMessages,
      max_tokens: maxTokens || 4096,
      stream: true,
        ...(supportsStreamOptions ? {stream_options: {include_usage: true}} : {}),
      ...(tools?.length ? { tools: this.convertTools(tools) } : {}),
    }

    // 推理/思考模式：使用 thinkingEffort 控制强度（undefined=禁用）
    if (thinkingEffort) {
        // OpenAI 标准只支持 low/medium/high，auto/xhigh/max 降级为 high
        const finalEffort: string = ['auto', 'xhigh', 'max'].includes(thinkingEffort) ? 'high' : thinkingEffort
        ;(requestParams as any).reasoning_effort = finalEffort

        // 推理模型不支持 temperature 参数，移除
        delete (requestParams as any).temperature
    } else {
        requestParams.temperature = temperature ?? 0.7
    }

    try {
      const stream = await this.client.chat.completions.create(requestParams)

      // 累积 tool_calls（OpenAI 是增量式的，需要拼合）
      const toolCallAccumulator: Map<number, { id: string; name: string; args: string }> = new Map()

        // 用于累积 usage 信息（某些 API 的 usage 在最后一个 chunk）
        let lastInputTokens = 0
        let lastOutputTokens = 0
        let lastCacheReadTokens = 0
        let lastReasoningTokens = 0
        let hasSentUsage = false

        // 辅助函数：发送 usage 信息
        const sendUsage = function* (): Generator<StreamChunk> {
            if (!hasSentUsage && (lastInputTokens > 0 || lastOutputTokens > 0)) {
                yield {
                    type: 'usage',
                    inputTokens: lastInputTokens,
                    outputTokens: lastOutputTokens,
                    cacheReadTokens: lastCacheReadTokens > 0 ? lastCacheReadTokens : undefined,
                    reasoningTokens: lastReasoningTokens > 0 ? lastReasoningTokens : undefined,
                }
                hasSentUsage = true
            }
        }

        // 辅助函数：flush 所有 tool_calls
        const flushToolCalls = function* (): Generator<StreamChunk> {
            for (const [, tc] of toolCallAccumulator) {
                try {
                    const input = JSON.parse(tc.args || '{}')
                    yield {type: 'tool_use', id: tc.id, name: tc.name, input}
                } catch {
                    // JSON 解析失败，跳过
                }
            }
            toolCallAccumulator.clear()
        }

      for await (const chunk of stream) {
        if (abortSignal?.aborted) break

        const choice = chunk.choices?.[0]
        if (!choice) continue

          // 始终收集 usage 信息（某些 API 在最后一个 chunk 才有 usage）
          if (chunk.usage) {
              lastInputTokens = chunk.usage.prompt_tokens || 0
              lastOutputTokens = chunk.usage.completion_tokens || 0
              const details = extractUsageDetails(chunk.usage)
              if (details.cacheReadTokens) lastCacheReadTokens = details.cacheReadTokens
              if (details.reasoningTokens) lastReasoningTokens = details.reasoningTokens
          }

        const delta = choice.delta

        // 文本内容
        if (delta?.content) {
          yield { type: 'text', content: delta.content }
        }

        // reasoning_content（DeepSeek R1 / OpenAI o-series）或 reasoning（Ollama 推理模型）
        // 这些模型在流中返回推理内容，需要捕获并在后续请求中回传
        const reasoningContent = (delta as any).reasoning_content || (delta as any).reasoning
        if (reasoningContent) {
            yield { type: 'reasoning', content: reasoningContent }
        }

        // tool_calls 增量
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallAccumulator.has(idx)) {
              toolCallAccumulator.set(idx, {
                id: tc.id || '',
                name: tc.function?.name || '',
                args: '',
              })
            }
            const acc = toolCallAccumulator.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }
        }

          // 结束处理
          if (choice.finish_reason) {
              const hasToolCalls = toolCallAccumulator.size > 0  // 必须在 flush 前检查
              yield* flushToolCalls()
              yield* sendUsage()
              const stopReason = choice.finish_reason === 'stop'
                  ? (hasToolCalls ? 'tool_use' : 'end_turn')
                  : choice.finish_reason === 'tool_calls' ? 'tool_use'
                      : choice.finish_reason === 'length' ? 'max_tokens'
                          : undefined
              if (stopReason) yield {type: 'done', stopReason}
        }
      }

        // 兜底：如果循环结束但还没发送 usage，尝试发送已累积的信息
        // （某些 API 在流结束后才返回 usage）
      yield* sendUsage()
    } catch (err: any) {
      if (abortSignal?.aborted) return
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  getModelInfo(): ModelInfo {
    const modelMeta: Record<string, number> = {
      'gpt-4o': 128000,
      'gpt-4o-mini': 128000,
      'gpt-4-turbo': 128000,
      'gpt-4': 8192,
      'gpt-3.5-turbo': 16385,
    }
    return {
      provider: this.providerName,
      model: this.model,
      maxContextTokens: modelMeta[this.model] || 128000,
      supportsTools: true,
      supportsThinking: false,
    }
  }

  // ─── 内部方法 ──────────────────────────────────────

  private convertMessages(
    messages: readonly ChatMessage[],
    systemPrompt?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
          // system 消息只支持文本
          const content = typeof msg.content === 'string' ? msg.content : ''
          result.push({role: 'system', content})
      } else if (msg.role === 'user') {
          // user 消息支持多模态内容块
          const content = this.convertUserContent(msg.content)
          result.push({role: 'user', content})
      } else if (msg.role === 'assistant') {
        // 构建 assistant 消息，包含可能存在的 reasoning_content（推理模型回传必需）
        const assistantMsg: Record<string, any> = {
            role: 'assistant',
            content: typeof msg.content === 'string' ? msg.content : null,
        }
        // DeepSeek R1 / OpenAI o-series 要求回传 reasoning_content
        // 使用 !== undefined 判断以兼容空字符串（thinking mode 必须携带此字段）
        if ((msg as any).reasoningContent !== undefined) {
            assistantMsg.reasoning_content = (msg as any).reasoningContent
        } else if ((msg as any).thinking) {
            // 兼容旧的只使用 thinking 字段的消息（没有 reasoningContent 字段）
            assistantMsg.reasoning_content = (msg as any).thinking
        }
        if (msg.toolCalls?.length) {
            assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            }))
        }
        result.push(assistantMsg as any)
      } else if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId || '',
          content: msg.toolResult || '',
        })
      }
    }

    return result
  }

    /**
     * 转换用户消息内容为 OpenAI 格式
     * 支持纯文本或多模态内容块数组
     *
     * 不做客户端过滤，直接透传多模态内容给 API。
     * 模型若不支持视觉，由 API 层返回错误，避免静默丢图。
     *
     * 注：image_url 的过滤由 agent loop (controller.ts) 在调用 adapter.chat()
     * 之前按模型能力处理，不在 adapter 层过滤。
     */
    private convertUserContent(content: string | ContentPart[]): string | any[] {
        if (typeof content === 'string') return content
        return content.map(part => {
            if (part.type === 'text') {
                return {type: 'text', text: part.text}
            }
            if (part.type === 'image_url') {
                return {
                    type: 'image_url',
                    image_url: {url: part.image_url.url, detail: part.image_url.detail || 'auto'}
                }
            }
            if (part.type === 'input_audio') {
                return {
                    type: 'input_audio',
                    input_audio: {data: part.input_audio.data, format: part.input_audio.format}
                }
            }
            return part
        })
    }

  /**
   * 注入 additionalContext 到 OpenAI 格式的消息中
   * Claude Code 规范：在最后一条 user 消息的 content 末尾追加
   * 这样可以最大化缓存命中（缓存点在 additionalContext 之前）
   */
  private _injectAdditionalContext(
    messages: OpenAI.ChatCompletionMessageParam[],
    additionalContext: string
  ): OpenAI.ChatCompletionMessageParam[] {
    // 找到最后一条 role='user' 的消息
    const contextText = `\n\n📎 背景信息:\n${additionalContext}`
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          msg.content += contextText
        } else if (Array.isArray(msg.content)) {
          msg.content.push({type: 'text', text: contextText})
        }
        return messages
      }
    }
    return messages
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }
}

/** OpenAI usage 对象中的扩展细节类型 */
interface OpenAIUsageDetails {
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
}

/** 从 OpenAI usage 对象提取缓存/推理 token 等扩展指标 */
function extractUsageDetails(usage: OpenAIUsageDetails): { cacheReadTokens?: number; reasoningTokens?: number } {
    return {
        cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || undefined,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || undefined,
    }
}
