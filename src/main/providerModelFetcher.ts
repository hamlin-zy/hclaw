// src/main/providerModelFetcher.ts
// 纯 TS 模块（零 electron 依赖）：拉取/测试逻辑通过依赖注入接入外部服务，便于单测。
import type {AuthType, ModelType, ProviderType, ProviderFeatures} from '@shared/types'
import type {ModelAdapter, ModelConfig} from './agent/model/types'
import {
  buildAnthropicFallbackRequest,
  buildModelsRequest,
  classifyFetchError,
  inferModelType,
  parseModelsResponse,
  type FetchErrorCode,
} from '@shared/modelPresets'
import {withLlmTraceStream, type LlmTraceCallContext} from './utils/llmTraceRecorder'

const FETCH_TIMEOUT_MS = 15000

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiryDate: number
}

export interface FetchModelsParams {
  type: ProviderType
  baseUrl?: string
  apiKey?: string
  authType?: AuthType
  accessToken?: string
  refreshToken?: string
  expiryDate?: number
}

export type FetchModelsResult =
  | {success: true; data: {id: string; modelType?: ModelType}[]; oauthTokens?: OAuthTokens}
  | {success: false; error: string; code: FetchErrorCode}

export interface RefreshTokenDeps {
  refreshGoogleToken?: (refreshToken: string) => Promise<{accessToken: string; expiryDate: number}>
}

export const FETCH_ERROR_MESSAGES: Record<FetchErrorCode, string> = {
  auth: 'API Key 无效或无权限',
  unsupported: '该服务商不支持自动获取，请手动添加模型',
  network: '无法连接，请检查 Base URL 与网络',
  server: '服务商服务异常（5xx），请稍后重试或手动添加',
  parse: '接口格式不标准，请手动添加模型',
  empty: '未获取到任何模型',
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** 模型 ID 列表 → 带类型推断的结果条目 */
function toModelEntries(models: string[]): {id: string; modelType: ModelType}[] {
  return models.map(id => ({id, modelType: inferModelType(id)}))
}

/** 解析失败/空列表 → 统一失败结果 */
function parseError(models: string[] | null): {success: false; error: string; code: FetchErrorCode} {
  return models === null
    ? {success: false, error: FETCH_ERROR_MESSAGES.parse, code: 'parse'}
    : {success: false, error: FETCH_ERROR_MESSAGES.empty, code: 'empty'}
}

/**
 * google oauth2：accessToken 过期则刷新。返回 {accessToken, oauthTokens}：
 * - accessToken：刷新后的新 token（或原 token）
 * - oauthTokens：仅当发生过刷新时非空（供调用方回传弹窗更新）
 */
async function refreshOAuthIfNeeded(
  params: Pick<FetchModelsParams, 'type' | 'authType' | 'accessToken' | 'refreshToken' | 'expiryDate'>,
  deps: RefreshTokenDeps,
): Promise<{ok: true; accessToken: string; oauthTokens?: OAuthTokens} | {ok: false; error: string}> {
  if (params.type !== 'google' || params.authType !== 'google-oauth2') {
    return {ok: true, accessToken: params.accessToken || ''}
  }
  const expired = !params.expiryDate || Date.now() > params.expiryDate
  if (!expired || !params.refreshToken || !deps.refreshGoogleToken) {
    return {ok: true, accessToken: params.accessToken || ''}
  }
  try {
    const refreshed = await deps.refreshGoogleToken(params.refreshToken)
    return {
      ok: true,
      accessToken: refreshed.accessToken,
      oauthTokens: {accessToken: refreshed.accessToken, refreshToken: params.refreshToken, expiryDate: refreshed.expiryDate},
    }
  } catch (e: any) {
    return {ok: false, error: `Google Token 刷新失败：${e?.message || e}`}
  }
}

export async function fetchProviderModels(
  params: FetchModelsParams,
  deps: RefreshTokenDeps = {},
): Promise<FetchModelsResult> {
  // 参数快照 + trim（请求发出后用户修改表单不影响本次请求）
  const type = params.type
  let apiKey = (params.apiKey || '').trim()
  const baseUrl = (params.baseUrl || '').trim()
  const authType = params.authType || 'api-key'

  // google oauth2：accessToken 过期先刷新（刷新结果通过 oauthTokens 回传弹窗更新）
  const oauth = await refreshOAuthIfNeeded(params, deps)
  if (!oauth.ok) return {success: false, error: oauth.error, code: 'auth'}
  const accessToken = oauth.accessToken
  const oauthTokens = oauth.oauthTokens

  const doFetch = async (url: string, headers: Record<string, string>): Promise<{status: number; body: string}> => {
    try {
      const res = await fetch(url, {headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)})
      return {status: res.status, body: await safeText(res)}
    } catch {
      return {status: 0, body: ''} // 0 = 网络层失败
    }
  }

  const spec = buildModelsRequest({type, baseUrl, authType, apiKey, accessToken})
  let {status, body} = await doFetch(spec.url, spec.headers)
  if (status === 0) return {success: false, error: FETCH_ERROR_MESSAGES.network, code: 'network'}

  let errCode = classifyFetchError(status, body, type)
  // anthropic 404 → 去掉 /anthropic 后缀走 OpenAI 兼容（切换 Bearer）；ollama 404 → 回退 /models
  if (errCode === 'unsupported' && status === 404) {
    const fallback = type === 'anthropic'
      ? buildAnthropicFallbackRequest(baseUrl, apiKey)
      : type === 'ollama'
        ? {url: `${baseUrl.replace(/\/+$/, '')}/models`, headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : {}}
        : null
    if (fallback) {
      const retry = await doFetch(fallback.url, fallback.headers)
      if (retry.status === 0) return {success: false, error: FETCH_ERROR_MESSAGES.network, code: 'network'}
      errCode = classifyFetchError(retry.status, retry.body, 'openai')
      if (!errCode) {
        const models = parseModelsResponse('openai', retry.body)
        if (models && models.length > 0) {
          return {success: true, data: toModelEntries(models), oauthTokens}
        }
        return parseError(models)
      }
      return {success: false, error: FETCH_ERROR_MESSAGES[errCode], code: errCode}
    }
  }

  if (errCode) return {success: false, error: FETCH_ERROR_MESSAGES[errCode], code: errCode}

  const models = parseModelsResponse(type, body)
  if (models === null) return {success: false, error: FETCH_ERROR_MESSAGES.parse, code: 'parse'}
  if (models.length === 0) return {success: false, error: FETCH_ERROR_MESSAGES.empty, code: 'empty'}
  return {success: true, data: toModelEntries(models), oauthTokens}
}

