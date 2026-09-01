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
import {isSyntheticToolResult} from '../state'
import {logger} from '../logger'
import {recordingFetch} from '../../utils/llmTraceRecorder'

export class OpenAIAdapter implements ModelAdapter {
  private client: OpenAI
  private model: string
  private providerName: string
    /** API 协议形态：chat（默认）/ responses */
    readonly apiStyle: 'chat' | 'responses'
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
            // 不做 /v1 自动补全：各厂商路径不同（智谱为 …/api/paas/v4），
            // OpenAI SDK 只拼 {baseURL}/chat/completions，由用户保证 baseUrl 完整
            this.client = new OpenAI({
                apiKey: config.apiKey,
                baseURL: config.baseUrl || undefined,
                fetch: recordingFetch,
            })
        }
    this.model = config.model
        this.providerName = config._providerName || 'openai'
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
    const { messages, systemPrompt, tools, maxTokens, temperature, thinkingEffort, abortSignal } = params

    if (this.apiStyle === 'responses') {
      yield* this.chatResponses(params)
      return
    }

    let apiMessages = this.convertMessages(messages, systemPrompt)

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

    // 推理/思考模式：使用 thinkingEffort 控制强度（undefined=未指定，disabled=显式禁用）
    if (thinkingEffort === 'disabled') {
        // 显式禁用：按供应商语义发送关闭参数；temperature 保持常规行为
        this.applyThinkingDisabled(requestParams as any, false)
        requestParams.temperature = temperature ?? 0.7
    } else if (thinkingEffort) {
        const finalEffort = this.resolveThinkingEffort(thinkingEffort)
        ;(requestParams as any).reasoning_effort = finalEffort

        // 推理模型不支持 temperature 参数，移除
        delete (requestParams as any).temperature
    } else {
        requestParams.temperature = temperature ?? 0.7
    }

    // 创建流；若因注入的思考关闭参数不被网关支持而报 400，剔除后重试一次
    const createStream = (params: typeof requestParams) => this.client.chat.completions.create(params)
    const isThinkingParamRejection = (err: any): boolean => {
      const status = err?.status ?? err?.statusCode
      if (status !== 400) return false
      const msg = String(err?.message ?? err ?? '').toLowerCase()
      return ['thinking', 'enable_thinking', 'reasoning', 'unrecognized', 'unexpected'].some(k => msg.includes(k))
    }

    try {
      let stream: Awaited<ReturnType<typeof createStream>>
      try {
        stream = await createStream(requestParams)
      } catch (err: any) {
        if (thinkingEffort === 'disabled' && isThinkingParamRejection(err)) {
          logger.warn('[openaiAdapter] 网关不支持思考关闭参数(400)，剔除后重试', {
            model: this.model, error: String(err?.message ?? err),
          })
          const retryParams = {...requestParams} as any
          delete retryParams.thinking
          delete retryParams.enable_thinking
          stream = await createStream(retryParams)
        } else {
          throw err
        }
      }

      // 累积 tool_calls（OpenAI 是增量式的，需要拼合）
      const toolCallAccumulator: Map<number, { id: string; name: string; args: string }> = new Map()
      // ★ 累积完整 reasoning_content（用于流结束时提取 dots 格式工具调用）
      let accumulatedReasoning = ''
      // ★ 累积完整正文 content（dots 模型有时把工具调用写在正文而非 reasoning_content）
      let accumulatedText = ''
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
          accumulatedText += delta.content
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
            //
            //   同时也从正文 content 中提取：dots 有时把 <invoke> 写到正文而非 reasoning_content。
            //   正文提取使用 strict 模式（剥离代码块 + 纯调用校验），防止模型在正文中
            //   举例说明工具用法时被误判为真实调用而误执行。
            //   正文中的 <invoke> 标签在提取后仍残留在 text 流中（与 reasoning 行为一致，
            //   由渲染层在 think 块中显示；若需清理正文需额外处理，此处不改动 text 事件流）。
            const registerDotsCalls = (text: string, strict = false) => {
                for (const tc of extractDotsToolCalls(text, availableToolNames, strict)) {
                    const idx = toolCallAccumulator.size
                    toolCallAccumulator.set(idx, { id: tc.id, name: tc.name, args: tc.arguments })
                }
            }
            // reasoning 宽松提取（思维过程出现 invoke 即真实意图）；正文 strict 提取
            registerDotsCalls(accumulatedReasoning)
            registerDotsCalls(accumulatedText, true)
            const hasToolCalls = toolCallAccumulator.size > 0 // 必须在 flush 前检查
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
    const { messages, systemPrompt, tools, maxTokens, thinkingEffort, abortSignal } = params

    let input = this.convertToResponsesInput(messages)

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
    if (thinkingEffort === 'disabled') {
      this.applyThinkingDisabled(requestParams, true)
    } else if (thinkingEffort) {
      const finalEffort = this.resolveThinkingEffort(thinkingEffort)
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

  /**
   * 判定端点是否为 OpenAI 官方端点：
   * baseUrl 为空（SDK 默认 api.openai.com）或包含 api.openai.com → 官方；
   * 其余视为第三方兼容网关（含 Ollama/vLLM/OpenRouter 等）。
   */
  private isOfficialOpenAIEndpoint(): boolean {
    const baseUrl = (this.config as ModelConfig).baseUrl
    return !baseUrl || baseUrl.includes('api.openai.com')
  }

  /**
   * 按端点来源解析 thinkingEffort 的实际发送值：
   * - 官方端点：'auto' → 'medium'（OpenAI 官方默认）；'xhigh'/'max' 原样透传（新模型原生支持）
   * - 第三方兼容网关：'auto' → 'high'；'xhigh'/'max' → 'high'（多数网关不认识新档位）
   * - 其他档位（none/minimal/low/medium/high）原样透传。
   * 发生映射/降级时记录日志（模型名 + 原值 + 实际发送值）。
   */
  private resolveThinkingEffort(effort: string): string {
    const official = this.isOfficialOpenAIEndpoint()
    let finalEffort = effort
    if (effort === 'auto') {
      finalEffort = official ? 'medium' : 'high'
    } else if ((effort === 'xhigh' || effort === 'max') && !official) {
      finalEffort = 'high'
    }
    if (finalEffort !== effort) {
      logger.info('[OpenAIAdapter] thinkingEffort 映射', {model: this.model, original: effort, sent: finalEffort})
    }
    return finalEffort
  }

  /**
   * 显式禁用思考（thinkingEffort === 'disabled'）时按供应商发送对应关闭参数。
   * 参数族按 baseUrl 判定（同 isOfficialOpenAIEndpoint 的模式匹配先例）：
   * 发错字段对部分供应商是 400（如 OpenAI 官方不认识 thinking 字段），
   * 未知第三方网关不发参数（安全兜底，由显示层抑制 reasoning 展示）。
   * 返回是否实际发送了关闭参数（仅用于日志）。
   */
  private applyThinkingDisabled(requestParams: any, responsesStyle: boolean): boolean {
    const baseUrl = (this.config as ModelConfig).baseUrl || ''
    const model = this.model

    // 智谱：thinking:{type} 参数族；GLM-5.3 系列为强制思考模型，传 disabled 会 400，跳过
    const isZhipu = baseUrl.includes('bigmodel.cn')
    if (isZhipu && /^glm-5\.3/i.test(model)) {
      logger.info('[OpenAIAdapter] 强制思考模型不支持关闭思考，跳过关闭参数', {model})
      return false
    }
    if (isZhipu || baseUrl.includes('deepseek.com') || baseUrl.includes('volces.com')) {
      // 智谱 / DeepSeek / 火山方舟：thinking:{type} 参数族（disabled=强制关闭）
      requestParams.thinking = {type: 'disabled'}
      return true
    }
    if (baseUrl.includes('aliyuncs.com') || baseUrl.includes('dashscope.aliyun')) {
      // 阿里百炼 compatible-mode：enable_thinking 开关（「仅思考」模型不支持关闭，会忽略或报错）
      requestParams.enable_thinking = false
      return true
    }
    if (baseUrl.includes('openrouter.ai')) {
      // OpenRouter 统一网关：reasoning.effort=none（OpenRouter 归一化转发给上游）
      requestParams.reasoning = {effort: 'none'}
      return true
    }
    if (this.isOfficialOpenAIEndpoint()) {
      // OpenAI 官方：chat 用 reasoning_effort，responses 用 reasoning:{effort}
      if (responsesStyle) requestParams.reasoning = {effort: 'none'}
      else requestParams.reasoning_effort = 'none'
      return true
    }
    // 未知第三方 OpenAI 兼容网关：默认按国内厂商通用语义发送 thinking:{type:"disabled"}
    // （智谱/DeepSeek/火山/硅基流动等均为此参数族）。个别严格网关可能拒绝未知字段，
    // 由 chat 路径的 400 降级重试兜底（剔除该参数后重发一次）。
    requestParams.thinking = {type: 'disabled'}
    logger.info('[OpenAIAdapter] 未识别网关，disabled 默认发送 thinking:disabled（400 时自动降级）', {model, baseUrl})
    return true
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

    /**
     * 转换用户消息内容为 Responses API 格式。
     * - text → input_text
     * - image_url → input_image（image_url 为扁平字符串，与 chat 路径嵌套对象不同）
     * - input_audio 暂不涉及（Responses 音频为 pcm 格式，超范围，原样透传由 API 报错）
     */
    private convertUserContentResponses(content: string | ContentPart[]): any[] {
        if (typeof content === 'string') return content as any
        return content.map(part => {
            if (part.type === 'text') {
                return {type: 'input_text', text: part.text}
            }
            if (part.type === 'image_url') {
                const imgItem: Record<string, unknown> = {type: 'input_image', image_url: part.image_url.url}
                if (part.image_url.detail) imgItem.detail = part.image_url.detail
                return imgItem
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
   * - 首条 system：并入 instructions（由调用方处理 systemPrompt 参数），此处跳过；
   *   mid-stream system 转为 user 项原位保留（Responses input 不接受 system 角色）
   * - user：{role: 'user', content: string | ContentPart[]}
   * - assistant 含工具调用：{role: 'assistant', content, ...} + function_call 项
   * - tool 结果：{type: 'function_call_output', call_id, output}
   */
  private convertToResponsesInput(
    messages: readonly ChatMessage[],
  ): any[] {
    const input: any[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'system') {
        // 首条 system 由 instructions 承载（调用方处理 systemPrompt），跳过避免重复；
        // mid-stream system（如 skill 工具的 injectMessage）Responses input 不接受
        // system 角色，转为 user 项原位保留，保证指导内容可达模型（R3 修复）
        if (i === 0) continue
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) input.push({role: 'user', content: text})
        continue
      }
      if (msg.role === 'user') {
        input.push({ role: 'user', content: this.convertUserContentResponses(msg.content) })
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
 * dots 工具调用方言 → 真实工具映射。
 *
 * dots 模型会从 bash 工具描述中的命令示例（如 "查找文本: `Select-String`"）
 * 幻觉出不存在的"工具名"并写入 <invoke>。映射到语义等价的真实工具，
 * 避免调用被 availableToolNames 校验静默过滤。
 */
interface DotsToolAlias {
    /** 映射到的真实工具名 */
    name: string
    /** 参数转换；返回 null 表示无法转换（调用被跳过，宁可漏报不可误报） */
    convertParams: (params: Record<string, string>) => Record<string, string> | null
}

const DOTS_TOOL_ALIASES: Record<string, DotsToolAlias> = {
    // PowerShell 只读搜索命令 → grep 工具（只读、语义等价）
    'Select-String': {
        name: 'grep',
        // Select-String: { path: 文件或目录, pattern: 正则 } → grep: { pattern, directory, filePattern? }
        //   - path 为文件（含扩展名）→ directory=父目录 + filePattern=文件名（grep 按文件过滤）
        //   - path 为目录 → directory=path（grep 递归搜索）
        convertParams: ({path, pattern}): Record<string, string> | null => {
            if (!path || !pattern) return null
            // 按最后一个路径段是否含扩展名区分文件/目录
            const m = path.match(/^(.+)[\\/]([^\\/]+)$/)
            if (m) {
                const [, dir, base] = m
                if (base.includes('.')) return {pattern, directory: dir, filePattern: base}
                return {pattern, directory: path}
            }
            return {pattern, directory: '.'}
        },
    },
}

/**
 * 从 reasoning_content 或正文 content 中提取 dots 格式的工具调用。
 *
 * dots 模型格式（vLLM DotsToolParser 确认）：
 *   <invoke name=toolName><parameter name=key>value
 *   <parameter name=key2>value2
 *
 * 严谨判定策略：
 * 1. 必须匹配完整的 <invoke> 开闭合标签
 * 2. name 属性值必须匹配当前已注册的工具名（含别名映射）
 * 3. 参数以 JSON 字符串形式返回（供下游直接作为 arguments）
 *
 * strict 模式（仅用于正文 content 提取）：
 * reasoning_content 是思维过程，出现 invoke 即真实意图；正文是人类可读输出，
 * 模型可能在正文中"举例说明"工具用法（代码块/口语示例），直接提取会造成误执行。
 * 因此正文提取前先剥离代码块，并要求去除空白后正文必须完全由 invoke 块构成
 * （与 dots 实际行为一致：真实调用即 3 回车 + 纯 invoke 块，无任何解释文字）。
 * 宁可漏报（XML 显示但不执行），不可误报（执行用户没要求的命令）。
 *
 * @param text 完整的 reasoning_content 或正文 content 文本
 * @param availableToolNames 当前已注册的工具名集合
 * @param strict 严格模式（正文提取专用）：剥离代码块 + 纯调用校验
 * @returns 提取的工具调用列表
 */
function extractDotsToolCalls(
    text: string,
    availableToolNames: Set<string>,
    strict = false,
): Array<{ id: string; name: string; arguments: string }> {
    const results: Array<{ id: string; name: string; arguments: string }> = []

    // 匹配完整的 invoke 开闭合块
    const invokeRegex = /<invoke\s+name\s*=\s*["\x27]?([^">\s]+)["\x27]?\s*>([\s\S]*?)<\/invoke>/g
    let match: RegExpExecArray | null

    if (strict) {
        // 1. 剥离 ``` / ~~~ 包裹的代码块（示例通常放在代码块中）
        const cleanText = text
            .replace(/```[\s\S]*?```/g, '')
            .replace(/~~~[\s\S]*?~~~/g, '')
        // 2. 纯调用校验：剥离全部 invoke 块后，剩余内容（含空白）必须为空。
        //    注意不能先压缩空白再匹配（<invoke name> 会变成 <invokename> 导致匹配失败）。
        //    replace 会重置 lastIndex，可安全复用 invokeRegex。
        const remaining = cleanText.replace(invokeRegex, '').trim()
        if (remaining !== '') return []
        text = cleanText
    }

    while ((match = invokeRegex.exec(text)) !== null) {
        const rawName = match[1].trim()
        const body = match[2]

        // 条件1：工具名必须在已注册集合中（支持别名映射，如 Select-String → grep）
        const alias = DOTS_TOOL_ALIASES[rawName]
        const resolvedName = alias?.name ?? rawName
        if (!availableToolNames.has(resolvedName)) continue

        // 提取参数: <parameter name=K>V
        const params: Record<string, string> = {}
        const paramRegex = /<parameter\s+name\s*=\s*["\x27]?([^">\s]+)["\x27]?\s*>([\s\S]*?)<\/parameter>/g
        let paramMatch: RegExpExecArray | null
        while ((paramMatch = paramRegex.exec(body)) !== null) {
            params[paramMatch[1].trim()] = paramMatch[2].trim()
        }

        // 别名参数归一化：无法转换的调用直接跳过（宁可漏报，不可误报）
        const finalParams = alias ? alias.convertParams(params) : params
        if (finalParams === null) continue

        // 条件2：参数提取为 JSON 字符串（JSON.stringify 产物必然合法，无需再校验）
        const argsJson = JSON.stringify(finalParams)

        results.push({
            id: `dots-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: resolvedName,
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
