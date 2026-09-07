/**
 * 模型级参数统一优先级解析（纯函数，零 electron/node 依赖）
 *
 * 全应用唯一优先级入口（spec §6）：主进程运行时、用量 IPC、渲染端展示
 * 一律经此取值，消费 .value；来源敏感方（placeholder 样式、徽标）消费 .source。
 * 禁止在任何消费方复刻优先级逻辑。
 */
import type {ModelConfig, ModelType, ProviderModel} from './types/model'

export type ParamSource = 'custom' | 'openrouter' | 'settings' | 'fallback'

export interface ResolvedParam {
  value: number
  source: ParamSource
}

/** 上下文兜底（spec §6.2） */
export const DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000

type ModelParams = ModelConfig['modelParams']

/** 与 modelMaxContext.ts 现行默认一致 */
const DEFAULT_SETTINGS_TEMPERATURE = 0

function firstPositive(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return undefined
}

export function resolveModelParams(
  modelParams: ModelParams | undefined,
  settings: {model?: {defaultTemperature?: number; defaultMaxTokens?: number}} | undefined,
  modelMetaContextLength: number,
): {
  maxContextTokens: ResolvedParam
  temperature: ResolvedParam
  maxOutputTokens: ResolvedParam
} {
  // ── 上下文：自定义 → OpenRouter（>0 才算命中）→ 1M ──
  const customCtx = firstPositive(modelParams?.maxContextTokens)
  const orCtx = typeof modelMetaContextLength === 'number' && modelMetaContextLength > 0
    ? modelMetaContextLength : undefined
  const maxContextTokens: ResolvedParam = customCtx !== undefined
    ? {value: customCtx, source: 'custom'}
    : orCtx !== undefined
      ? {value: orCtx, source: 'openrouter'}
      : {value: DEFAULT_MAX_CONTEXT_TOKENS, source: 'fallback'}

  // ── 温度：自定义 → 系统设置（defaultTemperature 恒有定义，默认 0，无兜底层）──
  const temperature: ResolvedParam = typeof modelParams?.temperature === 'number'
    ? {value: modelParams.temperature, source: 'custom'}
    : {value: settings?.model?.defaultTemperature ?? DEFAULT_SETTINGS_TEMPERATURE, source: 'settings'}

  // ── 最大输出：自定义 → 系统设置（OpenRouter 无标准字段，无中间层）──
  const maxOutputTokens: ResolvedParam = typeof modelParams?.maxOutputTokens === 'number'
    ? {value: modelParams.maxOutputTokens, source: 'custom'}
    : {value: settings?.model?.defaultMaxTokens ?? 50_000, source: 'settings'}

  return {maxContextTokens, temperature, maxOutputTokens}
}

/**
 * 命名模式推断 — 原样照搬自 src/main/agent/loop/helpers.ts 的
 * VISION_MODEL_PATTERNS / isVisionModel()，保持行为完全一致。
 */
export const VISION_MODEL_PATTERNS: RegExp[] = [
  /^gpt-4[o.]|^gpt-4-turbo/i, // GPT-4 Omni / 4.5 / Turbo
  /^o\d+/i,                   // OpenAI o 系列推理模型
  /^claude-3/i,               // Claude 3 系列
  /^gemini-/i,                // Gemini 系列
  /llava|bakllava|moondream|gemma3|minicpm|cogvlm|internvl/i,
  /qwen.*vl|deepseek.*vl|glm-4v|step-1v|yi-vision/i,
  /-vision|-vl$|-vlm/i,       // 通用视觉后缀
]

function nameImpliesImage(modelName: string): boolean {
  return VISION_MODEL_PATTERNS.some(p => p.test(modelName.toLowerCase()))
}

export function resolveModelModalities(
  customTypes: ModelType[] | undefined,
  openrouterInputModalities: string[] | null,
  modelName: string,
): {supportsImage: boolean; source: ParamSource} {
  if (customTypes && customTypes.length > 0) {
    return {supportsImage: customTypes.includes('image') || customTypes.includes('multimodal'), source: 'custom'}
  }
  if (Array.isArray(openrouterInputModalities)) {
    return {supportsImage: openrouterInputModalities.includes('image'), source: 'openrouter'}
  }
  return {supportsImage: nameImpliesImage(modelName), source: 'fallback'}
}

export function hasCustomParams(
  m: Pick<ProviderModel, 'maxContextTokens' | 'temperature' | 'maxOutputTokens' | 'pricing' | 'modelTypes'>,
): boolean {
  const hasNum = m.maxContextTokens != null || m.temperature != null || m.maxOutputTokens != null
  const hasPrice = Object.values(m.pricing ?? {}).some(v => (v as number) > 0)
  const hasTypes = !!m.modelTypes && m.modelTypes.length > 0
  return hasNum || hasPrice || hasTypes
}
