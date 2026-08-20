import type {AuthType, ModelType, ProviderType} from './types'

export interface ProviderPreset {
  /** 匹配的域名关键词（host 解析后小写，子串包含即命中；不含端口与路径） */
  hostIncludes: string[]
  name: string
  type: ProviderType
  baseUrl?: string
  expectedFormat?: string
  presetModels?: string[]
  /** 是否支持显式提示词缓存（Anthropic 兼容的 cache_control: { type: "ephemeral" }）。
   * 为 true 时，OpenAI 适配器会在 system 消息上添加 cache_control，由网关/服务商翻译或原生支持。
   * 适用：OpenRouter（网关翻译）、阿里百炼/通义千问（原生支持）、Google Gemini（原生支持，仅最后一个断点生效）。
   * 不适用：OpenAI 直连（用 prompt_cache_breakpoint）、智谱/DeepSeek/Moonshot/Groq/xAI（全自动隐式缓存）。
   * 默认 false，避免向不支持的服务商发送未知字段。 */
  supportsExplicitCaching?: boolean
}

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

const TYPE_DEFAULT_MODELS: Partial<Record<ProviderType, string[]>> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250514'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  ollama: [],
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {hostIncludes: ['openai.com'], name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', presetModels: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'], supportsExplicitCaching: false},
  {hostIncludes: ['anthropic.com', 'claude.com'], name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', presetModels: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250514'], supportsExplicitCaching: true},
  {hostIncludes: ['googleapis.com'], name: 'Google', type: 'google', baseUrl: GOOGLE_BASE_URL, presetModels: ['gemini-2.5-pro', 'gemini-2.5-flash'], supportsExplicitCaching: true},
  {hostIncludes: ['localhost'], name: 'Ollama', type: 'ollama', baseUrl: 'http://localhost:11434', supportsExplicitCaching: false},
  {hostIncludes: ['deepseek.com'], name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', expectedFormat: 'https://api.deepseek.com/v1', presetModels: ['deepseek-v4-pro', 'deepseek-v4-flash'], supportsExplicitCaching: false},
  {hostIncludes: ['moonshot.cn', 'kimi.com'], name: 'Moonshot/Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', presetModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'], supportsExplicitCaching: false},
  {hostIncludes: ['bigmodel.cn'], name: '智谱', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', presetModels: ['glm-5.2', 'glm-5-turbo'], supportsExplicitCaching: false},
  {hostIncludes: ['dashscope.aliyuncs.com'], name: '通义/百炼', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supportsExplicitCaching: true},
  {hostIncludes: ['maas.aliyuncs.com'], name: '阿里百炼', type: 'openai', expectedFormat: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', supportsExplicitCaching: true},
  {hostIncludes: ['openrouter.ai'], name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', supportsExplicitCaching: true},
  {hostIncludes: ['groq.com'], name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', presetModels: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'], supportsExplicitCaching: false},
  {hostIncludes: ['siliconflow.cn'], name: '硅基流动', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', presetModels: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'], supportsExplicitCaching: false},
  {hostIncludes: ['mistral.ai'], name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', presetModels: ['mistral-medium-3.5', 'mistral-small-4'], supportsExplicitCaching: false},
  {hostIncludes: ['x.ai'], name: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', presetModels: ['grok-4.6'], supportsExplicitCaching: false},
  {hostIncludes: ['volces.com', 'volcengine.com'], name: '火山引擎', type: 'openai', supportsExplicitCaching: false},
  {hostIncludes: ['minimaxi.com'], name: 'MiniMax', type: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic', presetModels: ['MiniMax-M3', 'MiniMax-M2.7'], supportsExplicitCaching: true},
  {hostIncludes: ['z.ai'], name: '智谱国际', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', presetModels: ['glm-5.2', 'glm-5-turbo'], supportsExplicitCaching: false},
]

export function recognizeProvider(baseUrl: string): ProviderPreset | null {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return null
  let host: string
  try {
    host = new URL(trimmed).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!host) return null
  return PROVIDER_PRESETS.find(p => p.hostIncludes.some(h => host.includes(h))) ?? null
}

export function presetModelsFor(preset: ProviderPreset | null, type: ProviderType): string[] {
  if (preset?.presetModels?.length) return [...preset.presetModels]
  return TYPE_DEFAULT_MODELS[type] ? [...TYPE_DEFAULT_MODELS[type]] : []
}

const MODEL_TYPE_PATTERNS: Array<[RegExp, ModelType]> = [
  [/(sora|kling|runway|veo|pika|qwen.*video|hailuo|minimax.*video)/i, 'video'],
  [/(gpt-image|dall-e|midjourney|flux|stable-diffusion|imagen|qwen.*image|sd3|ideogram|firefly)/i, 'image'],
  [/(suno|\budio\b|music)/i, 'music'],
  [/(tts|voice|speech|whisper|qwen-audio|audio)/i, 'voice'],
  [/(embedding|rerank)/i, 'embedding'],
]

export function inferModelType(id: string): ModelType {
  for (const [re, type] of MODEL_TYPE_PATTERNS) {
    if (re.test(id)) return type
  }
  return 'text'
}

export interface ModelsRequestSpec {
  url: string
  headers: Record<string, string>
}

export function buildModelsRequest(params: {
  type: ProviderType
  baseUrl?: string
  authType?: AuthType
  apiKey?: string
  accessToken?: string
}): ModelsRequestSpec {
  const {type, baseUrl = '', authType, apiKey = '', accessToken = ''} = params
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (type === 'google') {
    const url = `${GOOGLE_BASE_URL}/models`
    const headers: Record<string, string> = authType === 'google-oauth2'
      ? {Authorization: `Bearer ${accessToken}`}
      : {'x-goog-api-key': apiKey}
    return {url, headers}
  }
  if (type === 'anthropic') {
    const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`
    return {
      url,
      headers: {'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    }
  }
  if (type === 'ollama') {
    return {url: `${base}/api/tags`, headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : {}}
  }
  // openai / custom：原样追加 /models（尊重用户填写的版本路径，如 volces 的 /v3）
  return {url: `${base}/models`, headers: {Authorization: `Bearer ${apiKey}`}}
}

export function buildAnthropicFallbackRequest(baseUrl: string, apiKey: string): ModelsRequestSpec | null {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const stripped = base.replace(/\/anthropic$/i, '')
  if (stripped === base) return null
  return {url: `${stripped}/models`, headers: {Authorization: `Bearer ${apiKey}`}}
}

export function parseModelsResponse(type: ProviderType, text: string): string[] | null {
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  if (Array.isArray(json)) {
    return json.map((m: any) => String(m?.id ?? m?.name ?? '')).filter(Boolean)
  }
  if (type === 'google') {
    if (!Array.isArray(json.models)) return null
    return json.models.map((m: any) => String(m.name || '').replace(/^models\//, '')).filter(Boolean)
  }
  if (type === 'ollama') {
    if (Array.isArray(json.models) && typeof json.models[0]?.name === 'string') {
      return json.models.map((m: any) => String(m.name)).filter(Boolean)
    }
  }
  if (Array.isArray(json.data)) {
    return json.data.map((m: any) => String(m.id ?? '')).filter(Boolean)
  }
  if (Array.isArray(json.models)) {
    return json.models.map((m: any) => String(m.id ?? m.name ?? '')).filter(Boolean)
  }
  return null
}

export type FetchErrorCode = 'auth' | 'unsupported' | 'network' | 'server' | 'parse' | 'empty'

export function classifyFetchError(status: number, body: string, type: ProviderType): FetchErrorCode | null {
  if (status >= 500) return 'server'
  if (status === 401 || status === 403) return 'auth'
  if (status === 400) {
    if (type === 'google' && /api key not valid/i.test(body)) return 'auth'
    return 'parse'
  }
  if (status === 404) return 'unsupported'
  return null
}

export interface BaseUrlValidation {
  level: 'ok' | 'warn' | 'error'
  message?: string
}

const OFFICIAL_URLS = new Set([
  'https://api.anthropic.com',
  'https://api.openai.com/v1',
  GOOGLE_BASE_URL,
])

export function validateBaseUrl(type: ProviderType, baseUrl: string): BaseUrlValidation {
  const trimmed = baseUrl.trim()
  if (!trimmed) return {level: 'ok'}
  // 无法解析的 URL 无法校验 → 不告警
  try {
    new URL(trimmed)
  } catch {
    return {level: 'ok'}
  }
  const base = trimmed.replace(/\/+$/, '')
  if (OFFICIAL_URLS.has(base)) return {level: 'ok'}
  if (type === 'anthropic') {
    if (/\/v1$/.test(base)) {
      return {level: 'error', message: 'anthropic 类型不应以 /v1 结尾：SDK 会自动拼接 /v1/messages，否则请求会变成 /v1/v1/messages'}
    }
    return {level: 'ok'}
  }
  if (type === 'openai' || type === 'custom') {
    if (!/\/v1$/.test(base)) {
      return {level: 'warn', message: 'OpenAI 协议格式应为 …/v1 结尾，例如 https://api.deepseek.com/v1'}
    }
    return {level: 'ok'}
  }
  return {level: 'ok'}
}
