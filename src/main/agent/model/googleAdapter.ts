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
    private genAI: GoogleGenerativeAI
    private model: string
    private apiKey: string
    private isOAuth: boolean
    private refreshToken?: string
    private _tokenExpiryDate?: number
    private config!: ModelConfig & Record<string, any>

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
        const {messages, systemPrompt, tools, maxTokens, abortSignal, additionalContext} = params

        const {history, lastUserMsg} = this.convertMessages(messages)
        if (!lastUserMsg) {
            yield {type: 'error', error: new Error('No user message to send')}
            return
        }

        if (additionalContext && lastUserMsg) {
            lastUserMsg.push({text: `\n\n📎 背景信息:\n${additionalContext}`})
        }

        while (history.length > 0 && history[0].role !== 'user') {
            history.shift()
        }

        // ── OAuth 模式：SDK + monkey-patch fetch ──
        if (this.isOAuth) {
            await this.refreshTokenIfExpired()
            const oauthFetch = this.createOAuthFetch(this.apiKey)
            yield* this.chatOAuth(history, lastUserMsg, systemPrompt, tools, maxTokens, abortSignal, oauthFetch)
            return
        }

        // ── API Key 模式：标准 SDK ──
        yield* this.chatSDK(history, lastUserMsg, systemPrompt, tools, maxTokens, abortSignal)
    }

    /**
     * 创建 OAuth fetch：拦截 SDK 发起的请求，将 x-goog-api-key 替换为 Authorization: Bearer
     */
    private createOAuthFetch(oauthToken: string): typeof fetch {
        const originalFetch = globalThis.fetch.bind(globalThis)
        const self = this
        return async function oauthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const request = new Request(input instanceof URL ? input : input, init)
            // 仅拦截 Gemini API 请求
            if (!request.url.includes('generativelanguage.googleapis.com')) {
                return originalFetch(request)
            }
            // 刷新 token（可能已过期）
            await self.refreshTokenIfExpired()
            const headers = new Headers(request.headers)
            headers.delete('x-goog-api-key')
            headers.set('Authorization', `Bearer ${self.apiKey}`)
            const modifiedInit: RequestInit = {
                ...init,
                headers,
                signal: request.signal,
            }
            return originalFetch(new Request(request.url, modifiedInit))
        }
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
        abortSignal: AbortSignal | undefined,
        oauthFetch: typeof fetch,
    ): AsyncGenerator<StreamChunk> {
        const modelOptions: any = {
            model: this.model,
            generationConfig: {maxOutputTokens: maxTokens || 8192},
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
        abortSignal?: AbortSignal
    ): AsyncGenerator<StreamChunk> {
        const model = this.genAI.getGenerativeModel({
            model: this.model,
            ...(systemPrompt ? {systemInstruction: systemPrompt} : {}),
            generationConfig: {
                maxOutputTokens: maxTokens || 8192,
            },
            ...(tools?.length ? {tools: this.convertTools(tools)} : {}),
        })

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

  // ─── 内部方法 ──────────────────────────────────────

  private convertMessages(messages: readonly ChatMessage[]): {
    history: any[]
      lastUserMsg: any[] | null
  } {
    const history: any[] = []
      let lastUserMsg: any[] | null = null

    // 分离最后一条用户消息（Gemini 要求 sendMessage 传入最新的用户消息）
    const msgs = [...messages]
    let lastUserIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx >= 0) {
        lastUserMsg = this.convertUserContent(msgs[lastUserIdx].content)
      msgs.splice(lastUserIdx, 1)
    }

    for (const msg of msgs) {
      if (msg.role === 'system') continue

      if (msg.role === 'user') {
          const parts = this.convertUserContent(msg.content)
          history.push({role: 'user', parts})
      } else if (msg.role === 'assistant') {
        const parts: any[] = []
          if (msg.content) {
              const textParts = this.convertUserContent(typeof msg.content === 'string' ? msg.content : msg.content as ContentPart[])
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
        // Hook additionalContext 注入的消息：转为 user 角色，让 LLM 能看到
        const text = typeof msg.content === 'string' ? msg.content : ''
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

    /**
     * 转换用户消息内容为 Gemini 格式
     */
    private convertUserContent(content: string | ContentPart[]): any[] {
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
                    const mimeType = this.extractMediaType(url)
                    const base64Data = this.extractBase64Data(url)
                    parts.push({
                        inlineData: {mimeType, data: base64Data},
                    })
                } else if (url.startsWith('http://') || url.startsWith('https://')) {
                    parts.push({
                        inlineData: {mimeType: 'image/jpeg', data: url},
                    })
                }
            } else if (part.type === 'input_audio') {
                // Gemini 使用 inlineData 接收音频，mimeType 由 format 字段映射
                const mimeType = this.audioFormatToMimeType(part.input_audio.format)
                parts.push({
                    inlineData: {mimeType, data: part.input_audio.data},
                })
            }
        }

        return parts.length > 0 ? parts : [{text: ''}]
    }

    private extractMediaType(dataUrl: string): string {
        const match = dataUrl.match(/data:([^;]+);base64/)
        return match ? match[1] : 'image/jpeg'
    }

    private extractBase64Data(dataUrl: string): string {
        const match = dataUrl.match(/data:[^;]+;base64,(.+)/)
        return match ? match[1] : dataUrl
    }

    private audioFormatToMimeType(format: string): string {
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
            yield {
                type: 'usage',
                inputTokens: usageMetadata.promptTokenCount || 0,
                outputTokens: usageMetadata.candidatesTokenCount || 0,
                cacheReadTokens: usageMetadata.cachedContentTokenCount || undefined,
            }
        }
    }
}
