/**
 * Google Gemini API 适配器
 *
 * 使用 @google/generative-ai SDK，统一支持：
 * - API Key 认证 (x-goog-api-key)
 * - OAuth2 Bearer token 认证 (Authorization: Bearer)
 *
 * OAuth2 模式通过 monkey-patch fetch 实现：SDK 内部设置 x-goog-api-key，
 * 我们拦截并替换为 Authorization: Bearer。
 *
 * 参考：https://ai.google.dev/gemini-api/docs/oauth
 */

import {GoogleGenerativeAI} from '@google/generative-ai'
import {recordingFetch} from '../../utils/llmTraceRecorder'
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

export class GoogleAdapter implements ModelAdapter {
    /** API 协议形态：轨迹日志按 google 解析器归因 usage（与 llmUsageParser PARSERS 键对齐） */
    readonly apiStyle = 'google' as const
    private genAI: GoogleGenerativeAI
    private model: string
    private apiKey: string
    private isOAuth: boolean
    private refreshToken?: string
    private _tokenExpiryDate?: number
    private config!: ModelConfig & Record<string, any>
    /** AdapterConvertCache — 受限增量转换缓存 */
    private convertCache: GoogleConvertCache | null = null

    constructor(config: ModelConfig, injectedGenAI?: GoogleGenerativeAI) {
        this.apiKey = config.apiKey || ''
        this.model = config.model
        this.isOAuth = config.authType === 'google-oauth2'
        const extConfig = config as ModelConfig & {refreshToken?: string; tokenExpiryDate?: number}
        this.refreshToken = extConfig.refreshToken
        this._tokenExpiryDate = extConfig.tokenExpiryDate
        this.config = config as ModelConfig & Record<string, any>

        // 注入的客户端直接使用（测试模式）
        if (injectedGenAI) {
            this.genAI = injectedGenAI
            return
        }

        if (this.isOAuth) {
            // OAuth 模式：SDK 用 dummy key，实际认证在 fetch 层面注入
            this.genAI = new GoogleGenerativeAI('GOOGLE_OAUTH_DUMMY_KEY')
        } else {
            this.genAI = new GoogleGenerativeAI(this.apiKey)
        }
    }

    async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
        const {messages, systemPrompt, tools, maxTokens, thinkingEffort, abortSignal} = params

        const converted = convertMessagesIncremental(messages, this.convertCache)
        this.convertCache = converted.cache
        const {history, lastUserMsg} = converted
        if (!lastUserMsg) {
            yield {type: 'error', error: new Error('No user message to send')}
            return
        }

        // 注入的 system 消息已由 convertMessages 原位保留在 history 中（R4 修复），
        // systemInstruction 仅承载 core prompt，保证前缀缓存可命中
        const effectiveSystemPrompt = systemPrompt

        while (history.length > 0 && history[0].role !== 'user') {
            history.shift()
        }

        // ── OAuth 模式：SDK + monkey-patch fetch ──
        if (this.isOAuth) {
            await this.refreshTokenIfExpired()
            const oauthFetch = this.createOAuthFetch(this.apiKey)
            yield* this.chatOAuth(history, lastUserMsg, effectiveSystemPrompt, tools, maxTokens, thinkingEffort, abortSignal, oauthFetch)
            return
        }

