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
import {isSyntheticToolResult} from '../state'

export class OpenAIAdapter implements ModelAdapter {
  private client: OpenAI
  private model: string
  private providerName: string
    /** API 协议形态：chat（默认）/ responses */
    private apiStyle: 'chat' | 'responses'
  /** AdapterConvertCache — 增量 API 消息转换缓存（随 adapter 实例，重建自动清空） */
  private convertCache: {
    count: number
    result: OpenAI.ChatCompletionMessageParam[]
    /** 前缀结构指纹：缓存段每条消息的 role + tool 关联 id 的签名，命中时校验前缀未变 */
    prefixKey: string
  } | null = null
  /** 保存配置以供 convertAll 等方法使用 features 等字段 */
  private config: ModelConfig

    constructor(config: ModelConfig, injectedClient?: OpenAI) {
        this.apiStyle = config.apiStyle || 'chat'
        this.config = config
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

    if (this.apiStyle === 'responses') {
      yield* this.chatResponses(params)
      return
    }

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
      // ★ 累积完整 reasoning_content（用于流结束时提取 dots 格式工具调用）
      let accumulatedReasoning = ''
      // ★ 当前已注册的工具名集合（用于提取 dots 工具调用时的 name 校验）
      const availableToolNames = new Set((tools || []).map(t => t.name))

        // 用于累积 usage 信息（某些 API 的 usage 在最后一个 chunk）
        const usage = {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0}
        const sendUsage = this.buildSendUsage(usage)

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

          // ★ 修正顺序：OpenAI 标准流式响应（stream_options: {include_usage: true}）中，
          // usage 位于最后一个 choices 为空的独立 chunk。必须先收集再跳过空 choices，
          // 否则永远收不到 usage，统计信息缺失。
          if (chunk.usage) {
              usage.outputTokens = chunk.usage.completion_tokens || 0
              const details = extractUsageDetails(chunk.usage)
              const cached = details.cacheReadTokens || 0
              if (cached > 0) usage.cacheReadTokens = cached
              // ★ 核心修正：OpenAI 的 prompt_tokens 是总输入（已包含 cached_tokens，见官方文档
              // 示例 prompt_tokens: 2006, cached_tokens: 1920），而 Anthropic 的 input_tokens 不含
              // 缓存部分（缓存单独用 cache_read_input_tokens 上报）。UI 层统一按 Anthropic 语义
              // 计算（上下文 = input + cacheRead），若原样上报会双算缓存 token 导致上下文虚高、
              // 命中率被稀释。因此减去 cached 部分，使 inputTokens 语义与 Anthropic 对齐。
              usage.inputTokens = Math.max(0, (chunk.usage.prompt_tokens || 0) - cached)
              if (details.reasoningTokens) usage.reasoningTokens = details.reasoningTokens
          }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta

        // 文本内容
        if (delta?.content) {
          yield { type: 'text', content: delta.content }
        }

        // reasoning_content（DeepSeek R1 / OpenAI o-series）或 reasoning（Ollama 推理模型）
        // 这些模型在流中返回推理内容，需要捕获并在后续请求中回传
        const reasoningContent = (delta as any).reasoning_content || (delta as any).reasoning
        if (reasoningContent) {
            // ★ 累积完整 reasoning（用于流结束时提取 dots 格式工具调用）
            accumulatedReasoning += reasoningContent
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
              // ★ dots 模型（dots-3-note-preview:free）会把工具调用放在 reasoning_content 中
              //   而非标准的 tool_calls 字段。vLLM DotsToolParser 确认其格式为：
              //     <invoke name="toolName"><parameter name="key">value
              //   只在流结束时做一次完整提取，避免跨 chunk 问题，不影响其他服务商。
              if (accumulatedReasoning) {
                  const extracted = extractDotsToolCalls(accumulatedReasoning, availableToolNames)
                  for (const tc of extracted) {
                      const idx = toolCallAccumulator.size
                      toolCallAccumulator.set(idx, { id: tc.id, name: tc.name, args: tc.arguments })
                  }
              }
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

  /**
   * Responses API 路径（apiStyle === 'responses'）
   * 转换规则：
   * - systemPrompt → instructions
   * - messages → input 数组（user/assistant 文本、function_call / function_call_output 工具历史）
   * - tools → responses 格式（function 工具，strict 缺省 false）
   * - 流式事件：response.output_text.delta / response.function_call_arguments.delta / response.completed
   * - usage：response.usage（input_tokens / output_tokens）
   * - 推理强度：reasoning: {effort}
   */
  private async *chatResponses(params: ChatParams): AsyncGenerator<StreamChunk> {
    const { messages, systemPrompt, tools, maxTokens, thinkingEffort, abortSignal, additionalContext } = params

    let input = this.convertToResponsesInput(messages)

    if (additionalContext) {
      // 注入 additionalContext 到最后一条 user 输入（与 chat 路径一致）
      const last = input[input.length - 1]
      if (last && last.role === 'user' && typeof last.content === 'string') {
        input = [...input.slice(0, -1), { ...last, content: last.content + '\n\n' + additionalContext }]
      }
    }

    const requestParams: any = {
      model: this.model,
      input,
      stream: true,
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      ...(tools?.length ? { tools: this.convertToolsResponses(tools) } : {}),
    }

    // max_output_tokens（Responses API 参数名）
    if (maxTokens) requestParams.max_output_tokens = maxTokens

    // 推理强度：Responses API 使用 reasoning: {effort}（low/medium/high）
    if (thinkingEffort) {
      const finalEffort: string = ['auto', 'xhigh', 'max'].includes(thinkingEffort) ? 'high' : thinkingEffort
      requestParams.reasoning = { effort: finalEffort }
    }

    try {
      const stream = await this.client.responses.create(requestParams as any)

      // 累积 function_call 参数（增量 delta）
      const callAccumulator = new Map<string, { name: string; args: string }>()
      // 用于累积 usage 信息（Responses API 在 response.completed 返回）
      const usage = {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0}
      const sendUsage = this.buildSendUsage(usage)

      const flushCalls = function* (): Generator<StreamChunk> {
        for (const [callId, acc] of callAccumulator) {
          try {
            const inputArgs = JSON.parse(acc.args || '{}')
            yield { type: 'tool_use', id: callId, name: acc.name || callId, input: inputArgs }
          } catch {
            // JSON 解析失败，跳过
          }
        }
        callAccumulator.clear()
      }

      let gotDone = false
      // 流中出现工具调用即置位（function_call 输出项 / 参数增量），completed 时对齐
      // chat 路径契约：finish_reason==='tool_calls' 或 'stop'+hasToolCalls → 'tool_use'
      let hasToolCalls = false
      for await (const event of stream as any) {
        if (abortSignal?.aborted) break

        if (event.type === 'response.output_text.delta') {
          yield { type: 'text', content: event.delta }
        } else if (event.type === 'response.reasoning_summary_text.delta') {
          yield { type: 'reasoning', content: event.delta }
        } else if (event.type === 'response.function_call_arguments.delta') {
          hasToolCalls = true
          const acc = callAccumulator.get(event.item_id) || { name: event.item_id, args: '' }
          acc.args += event.delta
          // output_index 与 item_id 联合定位；name 由 item 创建事件提供（见下方 output_item.added）
          callAccumulator.set(event.item_id, acc)
        } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          hasToolCalls = true
          callAccumulator.set(event.item.id, { name: event.item.name || '', args: '' })
        } else if (event.type === 'response.completed') {
          gotDone = true
          // 兜底校验：即使未观测到增量事件，completed.response.output 含 function_call 也视为工具调用
          if (Array.isArray(event.response?.output)) {
            hasToolCalls = hasToolCalls || event.response.output.some((item: any) => item.type === 'function_call')
          }
          const usageData = event.response?.usage
          if (usageData) {
            usage.inputTokens = usageData.input_tokens || 0
            usage.outputTokens = usageData.output_tokens || 0
          }
          yield* flushCalls()
          yield* sendUsage()
          yield {
            type: 'done',
            stopReason: event.response?.status === 'incomplete'
              ? 'max_tokens'
              : (hasToolCalls ? 'tool_use' : 'end_turn'),
          }
        }
      }

      // 兜底：流结束未收到 completed
      if (!gotDone && !abortSignal?.aborted) {
        yield* flushCalls()
        yield* sendUsage()
        yield { type: 'done', stopReason: 'end_turn' }
      }
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

  /** 失效增量转换缓存（normalize 注入/取代后由调用方触发，下次全量重建） */
  invalidateConvertCache(): void {
    this.convertCache = null
  }

  // ─── 内部方法 ──────────────────────────────────────

  /**
   * 计算消息数组的「结构指纹」：role + 工具关联 id + tool 结果内容指纹。
   *
   * 用于增量缓存的命中校验：只有当输入前缀的 role 序列、工具关联 id 与
   * tool 结果内容与缓存构建时一致，增量追加才是安全的。
   * normalize 合成注入/取代（[INTERRUPTED] ↔ 真实结果）、ContextRetrieval
   * 中间插入都会改变指纹 → 触发全量重建，避免孤儿 tool 消息
   * （opencode 400: Messages with role 'tool' must be a response to a preceding
   *  message with role 'tool_calls'）。
   */
  private static buildPrefixKey(messages: readonly ChatMessage[], count: number): string {
    let key = ''
    for (let i = 0; i < count; i++) {
      const m = messages[i]
      if (m.role === 'tool') {
        // tool 消息：关联 id + 合成标记（合成 → 真实取代会改变此标记）
        key += 't:' + (m.toolCallId || '') + ':' + (isSyntheticToolResult(m) ? 'syn' : 'real') + ';'
      } else {
        key += (m.role || '?')[0] + ':'
        if (m.role === 'assistant' && m.toolCalls?.length) {
          key += m.toolCalls.map(tc => tc.id).join(',')
        }
        key += ';'
      }
    }
    return key
  }

  private convertMessages(
    messages: readonly ChatMessage[],
    systemPrompt?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    // 命中判定：长度相等 + 前缀结构指纹一致（同 turn 重试 / 纯追加且前缀未变）
    if (this.convertCache && this.convertCache.count === messages.length) {
      const prefixKey = OpenAIAdapter.buildPrefixKey(messages, messages.length)
      if (this.convertCache.prefixKey === prefixKey) {
        return this.convertCache.result
      }
      // 长度相同但内容变化（如合成消息被真实结果取代）→ 全量重建
      return this.rebuildCache(messages, systemPrompt, prefixKey)
    }

    // 缓存无效或消息减少 → 全量重建
    if (!this.convertCache || this.convertCache.count > messages.length) {
      return this.rebuildCache(messages, systemPrompt)
    }

    // 增量：只转换新增段 [prevCount, end)，但先校验前缀结构未变
    const prevCount = this.convertCache.count
    const cachedPrefixKey = OpenAIAdapter.buildPrefixKey(messages, prevCount)
    if (this.convertCache.prefixKey !== cachedPrefixKey) {
      // 前缀内容变化（合成注入/取代/中间插入）→ 增量前提被破坏，全量重建
      return this.rebuildCache(messages, systemPrompt)
    }

    const result: OpenAI.ChatCompletionMessageParam[] = [...this.convertCache.result]
    for (let i = prevCount; i < messages.length; i++) {
      result.push(this.convertOneMessage(messages[i]))
    }
    const prefixKey = OpenAIAdapter.buildPrefixKey(messages, messages.length)
    this.convertCache = {count: messages.length, result, prefixKey}
    return result
  }

  /**
   * 全量重建转换缓存并返回结果。
   * prefixKey 已算出时复用（命中分支），否则重新计算。
   */
  private rebuildCache(
    messages: readonly ChatMessage[],
    systemPrompt: string | undefined,
    prefixKey?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const full = this.convertAll(messages, systemPrompt)
    this.convertCache = {
      count: messages.length,
      result: full,
      prefixKey: prefixKey ?? OpenAIAdapter.buildPrefixKey(messages, messages.length),
    }
    return full
  }

  /** 全量转换（原逻辑抽取，供 convertMessages 首轮与测试使用） */
  private convertAll(
    messages: readonly ChatMessage[],
    systemPrompt?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = []
    if (systemPrompt) {
      const systemMsg: Record<string, any> = { role: 'system', content: systemPrompt }
      // 为支持显式提示词缓存的服务商添加 cache_control
      // 适用：OpenRouter（网关翻译）、阿里百炼/通义千问（原生支持）、Google Gemini（原生支持，仅最后一个断点生效）
      // 通过 ModelConfig.features.supportsExplicitCaching 判断（由 modelSelector 从 ProviderPreset 透传）
      const features = this.config.features
      if (features?.supportsExplicitCaching) {
        systemMsg.cache_control = { type: 'ephemeral' }
      }
      result.push(systemMsg as OpenAI.ChatCompletionMessageParam)
    }
    for (const msg of messages) {
      result.push(this.convertOneMessage(msg))
    }
    return result
  }

  /**
   * 转换单条消息为 OpenAI Chat Completions 格式（system/user/assistant/tool）。
   * - system 消息只支持文本
   * - user 消息支持多模态内容块
   * - assistant 消息保留 reasoning_content（DeepSeek R1 / OpenAI o-series 回传必需，
   *   用 !== undefined 判断以兼容空字符串），兼容旧的 thinking 字段
   * - tool 消息携带 tool_call_id
   */
  private convertOneMessage(msg: ChatMessage): OpenAI.ChatCompletionMessageParam {
    if (msg.role === 'system') {
      const systemMsg: Record<string, any> = { role: 'system', content: typeof msg.content === 'string' ? msg.content : '' }
      // 为支持显式提示词缓存的服务商添加 cache_control
      const features = this.config.features
      if (features?.supportsExplicitCaching) {
        systemMsg.cache_control = { type: 'ephemeral' }
      }
      return systemMsg as OpenAI.ChatCompletionMessageParam
    }
    if (msg.role === 'user') {
      return {role: 'user', content: this.convertUserContent(msg.content)}
    }
    if (msg.role === 'assistant') {
      const assistantMsg: Record<string, any> = {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : null,
      }
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
      return assistantMsg as any
    }
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId || '',
      content: msg.toolResult || '',
    }
  }

  /** 测试辅助：走增量缓存路径 */
  convertMessagesForTest(messages: readonly ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return this.convertMessages(messages)
  }

  /** 测试辅助：绕过缓存走全量路径 */
  convertMessagesForTestFull(messages: readonly ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return this.convertAll(messages)
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

  /**
   * 将 ChatMessage[] 转换为 Responses API 的 input 数组
   * - system/系统提示：并入 instructions（由调用方处理 systemPrompt 参数），此处跳过
   * - user：{role: 'user', content: string | ContentPart[]}
   * - assistant 含工具调用：{role: 'assistant', content, ...} + function_call 项
   * - tool 结果：{type: 'function_call_output', call_id, output}
   */
  private convertToResponsesInput(
    messages: readonly ChatMessage[],
  ): any[] {
    const input: any[] = []
    for (const msg of messages) {
      if (msg.role === 'system') continue // system 消息由 instructions 承载，跳过避免重复
      if (msg.role === 'user') {
        input.push({ role: 'user', content: this.convertUserContent(msg.content) })
      } else if (msg.role === 'assistant') {
        const item: any = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : null }
        if (msg.toolCalls?.length) {
          item.type = 'message'
          input.push(item)
          for (const tc of msg.toolCalls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments || {}),
            })
          }
          continue
        }
        input.push(item)
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId || '',
          output: msg.toolResult || '',
        })
      }
    }
    return input
  }

  /** Responses API 工具转换（结构与 chat 基本一致，strict 由服务端默认） */
  private convertToolsResponses(tools: ToolDefinition[]): any[] {
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }))
  }

  /**
   * 构建 usage 上报生成器（chat / responses 双路径共用）。
   * 只发送一次；cacheReadTokens / reasoningTokens 仅在大于 0 时携带（chat 路径专属）。
   */
  private buildSendUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number }): () => Generator<StreamChunk> {
    let hasSentUsage = false
    return function* (): Generator<StreamChunk> {
      if (!hasSentUsage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        yield {
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens ? usage.cacheReadTokens : undefined,
          reasoningTokens: usage.reasoningTokens ? usage.reasoningTokens : undefined,
        }
        hasSentUsage = true
      }
    }
  }

  /** 测试辅助：暴露 Responses input 转换结果 */
  convertMessagesForTestResponses(messages: readonly ChatMessage[]): any[] {
    return this.convertToResponsesInput(messages)
  }
}