export interface ModelTestParams {
  type: ProviderType
  baseUrl?: string
  apiKey?: string
  authType?: AuthType
  accessToken?: string
  refreshToken?: string
  expiryDate?: number
  model: string
  features?: ProviderFeatures
}

export type ModelTestResult =
  | {success: true; latencyMs: number; oauthTokens?: OAuthTokens}
  | {success: false; error: string}

export interface FetcherDeps extends RefreshTokenDeps {
  createAdapter?: (config: ModelConfig) => ModelAdapter
}

export function classifyTestError(e: any): string {
  const status = e?.status
  const message = String(e?.message || e || '').slice(0, 200)
  if (status === 401 || status === 403) return '认证失败：API Key 无效或无权限'
  if (status === 404) return '模型不存在或无访问权限（检查模型 ID 拼写）'
  if (e?.name === 'AbortError' || /abort|timeout/i.test(message)) return '连接超时：请检查 Base URL 与网络'
  if (status >= 500) return '服务商服务异常（5xx），请稍后重试'
  return message || '未知错误'
}

export async function testProviderModel(params: ModelTestParams, deps: FetcherDeps = {}): Promise<ModelTestResult> {
  const type = params.type
  const apiKey = (params.apiKey || '').trim()
  const baseUrl = (params.baseUrl || '').trim()
  const model = params.model.trim()
  const authType = params.authType || 'api-key'

  // google oauth2：过期先刷新（刷新结果通过 oauthTokens 回传弹窗更新）
  const oauth = await refreshOAuthIfNeeded(params, deps)
  if (!oauth.ok) return {success: false, error: oauth.error}
  const accessToken = oauth.accessToken
  const oauthTokens = oauth.oauthTokens

  // 前置校验
  if (!model) return {success: false, error: '模型名称不能为空'}
  if (type === 'custom') return {success: false, error: '该类型暂不支持连通性测试，请使用 OpenAI 兼容类型'}
  if (type !== 'ollama') {
    if (authType === 'google-oauth2') {
      if (!accessToken) return {success: false, error: 'Google 未授权，请先完成登录'}
    } else if (!apiKey) {
      return {success: false, error: '请先填写 API Key'}
    }
  }
  if (!deps.createAdapter) return {success: false, error: '适配器工厂未注入'}

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const adapter = deps.createAdapter({
      provider: type,
      model,
      apiKey: authType === 'google-oauth2' ? accessToken : apiKey,
      authType,
      baseUrl: baseUrl || undefined,
      features: params.features,
    })
    // 最小验证请求：消费完整流至 done / error，不写任何数据
    // ── LLM 出口：服务商连通性测试（设置页手动触发，无关联会话）──
    const traceCtx: LlmTraceCallContext = {
      conversationId: 'unknown', turn: 0, step: 0, attempt: 0,
      provider: type, model,
      apiStyle: adapter.apiStyle ?? 'chat',
      context: 'unknown',
    }
        for await (const chunk of withLlmTraceStream(traceCtx, adapter.chat({
      messages: [{role: 'user', content: 'ping'}],
      maxTokens: 8,
      abortSignal: controller.signal,
    }))) {
      if (chunk.type === 'error') throw chunk.error
      if (chunk.type === 'done') {
        return {success: true, latencyMs: Date.now() - start, oauthTokens}
      }
    }
    // 真实适配器在 15s 超时（abort 触发）时不会 yield done，而是静默结束流；
    // 此时若 controller 已 abort，应报告连接超时而非「流提前结束」，避免误导 UI。
    if (controller.signal.aborted) {
      return {success: false, error: '连接超时：请检查 Base URL 与网络'}
    }
    return {success: false, error: '流提前结束，未收到完成信号'}
  } catch (e: any) {
    return {success: false, error: classifyTestError(e)}
  } finally {
    clearTimeout(timer)
  }
}