        // ── API Key 模式：标准 SDK ──
        yield* this.chatSDK(history, lastUserMsg, effectiveSystemPrompt, tools, maxTokens, thinkingEffort, abortSignal)
    }

    /**
     * 创建 OAuth fetch：拦截 SDK 发起的请求，将 x-goog-api-key 替换为 Authorization: Bearer
     */
    private createOAuthFetch(_oauthToken: string): typeof fetch {
        const originalFetch = globalThis.fetch.bind(globalThis)
        // 具名箭头函数：保留栈追踪可读性（oauthFetch 帧），箭头函数维持词法 this 捕获
        const oauthFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const request = new Request(input instanceof URL ? input : input, init)
            // 仅拦截 Gemini API 请求
            if (!request.url.includes('generativelanguage.googleapis.com')) {
                return originalFetch(request)
            }
            // 刷新 token（可能已过期）
            await this.refreshTokenIfExpired()
            const headers = new Headers(request.headers)
            headers.delete('x-goog-api-key')
            headers.set('Authorization', `Bearer ${this.apiKey}`)
            const modifiedInit: RequestInit = {
                ...init,
                headers,
                signal: request.signal,
            }
            return originalFetch(new Request(request.url, modifiedInit))
        }
        return oauthFetch
    }

    /**
     * OAuth 模式：使用 SDK 流式调用（通过 monkey-patch fetch）
     */
    private async *chatOAuth(
        history: any[],
        lastUserMsg: any[],
        systemPrompt: string | undefined,
        tools: ToolDefinition[] | undefined,
        maxTokens: number | undefined,
        thinkingEffort: string | undefined,
        abortSignal: AbortSignal | undefined,
        oauthFetch: typeof fetch,
    ): AsyncGenerator<StreamChunk> {
        const thinkingConfig = this.buildThinkingDisabledConfig(thinkingEffort)
        const modelOptions: any = {
            model: this.model,
            generationConfig: {
                maxOutputTokens: maxTokens || 8192,
                ...(thinkingConfig ? {thinkingConfig} : {}),
            },
        }
        if (systemPrompt) {
            modelOptions.systemInstruction = systemPrompt
        }
        if (tools?.length) {
            modelOptions.tools = [{
                functionDeclarations: tools.map((t: ToolDefinition) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                })),
            }]
        }

        const model = (this.genAI as any).getGenerativeModel(modelOptions, {fetchFn: oauthFetch})
        const chat = model.startChat({history})

        let hasToolUse = false

        try {
            // 注入 abortSignal 到 chat 会话
            const streamResult = await (chat as any).sendMessageStream(lastUserMsg, {
                abortSignal,
            })

            for await (const chunk of streamResult.stream) {
                if (abortSignal?.aborted) break
                const parts = chunk.candidates?.[0]?.content?.parts || []
                for (const part of parts) {
                    if (part.text) {
                        yield {type: 'text', content: part.text}
                    }
                    if (part.functionCall) {
                        hasToolUse = true
                        yield {
                            type: 'tool_use',
                            id: `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                            name: part.functionCall.name,
                            input: (part.functionCall.args || {}) as Record<string, unknown>,
                        }
                    }
                }
            }

            const finishReason = streamResult.response?.candidates?.[0]?.finishReason
            if (finishReason === 'STOP') {
                yield* this.yieldUsageChunk((streamResult as any).usageMetadata)
                yield {type: 'done', stopReason: hasToolUse ? 'tool_use' : 'end_turn'}
            } else if (finishReason === 'MAX_TOKENS') {
                yield* this.yieldUsageChunk((streamResult as any).usageMetadata)
                yield {type: 'done', stopReason: 'max_tokens'}
            } else if (finishReason) {
                yield* this.yieldUsageChunk((streamResult as any).usageMetadata)
                yield {type: 'done', stopReason: 'end_turn'}
            } else {
                yield {type: 'done', stopReason: 'end_turn'}
            }
        } catch (err: any) {
            if (abortSignal?.aborted) return
            yield {type: 'error', error: err instanceof Error ? err : new Error(String(err))}
        }
    }

    /**
     * OAuth2 token 刷新：通过 TokenManager 统一管理
     *
     * TokenManager 已在 modelSchemeManager.createGoogleClient() 中注册并预刷新。
     * 此处仅兜底检查：如果 TokenManager 可用则用它获取最新 token，
     * 否则使用已有 token。
     */
    private async refreshTokenIfExpired(): Promise<void> {
        if (!this.isOAuth) return

        try {
            const {tokenManager: tm} = await import('../../channel/TokenManager' as string)
            const newToken = await (tm as any).getToken('google-oauth2')
            // 更新本实例的 token（可能已被刷新）
            if (newToken && newToken !== this.apiKey) {
                this.apiKey = newToken
            }
        } catch {
            // TokenManager 不可用或未注册，使用现有 token
        }
    }

    /**
     * 通过 @google/generative-ai SDK 调用（API Key 模式）
     */
    private async* chatSDK(
        history: any[],
        lastUserMsg: any[],
        systemPrompt?: string,
        tools?: ToolDefinition[],
        maxTokens?: number,
        thinkingEffort?: string,
        abortSignal?: AbortSignal
    ): AsyncGenerator<StreamChunk> {
        const thinkingConfig = this.buildThinkingDisabledConfig(thinkingEffort)
        const model = this.genAI.getGenerativeModel({
            model: this.model,
            ...(systemPrompt ? {systemInstruction: systemPrompt} : {}),
            generationConfig: {
                maxOutputTokens: maxTokens || 8192,
                ...(thinkingConfig ? {thinkingConfig} : {}),
            },
            ...(tools?.length ? {tools: this.convertTools(tools)} : {}),
        }, {fetchFn: recordingFetch} as any)

        try {
            const chat = model.startChat({history})
            const result = await chat.sendMessageStream(lastUserMsg)
            let hasToolUse = false

            for await (const chunk of result.stream) {
                if (abortSignal?.aborted) break

                const parts = chunk.candidates?.[0]?.content?.parts || []
                for (const part of parts) {
                    if (part.text) {
                        yield {type: 'text', content: part.text}
                    }
                    if (part.functionCall) {
                        hasToolUse = true
                        yield {
                            type: 'tool_use',
                            id: `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                            name: part.functionCall.name,
                            input: (part.functionCall.args || {}) as Record<string, unknown>,
                        }
                    }
                }

                const finishReason = chunk.candidates?.[0]?.finishReason
                if (finishReason === 'STOP') {
                    yield* this.yieldUsageChunk((chunk as any).usageMetadata)
                    yield {type: 'done', stopReason: hasToolUse ? 'tool_use' : 'end_turn'}
                } else if (finishReason === 'MAX_TOKENS') {
                    yield* this.yieldUsageChunk((chunk as any).usageMetadata)
                    yield {type: 'done', stopReason: 'max_tokens'}
                }
            }
        } catch (err: any) {
            if (abortSignal?.aborted) return
            yield {type: 'error', error: err instanceof Error ? err : new Error(String(err))}
        }
    }

  getModelInfo(): ModelInfo {
    const modelMeta: Record<string, number> = {
      'gemini-2.5-pro': 1048576,
      'gemini-2.5-flash': 1048576,
      'gemini-2.0-flash': 1048576,
      'gemini-1.5-pro': 2097152,
      'gemini-1.5-flash': 1048576,
    }
    return {
      provider: 'google',
      model: this.model,
      maxContextTokens: modelMeta[this.model] || 1048576,
      supportsTools: true,
      supportsThinking: false,
    }
  }

  /** 失效增量转换缓存（normalize 注入/取代后由调用方触发，下次全量重建） */
  invalidateConvertCache(): void {
    this.convertCache = null
  }

  /**
   * thinkingEffort === 'disabled'（显式禁用思考）时返回 thinkingConfig 关闭参数：
   * - Gemini 2.5/2.0/1.5 Flash 系：thinkingBudget: 0（可关闭）
   * - Gemini 3 Flash：thinkingLevel: 'MINIMAL'（3 系最低档）
   * - Pro 系（2.5 Pro min 128 / Gemini 3 Pro）：无法关闭，返回 undefined（不发参数）
   * 非 disabled 返回 undefined（Google 默认开启思考，本 adapter 未实现档位控制）。
   */
  private buildThinkingDisabledConfig(thinkingEffort: string | undefined): any | undefined {
    if (thinkingEffort !== 'disabled') return undefined
    const m = this.model.toLowerCase()
    if (m.includes('gemini-3-flash')) return {thinkingLevel: 'MINIMAL'}
    if (m.includes('gemini-3')) {
      // Gemini 3 Pro 最低仅 LOW，不可关闭：跳过参数，交由显示层抑制
      return undefined
    }
    if (m.includes('flash')) return {thinkingBudget: 0}
    // 2.5 Pro 等其余模型：不可关闭
    return undefined
  }

  private convertTools(tools: ToolDefinition[]): any {
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      },
    ]
  }

    private* yieldUsageChunk(usageMetadata: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number
    } | undefined): Generator<StreamChunk> {
        if (usageMetadata) {
            // ★ 核心修正：Gemini 的 promptTokenCount 是总输入（已包含 cachedContentTokenCount），
            // 与 Anthropic 的 input_tokens 语义（不含缓存）不同。减去缓存部分避免 UI 层
            // 按「input + cacheRead」计算时双算缓存 token。
            const cached = usageMetadata.cachedContentTokenCount || 0
            yield {
                type: 'usage',
                inputTokens: Math.max(0, (usageMetadata.promptTokenCount || 0) - cached),
                outputTokens: usageMetadata.candidatesTokenCount || 0,
                cacheReadTokens: usageMetadata.cachedContentTokenCount || undefined,
            }
        }
    }
}

