/**
 * 模型详情弹窗 · 保存过滤纯函数（spec §2.2）
 *
 * 仅自定义值落库：留空 → undefined（非 0 非 NaN）；非法值抛错
 * （UI 侧「确定」前先经 validateModelDetailDraft 拦截）。
 * 价格落库不在本函数：沿用 commitRow 在弹窗「确定」时对 pricing 折算。
 */
import type {ProviderModel} from '@shared/types'

export interface ModelDetailDraft {
  maxContextTokens: string
  temperature: string
  maxOutputTokens: string
  modelTypes: string[]   // ModelType 字符串数组
}

function toInt(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`无效整数: ${v}`)
  return n
}

function toTemp(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error(`温度需在 0-2: ${v}`)
  // spec §9：不静默钳制 —— 超过 2 位小数直接报错（容差吸收浮点误差，如 0.12*100）
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) throw new Error(`温度最多 2 位小数: ${v}`)
  return n
}

/** spec §2.2：仅自定义值落库；留空 → undefined；非法值抛错（UI 侧先经 validate 拦截） */
export function commitModelDetail(
  model: ProviderModel,
  draft: ModelDetailDraft,
): ProviderModel {
  return {
    ...model,
    maxContextTokens: toInt(draft.maxContextTokens),
    temperature: toTemp(draft.temperature),
    maxOutputTokens: toInt(draft.maxOutputTokens),
    modelTypes: draft.modelTypes.length > 0 ? (draft.modelTypes as ProviderModel['modelTypes']) : undefined,
  }
}

/**
 * OR 预勾选转自定义（spec §2.2：placeholder 值永不落库）
 *
 * 组件侧：OR 命中的模型类型仅作虚线框「预展示」，不写入 draft.modelTypes。
 * 用户点击任意 chip 进入自定义编辑态时，以「当前已存值 ∪ OR 命中集」为起点再切换目标项。
 */
export function mergeOrTypesOnEdit(currentModelTypes: string[], orTypes: string[]): string[] {
  const set = new Set(currentModelTypes)
  for (const t of orTypes) set.add(t)
  return [...set]
}

/** 校验（「确定」门禁）：返回首个错误文案，null = 通过 */
export function validateModelDetailDraft(draft: ModelDetailDraft): string | null {
  try {
    toInt(draft.maxContextTokens); toInt(draft.maxOutputTokens); toTemp(draft.temperature)
    return null
  } catch (e) {
    return (e as Error).message
  }
}
