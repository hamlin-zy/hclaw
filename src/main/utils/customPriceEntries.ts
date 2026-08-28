/**
 * 自定义定价 entries 组装（成本取价注入用）
 * providers × models → CustomPriceEntry[]（仅含已配置 pricing 的模型），
 * 供 queryAggregated / queryByConversation / attachCosts 做 provider-aware 取价。
 */
import {SqliteProviderModelRepository, SqliteProviderRepository} from '../repositories/sqlite/llmProviderRepository'
import type {CustomPriceEntry} from '@shared/usagePriceResolver'

export function buildCustomPriceEntries(): CustomPriceEntry[] {
    try {
        const providers = new SqliteProviderRepository().list()
        const modelRepo = new SqliteProviderModelRepository()
        const entries: CustomPriceEntry[] = []
        for (const p of providers) {
            for (const m of modelRepo.listByProviderId(p.id)) {
                if (!m.pricing) continue
                entries.push({providerId: p.id, providerName: p.name, model: m.modelName, pricing: m.pricing})
            }
        }
        return entries
    } catch (err) {
        console.error('[buildCustomPriceEntries] failed:', err)
        return []
    }
}