// ─── 内部方法 ──────────────────────────────────────

/** 转换结果：history + 最后一条 user 消息 */
export interface ConvertedMessages {
    history: any[]
    lastUserMsg: any[] | null
}

/** 将可能为 string 的消息内容规范化为字符串（非字符串内容视为空） */
function textOf(content: unknown): string {
    return typeof content === 'string' ? content : ''
}

/**
 * 将注入的 system 消息文本（如 skill 工具的 injectMessage）原位追加到 history：
 * 若上一条是 user 条目则合并 parts，否则新建 user 条目。
 */
function pushInjectedUserParts(history: any[], text: string): void {
    const last = history[history.length - 1]
    if (last && last.role === 'user') {
        last.parts.push({text})
    } else {
        history.push({role: 'user', parts: [{text}]})
    }
}

/**
 * 将内部 ChatMessage[] 转换为 Gemini history + lastUserMsg。
 * 注入的 system 消息不再拼入 systemInstruction，而是原位保留在 history 中
 * （user 角色 text part），与 OpenAI Chat 路径行为对齐，保证前缀缓存可命中。
 */
export function convertMessages(messages: readonly ChatMessage[]): ConvertedMessages {
    const history: any[] = []
    let lastUserMsg: any[] | null = null

    // 分离最后一条用户消息（Gemini 要求 sendMessage 传入最新的用户消息）
    const msgs = [...messages]
    let lastUserIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx >= 0) {
        lastUserMsg = convertUserContent(msgs[lastUserIdx].content)
        msgs.splice(lastUserIdx, 1)
    }

    for (const msg of msgs) {
        if (msg.role === 'system') {
            const text = textOf(msg.content)
            if (text) pushInjectedUserParts(history, text)
            continue
        }

        if (msg.role === 'user') {
            const parts = convertUserContent(msg.content)
            history.push({role: 'user', parts})
        } else if (msg.role === 'assistant') {
            const parts: any[] = []
            if (msg.content) {
                const textParts = convertUserContent(msg.content)
                parts.push(...textParts)
            }
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    parts.push({
                        functionCall: { name: tc.name, args: tc.arguments },
                    })
                }
            }
            history.push({ role: 'model', parts })
        } else if (msg.role === 'context') {
            // context 角色注入的消息：转为 user 角色，让 LLM 能看到
            const text = textOf(msg.content)
            if (text) {
                history.push({role: 'user', parts: [{text}]})
            }
        } else if (msg.role === 'tool') {
            // functionResponse.name 必须是函数名，用于和 functionCall.name 匹配
            history.push({
                role: 'function',
                parts: [
                    {
                        functionResponse: {
                            name: msg.functionName || '',
                            response: { result: msg.toolResult || '' },
                        },
                    },
                ],
            })
        }
    }

    return { history, lastUserMsg }
}

