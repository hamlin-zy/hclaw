/**
 * 模型元数据解析 + 归一化匹配（纯函数，零 electron 依赖）
 *
 * - normalizeModelId：统一模型 ID 的大小写与分隔符，供匹配索引与查询键使用
 * - parseOpenRouterModels：解析 OpenRouter /api/v1/models 响应
 * - matchOpenRouterModel：把用户直连模型 ID 归一化匹配到 OpenRouter 条目
 */

/** 模型元数据（价格单位：美元/token；0 = 未知/未匹配） */
export interface ModelMeta {
  contextLength: number
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
}

/** OpenRouter /api/v1/models 原始条目（只提取需要的字段） */
export interface OpenRouterModelRaw {
  id: string
  name?: string
  context_length?: number
  canonical_slug?: string
  hugging_face_id?: string
  /** 模型架构信息（模态声明，OpenRouter 2026-08 起提供；缺失=旧数据，回退命名模式） */
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  pricing?: {
    prompt?: string | number
    completion?: string | number
    input_cache_read?: string | number
  }
  top_provider?: { context_length?: number }
}

/** trim + 小写 + 分隔符归一化（. - _ 统一删除；/ 保留，是 provider/model 分隔符） */
export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/[._-]/g, '')
}

/** 解析 OpenRouter /api/v1/models 响应；非法 JSON / data 缺失 / 非数组 → [] */
export function parseOpenRouterModels(text: string): OpenRouterModelRaw[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as {data?: unknown}).data)) {
    return []
  }
  const data = (parsed as {data: OpenRouterModelRaw[]}).data
  return data.filter(isOpenRouterModel)
}

/** 类型守卫：是否为有效的 OpenRouter 模型条目（id 为非空字符串） */
export function isOpenRouterModel(m: unknown): m is OpenRouterModelRaw {
  return !!m && typeof m === 'object'
    && typeof (m as OpenRouterModelRaw).id === 'string'
    && !!(m as OpenRouterModelRaw).id
}

/** 归一化匹配器：优先级 hf_id > canonical_slug > or.id 精确 > slug model 段精确 > 子串 */
export function matchOpenRouterModel(
  queryId: string,
  models: OpenRouterModelRaw[],
): OpenRouterModelRaw | null {
  const q = normalizeModelId(queryId)
  if (!q) return null

  // 1. hugging_face_id 精确
  for (const m of models) {
    if (typeof m.hugging_face_id === 'string' && normalizeModelId(m.hugging_face_id) === q) return m
  }
  // 2. canonical_slug 精确
  for (const m of models) {
    if (typeof m.canonical_slug === 'string' && normalizeModelId(m.canonical_slug) === q) return m
  }
  // 3. or.id 精确
  for (const m of models) {
    if (normalizeModelId(m.id) === q) return m
  }
  // 4. slug model 段精确（去掉第一个 / 前的 provider 前缀）
  for (const m of models) {
    const seg = m.id.split('/').slice(1).join('/')
    if (seg && normalizeModelId(seg) === q) return m
  }
  // 5. 子串匹配
  for (const m of models) {
    if (normalizeModelId(m.id).includes(q)) return m
  }
  return null
}