/**
 * 从 reasoning_content 中提取 dots 格式的工具调用。
 *
 * dots 模型格式（vLLM DotsToolParser 确认）：
 *   <invoke name=toolName><parameter name=key>value
 *   <parameter name=key2>value2
 *
 * 严谨判定策略：
 * 1. 必须匹配完整的 <invoke> 开闭合标签
 * 2. name 属性值必须匹配当前已注册的工具名
 * 3. 参数以 JSON 字符串形式返回（供下游直接作为 arguments）
 *
 * @param text 完整的 reasoning_content 文本
 * @param availableToolNames 当前已注册的工具名集合
 * @returns 提取的工具调用列表
 */
function extractDotsToolCalls(
    text: string,
    availableToolNames: Set<string>,
): Array<{ id: string; name: string; arguments: string }> {
    const results: Array<{ id: string; name: string; arguments: string }> = []

    // 匹配完整的 invoke 开闭合块
    const invokeRegex = /<invoke\s+name\s*=\s*["\x27]?([^">\s]+)["\x27]?\s*>([\s\S]*?)<\/invoke>/g
    let match: RegExpExecArray | null

    while ((match = invokeRegex.exec(text)) !== null) {
        const toolName = match[1].trim()
        const body = match[2]

        // 条件1：工具名必须在已注册集合中
        if (!availableToolNames.has(toolName)) continue

        // 提取参数: <parameter name=K>V
        const params: Record<string, string> = {}
        const paramRegex = /<parameter\s+name\s*=\s*["\x27]?([^">\s]+)["\x27]?\s*>([\s\S]*?)<\/parameter>/g
        let paramMatch: RegExpExecArray | null
        while ((paramMatch = paramRegex.exec(body)) !== null) {
            params[paramMatch[1].trim()] = paramMatch[2].trim()
        }

        // 条件2：参数提取为 JSON 字符串（JSON.stringify 产物必然合法，无需再校验）
        const argsJson = JSON.stringify(params)

        results.push({
            id: `dots-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: toolName,
            arguments: argsJson,
        })
    }

    return results
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