export interface GoogleConvertCache {
    inputCount: number
    history: any[]
    lastUserMsg: any[] | null
}

/**
 * 受限增量版 convertMessages。
 *
 * 仅当新增段不含 user 消息时走增量（追加 history）；新增段含 user 时
 * 强制全量（lastUserMsg 分离逻辑依赖最后一条 user 的位置，无法增量）。
 */
export function convertMessagesIncremental(
    messages: readonly ChatMessage[],
    cache: GoogleConvertCache | null,
): { history: any[]; lastUserMsg: any[] | null; cache: GoogleConvertCache } {
    // 命中：消息数相同 → 返回缓存
    if (cache && cache.inputCount === messages.length) {
        return {history: cache.history, lastUserMsg: cache.lastUserMsg, cache}
    }

    // 缓存无效 / 消息减少 / 新增段含 user → 全量
    const newSection = cache ? messages.slice(cache.inputCount) : messages
    const hasNewUser = newSection.some(m => m.role === 'user')
    if (!cache || cache.inputCount > messages.length || hasNewUser) {
        const full = convertMessages(messages)
        return {
            history: full.history,
            lastUserMsg: full.lastUserMsg,
            cache: {inputCount: messages.length, history: full.history, lastUserMsg: full.lastUserMsg},
        }
    }

    // 增量：追加新增段到 history（新增段只含 assistant/tool/context/system）
    const history = [...cache.history]
    for (const msg of newSection) {
        if (msg.role === 'system') {
            const text = textOf(msg.content)
            if (text) pushInjectedUserParts(history, text)
            continue
        }

        if (msg.role === 'assistant') {
            const parts: any[] = []
            if (msg.content) {
                const textParts = convertUserContent(msg.content)
                parts.push(...textParts)
            }
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    parts.push({
                        functionCall: { name: tc.name, args: tc.arguments },
                    })
                }
            }
            history.push({ role: 'model', parts })
        } else if (msg.role === 'context') {
            // context 角色注入的消息：转为 user 角色，让 LLM 能看到
            const text = textOf(msg.content)
            if (text) {
                history.push({role: 'user', parts: [{text}]})
            }
        } else if (msg.role === 'tool') {
            // functionResponse.name 必须是函数名，用于和 functionCall.name 匹配
            history.push({
                role: 'function',
                parts: [
                    {
                        functionResponse: {
                            name: msg.functionName || '',
                            response: { result: msg.toolResult || '' },
                        },
                    },
                ],
            })
        }
    }
    return {
        history,
        lastUserMsg: cache.lastUserMsg,
        cache: {inputCount: messages.length, history, lastUserMsg: cache.lastUserMsg},
    }
}

