/**
 * 价格编辑纯逻辑（无 React 依赖）
 *
 * - 存储：USD/token（ModelPricing 4 维）
 * - 展示：$/1M（USD）或 ¥/1M（CNY × 汇率）
 * - 落盘边界（§三 B5）：仅「用户编辑过」的单元格按当前货币折算落盘；
 *   未编辑单元格原值透传，防展示舍入回写漂移。
 */
import {
  perMtoToken,
  tokenToPerM,
  type Currency,
  type ModelPricing,
} from '@shared/pricing'

/** 展示串：USD/token → $/1M（CNY × rate）；空 = ''；至多 8 位小数去尾零 */
export function displayPrice(usdToken: number | undefined, cur: Currency, rate: number): string {
  if (usdToken === undefined || !Number.isFinite(usdToken)) return ''
  const v = tokenToPerM(usdToken) * (cur === 'CNY' ? rate : 1)
  const s = v.toFixed(8).replace(/\.?0+$/, '')
  return s === '' || s === '-' ? '0' : s
}

/** 解析展示串 → USD/token（CNY ÷ rate 再 perMtoToken）；非法 / 空 / 负 → undefined */
export function parsePriceInput(display: string, cur: Currency, rate: number): number | undefined {
  const t = display.trim()
  if (!t) return undefined
  const v = Number(t)
  if (!Number.isFinite(v) || v < 0) return undefined
  return perMtoToken(cur === 'CNY' ? v / rate : v)
}

/** 行内编辑状态：rowId → 字段 → 用户原始输入串（仅存编辑过的单元格） */
export type PriceEdits = Record<string, Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', string>>>

/** 值字段（合成顺序固定） */
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
type PriceField = (typeof FIELDS)[number]

/**
 * 保存时合成一行 pricing：
 * - 有编辑的字段：parsePriceInput 按当前货币折算（非法 → undefined = 未配置）
 * - 无编辑的字段：原值透传（不折算，防漂移）
 * - 全空 → undefined
 */
export function commitRow(
  pricing: ModelPricing | undefined,
  edits: PriceEdits[string] | undefined,
  cur: Currency,
  rate: number,
): ModelPricing | undefined {
  const result: ModelPricing = {}
  let any = false
  for (const f of FIELDS) {
    if (edits && f in edits) {
      const parsed = parsePriceInput(edits[f] as string, cur, rate)
      if (parsed !== undefined) {
        result[f] = parsed
        any = true
      }
    } else {
      const v = pricing?.[f as PriceField]
      if (v !== undefined) {
        result[f] = v
        any = true
      }
    }
  }
  return any ? result : undefined
}
