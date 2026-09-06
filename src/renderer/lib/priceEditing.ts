/**
 * 价格编辑纯逻辑（无 React 依赖）
 *
 * - 存储：USD/token（ModelPricing 4 维）+ entered 录入真相（币种 + 录入值快照）
 * - 展示（录入即真，WYSIWYG）：有 entered 的单元格逐字回显录入值（不乘不除，
 *   不随汇率漂移）；无 entered 的旧数据按 USD/token × 汇率折算（向后兼容）
 * - 落盘边界（§三 B5）：仅「用户编辑过」的单元格按其生效币种折算固化 USD/token，
 *   同时把录入值写入 entered.values；未编辑单元格原值透传（含 entered），
 *   防展示舍入回写漂移
 */
import {
  perMtoToken,
  tokenToPerM,
  type Currency,
  type ModelPricing,
} from '@shared/pricing'

/** 值字段（合成顺序固定） */
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
export type PriceField = (typeof FIELDS)[number]

/** 公用格式化：至多 8 位小数去尾零（'', '-' → '0'） */
export function formatPrice(v: number): string {
  const s = v.toFixed(8).replace(/\.?0+$/, '')
  return s === '' || s === '-' ? '0' : s
}

/** 展示串：USD/token → $/1M（CNY × rate）；空 = ''；至多 8 位小数去尾零 */
export function displayPrice(usdToken: number | undefined, cur: Currency, rate: number): string {
  if (usdToken === undefined || !Number.isFinite(usdToken)) return ''
  return formatPrice(tokenToPerM(usdToken) * (cur === 'CNY' ? rate : 1))
}

/**
 * 单元格回显（WYSIWYG）：有 entered 录入值 → 逐字格式化（不折算，任何汇率下不变）；
 * 无 entered（旧数据）→ 沿用 displayPrice 折算展示
 */
export function displayEnteredCell(
  pricing: ModelPricing | undefined,
  field: PriceField,
  cur: Currency,
  rate: number,
): string {
  const ev = pricing?.entered?.values?.[field]
  if (ev !== undefined) return formatPrice(ev)
  return displayPrice(pricing?.[field], cur, rate)
}

/**
 * ≈ 反向参考小字（录入币种 ↔ 另一币种，实时汇率互算）：
 * - 正在编辑（raw 非空）：按工具栏货币直接互算（避免 8 位舍入往返）
 * - 有 entered：录入值按其币种与另一币种互算（CNY→USD 除 rate，USD→CNY 乘 rate）
 * - 旧数据：USD/token 折算为另一币种展示
 * 返回另一币种下的数值串；无可参考值 → null
 */
export function reverseHintPrice(
  pricing: ModelPricing | undefined,
  field: PriceField,
  cur: Currency,
  rate: number,
  raw: string | undefined,
): {value: string; currency: Currency} | null {
  const other: Currency = cur === 'USD' ? 'CNY' : 'USD'
  if (raw !== undefined && raw.trim() !== '') {
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 0) {
      return {value: formatPrice(cur === 'CNY' ? v / rate : v * rate), currency: other}
    }
    return null
  }
  const ev = pricing?.entered?.values?.[field]
  if (ev !== undefined) {
    const from = pricing!.entered!.currency
    // 录入币种的另一侧
    const to: Currency = from === 'CNY' ? 'USD' : 'CNY'
    return {value: formatPrice(from === 'CNY' ? ev / rate : ev * rate), currency: to}
  }
  const usdToken = pricing?.[field]
  return usdToken !== undefined ? {value: displayPrice(usdToken, other, rate), currency: other} : null
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
export type PriceEdits = Record<string, Partial<Record<PriceField, string>>>

/**
 * 保存时合成一行 pricing（录入即真）：
 * - 有编辑的字段：一律按当前工具栏货币 cur 折算固化 USD/token（非法/空 → undefined =
 *   未配置），录入原值写入 entered.values。即「重录该格」：旧 entered 值不再影响解析
 *   币种，避免「UI 显示 B 币符号、实际按 A 币落盘」的错觉
 * - 无编辑的字段：USD/token 原值透传，entered 值透传（不折算，防漂移）
 * - 既有 entered 币种与 cur 冲突且有本轮编辑时，entered 整体重计价到 cur（一次性、确定，
 *   之后再次免漂移）；全空 → undefined
 */
export function commitRow(
  pricing: ModelPricing | undefined,
  edits: PriceEdits[string] | undefined,
  cur: Currency,
  rate: number,
): ModelPricing | undefined {
  const prev = pricing?.entered
  const prevCur = prev?.currency
  const result: ModelPricing = {}
  const enteredValues: Partial<Record<PriceField, number>> = {}
  let any = false
  let anyEntered = false

  // 预扫描：本轮是否有编辑字段（有 → 该行视为以 cur 重新录入，entered 归币种 cur）
  let newEntry = false
  if (edits) {
    for (const f of FIELDS) {
      if (f in edits) { newEntry = true; break }
    }
  }
  // 币种冲突（既有 entered 是另一币种 + 本轮有编辑）→ 整体重计价到 cur
  const outCur: Currency | undefined =
    prevCur !== undefined ? (newEntry && prevCur !== cur ? cur : prevCur)
      : newEntry ? cur : undefined

  /** 录入值换算到 outCur（币种一致原样；CNY→USD 除 rate，USD→CNY 乘 rate） */
  const toOut = (v: number, from: Currency | undefined): number => {
    if (from === undefined || from === outCur) return v
    return from === 'CNY' ? v / rate : v * rate
  }

  for (const f of FIELDS) {
    if (edits && f in edits) {
      const raw = edits[f] as string
      // 编辑串一律按当前工具栏货币解析（重录该格，不看旧 entered 币种）
      const parsed = parsePriceInput(raw, cur, rate)
      if (parsed !== undefined) {
        result[f] = parsed
        any = true
      }
      const t = raw.trim()
      const num = Number(t)
      if (t !== '' && Number.isFinite(num) && num >= 0) {
        enteredValues[f] = num
        anyEntered = true
      }
      // 空/非法输入：该字段视为未配置（USD/token 与录入值均丢弃）
    } else {
      const v = pricing?.[f]
      if (v !== undefined) {
        result[f] = v
        any = true
      }
      const ev = prev?.values?.[f]
      if (ev !== undefined) {
        enteredValues[f] = outCur !== undefined ? toOut(ev, prevCur) : ev
        anyEntered = true
      }
    }
  }
  if (!any && !anyEntered) return undefined
  if (outCur !== undefined && anyEntered) {
    result.entered = {currency: outCur, values: enteredValues}
  }
  return result
}