/** 将内部 user 消息内容（文本或多模态块）转换为 Gemini parts */
function convertUserContent(content: string | ContentPart[]): any[] {
    if (typeof content === 'string') {
        return [{text: content}]
    }

    const parts: any[] = []
    for (const part of content) {
        if (part.type === 'text') {
            parts.push({text: part.text})
        } else if (part.type === 'image_url') {
            const url = part.image_url.url
            if (url.startsWith('data:')) {
                const mimeType = extractMediaType(url)
                const base64Data = extractBase64Data(url)
                parts.push({
                    inlineData: {mimeType, data: base64Data},
                })
            } else if (url.startsWith('http://') || url.startsWith('https://')) {
                parts.push({
                    fileData: {mimeType: 'image/jpeg', fileUri: url},
                })
            }
        } else if (part.type === 'input_audio') {
            // Gemini 使用 inlineData 接收音频，mimeType 由 format 字段映射
            const mimeType = audioFormatToMimeType(part.input_audio.format)
            parts.push({
                inlineData: {mimeType, data: part.input_audio.data},
            })
        }
    }

    return parts.length > 0 ? parts : [{text: ''}]
}

function extractMediaType(dataUrl: string): string {
    const match = dataUrl.match(/data:([^;]+);base64/)
    return match ? match[1] : 'image/jpeg'
}

function extractBase64Data(dataUrl: string): string {
    const match = dataUrl.match(/data:[^;]+;base64,(.+)/)
    return match ? match[1] : dataUrl
}

function audioFormatToMimeType(format: string): string {
    const mimeMap: Record<string, string> = {
        wav: 'audio/wav',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        flac: 'audio/flac',
        ogg: 'audio/ogg',
        webm: 'audio/webm',
        aac: 'audio/aac',
        pcm: 'audio/L16;rate=16000;channels=1',
    }
    return mimeMap[format.toLowerCase()] || 'audio/wav'
}

