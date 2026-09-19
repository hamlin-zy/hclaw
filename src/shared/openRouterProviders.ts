/**
 * OpenRouter 模型可用服务商列表解析（纯函数，无 IO）
 *
 * 数据来源：GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints（公开接口，无需 apiKey）
 * 返回结构：{ data: { id, endpoints: [{ tag, provider_name, supports_implicit_caching, ... }] } }
 *
 * 注意：实测 `provider_slug` 为 null，服务商 slug 必须取 endpoint.tag（如 "azure" / "deepinfra/turbo"）。
 */

/** 单个服务商选项（渲染端下拉/徽标展示用） */
export interface OpenRouterProviderOption {
  /** 服务商 slug，来自 endpoint.tag，如 "azure" / "deepinfra/turbo" */
  slug: string
  /** 服务商显示名，来自 endpoint.provider_name（缺失则回退 tag） */
  name: string
  supportsImplicitCaching: boolean
  contextLength?: number
  uptimeLast30m?: number
}

/**
 * 解析 /endpoints 响应（已 JSON.parse 的对象）。
 * 畸形 / 缺 endpoints / 空数组 → []；单条缺 tag → 跳过；同 slug 去重（保留首条）。
 */
export function parseModelEndpoints(raw: unknown): OpenRouterProviderOption[] {
  if (!raw || typeof raw !== 'object') return []
  const data = (raw as {data?: unknown}).data
  if (!data || typeof data !== 'object') return []
  const endpoints = (data as {endpoints?: unknown}).endpoints
  if (!Array.isArray(endpoints)) return []

  const out: OpenRouterProviderOption[] = []
  const seen = new Set<string>()
  for (const ep of endpoints) {
    if (!ep || typeof ep !== 'object') continue
    const e = ep as Record<string, unknown>
    const slug = typeof e.tag === 'string' ? e.tag.trim() : ''
    if (!slug || seen.has(slug)) continue
    seen.add(slug)

    const name = typeof e.provider_name === 'string' && e.provider_name.trim()
      ? e.provider_name.trim()
      : slug

    const option: OpenRouterProviderOption = {
      slug,
      name,
      supportsImplicitCaching: e.supports_implicit_caching === true,
    }
    const contextLength = toOptionalNumber(e.context_length)
    if (contextLength !== undefined) option.contextLength = contextLength
    const uptimeLast30m = toOptionalNumber(e.uptime_last_30m)
    if (uptimeLast30m !== undefined) option.uptimeLast30m = uptimeLast30m

    out.push(option)
  }
  return out
}

/**
 * 剥掉模型 id 的变体后缀（":nitro" / ":floor" / ":free" 等）。
 * 注意 slug 里本身不含 ":"，故直接截断最后一个 ":" 之后的部分。
 */
export function baseModelSlug(modelId: string): string {
  if (typeof modelId !== 'string') return ''
  const id = modelId.trim()
  if (!id) return ''
  const i = id.lastIndexOf(':')
  return (i >= 0 ? id.slice(0, i) : id).trim()
}

/** 合法有限非负数字（含 0）→ number；NaN / Infinity / 负数 / 非数字 → undefined（脏值不写入） */
function toOptionalNumber(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return v
}
