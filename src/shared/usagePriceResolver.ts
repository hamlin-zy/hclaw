/**
 * 自定义定价归属解析（纯函数）
 * 降级链（设计 §三 C4）：(providerId, model) 精确 → providerName 首命中 → null（回退 OpenRouter）。
 * 注意：providerName 为用户可改显示名，重名/改名场景按 entries 输入顺序取首个确定性命中——
 * 已知局限，历史数据兜底语义，新数据以 providerId 为准。
 */
import type {ModelPricing} from './pricing'
import type {PriceSource} from './llmUsage'

export interface CustomPriceEntry {
  providerId?: string | null
  providerName?: string | null
  model: string
  pricing: ModelPricing
}

export function resolveCustomPrice(
  entries: CustomPriceEntry[],
  q: {model: string; providerId?: string | null; providerName?: string | null},
): ModelPricing | null {
  const norm = (s?: string | null) => (s ?? '').trim().toLowerCase()
  if (!q.model) return null
  const model = q.model.trim().toLowerCase()
  if (q.providerId) {
    const hit = entries.find(e => e.model.toLowerCase() === model && (e.providerId ?? '') === q.providerId)
    if (hit) return hit.pricing
  }
  if (norm(q.providerName)) {
    const name = norm(q.providerName)
    const hit = entries.find(e => e.model.toLowerCase() === model && norm(e.providerName) === name)
    if (hit) return hit.pricing
  }
  return null
}

export function pricingToPriceSource(p: ModelPricing): PriceSource {
  return {inputPrice: p.input ?? 0, outputPrice: p.output ?? 0, cacheReadPrice: p.cacheRead ?? 0, cacheWritePrice: p.cacheWrite ?? 0}
}
