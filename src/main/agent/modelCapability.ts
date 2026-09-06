/**
 * 模型能力判定 — 多模态（图片输入）支持
 *
 * 唯一判定入口（supportsImageInput），工具侧（filterTools）与消息侧（execute.ts）共用，
 * 保证两个维度判定同源。
 *
 * 判定优先级（委托 shared/modelParams.resolveModelModalities，spec §6）：
 *   ① 自定义 modelTypes（模型详情配置）→ 含 "image"/"multimodal" → true（权威）
 *   ② modelMetaRegistry（or-models.json 缓存）→ architecture.input_modalities 含 "image" → true
 *   ③ 元数据命中但明确不含 "image" → false（权威，不回退）
 *   ④ 元数据未命中 → 回退命名模式推断（shared 内置，与 helpers.VISION_MODEL_PATTERNS 一致）
 *   ⑤ 均不命中 → false
 */

import {modelMetaRegistry} from '../modelMetaRegistry'
import {resolveModelModalities} from '@shared/modelParams'
import type {ModelType} from '@shared/types'

/** per-modelId(+customTypes) 结果缓存（同一 turn 内多次判定一致；上限 100，防泄漏） */
const CAPACITY = 100
const resultCache = new Map<string, boolean>()

/**
 * 模型是否支持图片输入（多模态）
 * @param modelId 模型 ID（可空/空串 → false，不抛异常）
 * @param customTypes 模型自定义类型（ProviderModel.modelTypes，主循环透传 modelConfig.modelTypes）
 */
export function supportsImageInput(modelId: string, customTypes?: ModelType[]): boolean {
  if (!modelId) return false

  // 缓存键含 customTypes 签名：同一模型在有无自定义类型时结果可能不同
  const cacheKey = customTypes && customTypes.length > 0 ? `${modelId}::${[...customTypes].sort().join(',')}` : modelId
  const cached = resultCache.get(cacheKey)
  if (cached !== undefined) return cached

  const modalities = modelMetaRegistry.getInputModalities(modelId)
  const result = resolveModelModalities(customTypes, modalities, modelId).supportsImage

  // 记忆化（上限守卫）
  if (resultCache.size >= CAPACITY) resultCache.clear()
  resultCache.set(cacheKey, result)
  return result
}
