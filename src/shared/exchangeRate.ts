/**
 * 汇率解析 + 校验（纯函数，零 electron 依赖）
 *
 * - parseExchangeRates：解析 currency-api usd.min.json 响应（{date, usd: {cny: ...}}）
 * - getRate：按小写货币代码取值；未命中 / 非法 → 0
 */

/** 兜底汇率：离线 / 首次启动未同步时使用（本地展示口径，非实时行情） */
export const DEFAULT_USD_CNY_RATE = 7.2

/** 汇率数据：date 为数据日期（YYYY-MM-DD）；rates 为 1 USD 兑各货币的汇率表（键为小写货币代码） */
export interface ExchangeRateData {
  date: string
  rates: Record<string, number>
}

/**
 * 解析 currency-api usd.min.json 响应。
 * 非法 JSON / 缺 date / 缺 usd 表 / 无 cny（无法换算）→ null；
 * rates 只保留合法正数条目，坏字段逐条跳过。
 */
export function parseExchangeRates(text: string): ExchangeRateData | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const {date, usd} = parsed as {date?: unknown; usd?: unknown}
  if (typeof date !== 'string' || date.length === 0) return null
  if (!usd || typeof usd !== 'object' || Array.isArray(usd)) return null

  const rates: Record<string, number> = {}
  for (const [code, value] of Object.entries(usd as Record<string, unknown>)) {
    const n = toRate(value)
    if (n > 0) rates[code] = n
  }
  if (rates.cny === undefined) return null // 必须包含 cny，否则无法换算
  return {date, rates}
}

/** 取值：1 USD 兑 code（小写）货币；未命中 / 非法 → 0 */
export function getRate(data: ExchangeRateData, code: string): number {
  const n = data.rates[code]
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 汇率字段转 number：非法值 / NaN / 非正数 → 0 */
function toRate(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return 0
}
