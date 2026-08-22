/**
 * 模型能力判定 — 多模态（图片输入）支持
 *
 * 唯一判定入口（supportsImageInput），工具侧（filterTools）与消息侧（execute.ts）共用，
 * 保证两个维度判定同源。
 *
 * 判定优先级：
 *   ① modelMetaRegistry（or-models.json 缓存）→ architecture.input_modalities 含 "image" → true
 *   ② 元数据命中但明确不含 "image" → false（权威，不回退）
 *   ③ 元数据未命中（模型不在 OR 清单 / 无 architecture 字段）→ 回退 isVisionModel() 命名模式
 *   ④ 均不命中 → false
 */

import {modelMetaRegistry} from '../modelMetaRegistry'
import {isVisionModel} from './loop/helpers'

/** per-modelId 结果缓存（同一 turn 内多次判定一致；上限 100，防泄漏） */
const CAPACITY = 100
const resultCache = new Map<string, boolean>()

/**
 * 模型是否支持图片输入（多模态）
 * @param modelId 模型 ID（可空/空串 → false，不抛异常）
 */
export function supportsImageInput(modelId: string): boolean {
  if (!modelId) return false

  const cached = resultCache.get(modelId)
  if (cached !== undefined) return cached

  // ①/② OR 元数据（权威）
  const modalities = modelMetaRegistry.getInputModalities(modelId)
  let result: boolean
  if (modalities !== null) {
    result = modalities.some(m => m === 'image')
  } else {
    // ③ 回退命名模式
    result = isVisionModel(modelId)
  }

  // 记忆化（上限守卫）
  if (resultCache.size >= CAPACITY) resultCache.clear()
  resultCache.set(modelId, result)
  return result
}
